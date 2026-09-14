/**
 * Whether a site's build chain runs a prefetch this CLI accepts, and then the guard.
 *
 * Step 5 asked whether the prebuild string contained `hexdocs prefetch`, `--site <site>` and
 * `check-docs.mjs` as substrings. Against the real hex-web that row passed over a fragment
 * the CLI refuses: `prefetch --root ../..` exits 2 with "Unknown option '--root'", because
 * `root` is a positional there, so every build would have failed in `prebuild` with the
 * wiring row green. The same substring test refused `--site=apps/front`, which the CLI
 * accepts, and accepted `... || true && node scripts/check-docs.mjs`, where a failed
 * prefetch no longer fails anything.
 *
 * So the segment is bound the way the CLI binds it, through the same `bind` and the same
 * schema, over `PREFETCH_PARAMS`, which lives in a module with no writer imports precisely so
 * this read-only check can use it. `kit/test/exec/no-write.test.ts` stays green only while
 * nothing here imports `commands/prefetch.ts`.
 *
 * What is not attempted is parsing shell. The script is split on the five control operators
 * outside quotes, and anything only a shell can read (an open quote, a command substitution,
 * a quote or a `$` inside the segment itself) is refused rather than guessed at. A refusal
 * here names what it could not read; a guess is how the substring test passed.
 */

import { z } from 'zod';

import { bind, UsageError } from '../cli/args.js';
import { bucketOf } from '../commands/common.js';
import { PREFETCH_PARAMS, PREFETCH_POSITIONALS } from '../commands/prefetch-params.js';
import type { AnyCommand } from '../registry/command.js';
import { shapeOf } from '../registry/params.js';

import { joinPosix, normaliseSitePath, resolveInside, type SiteDescriptor } from './site.js';

/**
 * Which scripts always run, and why only these two.
 *
 * npm and pnpm both fire `prebuild` before `build`, measured on npm 11 and pnpm 10, and
 * `hex-terraform/deploy/src/build.ts` runs `npm run build` on the deploy host before the
 * Docker build. `build` itself is the other always-run script and is kcalc's own idiom,
 * which inlines its pre-step as `node scripts/build-lastmod.mjs && react-router build`.
 * Anything else is a script somebody has to remember to type, which on a repository with
 * no CI is not a guard. The order is the order they run in, which the ordering rules below
 * depend on.
 */
export const ALWAYS_RUN = ['prebuild', 'build'] as const;

export type Separator = '&&' | '||' | ';' | '|' | '&';

export interface Segment {
	/** Trimmed, as written. */
	readonly text: string;
	/** Split on whitespace. Exact only for a segment with no quote in it, which is refused. */
	readonly tokens: readonly string[];
	readonly before: Separator | null;
	readonly after: Separator | null;
}

/**
 * A script string split on its control operators, or `null` where only a shell could.
 *
 * Quote aware, because `echo "a && b"` is one command. A backtick or a `$(` outside single
 * quotes is refused outright: a command substitution can hold a separator this split cannot
 * see, and a prefetch segment hidden inside one would be read as a top-level command that
 * runs. A `&` after `>` or `<`, or before `>`, is a redirection such as `2>&1` rather than a
 * background operator. A newline separates like `;`.
 */
export function splitScript(script: string): Segment[] | null {
	const raw: { text: string; before: Separator | null }[] = [];
	let current = '';
	let before: Separator | null = null;
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < script.length; i += 1) {
		const c = script[i] as string;
		const next = script[i + 1];

		if (quote === "'") {
			current += c;
			if (c === "'") quote = null;
			continue;
		}
		if (c === '\\') {
			current += c + (next ?? '');
			i += 1;
			continue;
		}
		if (c === '`' || (c === '$' && next === '(')) return null;
		if (quote === '"') {
			current += c;
			if (c === '"') quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			current += c;
			continue;
		}

		let separator: Separator | null = null;
		let width = 1;
		if (c === '&' && next === '&') {
			separator = '&&';
			width = 2;
		} else if (c === '|' && next === '|') {
			separator = '||';
			width = 2;
		} else if (c === ';' || c === '\n') {
			separator = ';';
		} else if (c === '|') {
			separator = '|';
		} else if (c === '&') {
			const previous = script[i - 1];
			if (previous !== '>' && previous !== '<' && next !== '>') separator = '&';
		}

		if (separator === null) {
			current += c;
			continue;
		}
		raw.push({ text: current.trim(), before });
		current = '';
		before = separator;
		i += width - 1;
	}
	if (quote !== null) return null;
	raw.push({ text: current.trim(), before });

	return raw.map((segment, index) => ({
		text: segment.text,
		tokens: segment.text.split(/\s+/).filter((token) => token !== ''),
		before: segment.before,
		after: raw[index + 1]?.before ?? null,
	}));
}

/** A token naming the launcher, by any path. */
const LAUNCHER_TOKEN = /(^|\/)hexdocs$/;

/** A token naming the guard shim, by any path. */
const GUARD_TOKEN = /(^|\/)check-docs\.mjs$/;

/**
 * Characters the shell rewrites before a command sees its argv.
 *
 * Refused inside the two guard segments rather than interpreted. `--bucket $HEXDOCS_BUCKET`
 * binds here as the literal string and reaches prefetch as whatever the variable held, so
 * accepting it would be accepting a value this check never saw; prefetch reads
 * `HEXDOCS_BUCKET` itself, so nothing needs the expansion.
 */
const SHELL_REWRITES = /["'\\$*?~{}()<>]/;

/**
 * The shape `bind` reads, and only that.
 *
 * `bind` takes an `AnyCommand` and reads its `name`, its `params` and its `positionals` and
 * nothing else, so the cast is to fields it never touches. The alternative, a binder of this
 * module's own over `parseArgs`, is a second definition of what the CLI accepts, which is
 * the disagreement this whole predicate exists to remove.
 */
const PREFETCH_BINDING = {
	name: 'prefetch',
	params: PREFETCH_PARAMS,
	positionals: PREFETCH_POSITIONALS,
} as const;

const PREFETCH_SCHEMA = z.object(shapeOf(PREFETCH_PARAMS));

interface Located {
	readonly script: (typeof ALWAYS_RUN)[number];
	/** Position in run order: earlier scripts first, then left to right. */
	readonly order: number;
	readonly index: number;
	readonly segment: Segment;
	readonly segments: readonly Segment[];
}

export interface PrebuildReading {
	/** How many always-run scripts exist as strings. */
	readonly scripts: number;
	/** Every problem, in the order they are worth fixing. Empty exactly when the chain is wired. */
	readonly problems: readonly string[];
	/** Every segment that runs the launcher, as written. */
	readonly launcherSegments: readonly string[];
	/** Every segment that names the guard shim, as written. */
	readonly guardSegments: readonly string[];
}

function quoted(text: string): string {
	return `\`${text}\``;
}

/**
 * Separator problems for a segment whose failure has to fail the build.
 *
 * Not only the separator beside it. `hexdocs prefetch ... && node check.mjs || true` fails
 * nothing when prefetch fails, because `&&` and `||` are equal precedence and associate left,
 * and the `||` that masks it is two segments away. So every separator from the segment to the
 * end of its script must be `&&`. Before it, only `||` matters: `a || prefetch` runs prefetch
 * only when `a` failed, where `a; prefetch` and `a && prefetch` both run it when the build
 * would have continued anyway.
 */
function maskingProblems(located: Located): string[] {
	const problems: string[] = [];
	const text = quoted(located.segment.text);
	if (located.segment.before === '||') {
		problems.push(`${text} follows \`||\`, so it runs only when the command before it fails.`);
	}
	const later = located.segments
		.slice(located.index)
		.map((segment) => segment.after)
		.find((separator) => separator !== null && separator !== '&&');
	if (later !== undefined && later !== null) {
		problems.push(
			`${text} is followed in \`${located.script}\` by \`${later}\`, so when it fails the build can still succeed.`,
		);
	}
	return problems;
}

function prefetchProblems(located: Located, site: SiteDescriptor): string[] {
	const segment = located.segment;
	const text = quoted(segment.text);
	if (SHELL_REWRITES.test(segment.text)) {
		return [
			`${text} holds a character the shell rewrites before hexdocs reads it, so this check cannot know what prefetch will be given.`,
		];
	}

	const [launcher = '', command, ...rest] = segment.tokens;
	const expected = joinPosix(site.mount, 'kit/bin/hexdocs');
	const problems: string[] = [];
	if (resolveInside(site.site, launcher) !== expected) {
		problems.push(
			`${text} runs \`${launcher}\`, which is not this mount's launcher at \`${expected}\`.`,
		);
	}
	if (command !== 'prefetch') {
		return [
			...problems,
			`${text} runs \`hexdocs ${command ?? ''}\` rather than \`hexdocs prefetch\`.`,
		];
	}

	let bound: unknown;
	try {
		bound = bind(PREFETCH_BINDING as unknown as AnyCommand, rest);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		return [...problems, `${text} is refused by the CLI before it runs: ${error.message}`];
	}
	const parsed = PREFETCH_SCHEMA.safeParse(bound);
	if (!parsed.success) {
		const issues = parsed.error.issues.map(
			(issue) => `${issue.path.join('.') || '(arguments)'}: ${issue.message}`,
		);
		return [...problems, `${text} is refused by the CLI's argument schema: ${issues.join('; ')}.`];
	}
	const value = parsed.data as { root: string; site: string; bucket?: string };

	const root = resolveInside(site.site, value.root);
	if (root !== '') {
		problems.push(
			root === null
				? `${text} names \`${value.root}\` as the repository root, which from \`${site.site}\` is outside the repository.`
				: `${text} names \`${value.root}\` as the repository root, which from \`${site.site}\` is \`${root}\` rather than the root.`,
		);
	}
	if (normaliseSitePath(value.site) !== site.site) {
		problems.push(`${text} names \`--site ${value.site}\`, and this site is \`${site.site}\`.`);
	}
	if (value.bucket !== undefined) {
		const bucket = bucketOf(value.bucket);
		if ('why' in bucket) problems.push(`${text} names a bucket prefetch refuses: ${bucket.why}`);
	}
	return [...problems, ...maskingProblems(located)];
}

function guardProblems(located: Located, site: SiteDescriptor): string[] {
	const segment = located.segment;
	const text = quoted(segment.text);
	const expected = joinPosix(site.site, 'scripts/check-docs.mjs');
	const [runner, script, ...rest] = segment.tokens;
	if (
		SHELL_REWRITES.test(segment.text) ||
		runner !== 'node' ||
		rest.length > 0 ||
		resolveInside(site.site, script ?? '') !== expected
	) {
		return [`${text} is not \`node scripts/check-docs.mjs\` run from \`${site.site}\`.`];
	}
	return maskingProblems(located);
}

/**
 * Reads the always-run scripts of a site's `package.json`.
 *
 * Every segment that names the launcher has to pass, not just one: a step-5 fragment left in
 * place ahead of a correct one still exits 2 and stops the build before the correct one runs.
 */
export function readPrebuild(
	scripts: Readonly<Record<string, unknown>>,
	site: SiteDescriptor,
): PrebuildReading {
	const problems: string[] = [];
	const launchers: Located[] = [];
	const guards: Located[] = [];
	const builds: Located[] = [];
	let present = 0;

	ALWAYS_RUN.forEach((name, scriptIndex) => {
		const value = scripts[name];
		if (typeof value !== 'string') return;
		present += 1;
		const segments = splitScript(value);
		if (segments === null) {
			// Only worth a problem when the string names the guard at all. An unrelated script
			// with a command substitution in it is not this check's business.
			if (/hexdocs|check-docs\.mjs/.test(value)) {
				problems.push(
					`\`${name}\` holds an open quote or a command substitution, so this check cannot split it the way the shell will.`,
				);
			}
			return;
		}
		segments.forEach((segment, index) => {
			const located: Located = {
				script: name,
				order: scriptIndex * 10_000 + index,
				index,
				segment,
				segments,
			};
			if (segment.tokens.some((token) => LAUNCHER_TOKEN.test(token))) launchers.push(located);
			else if (segment.tokens.some((token) => GUARD_TOKEN.test(token))) guards.push(located);
			else if (segment.tokens[0] === 'react-router' && segment.tokens[1] === 'build') {
				builds.push(located);
			}
		});
	});

	if (launchers.length === 0) {
		problems.push(`Nothing in \`${site.site}\`'s build chain runs \`hexdocs prefetch\`.`);
	}
	for (const located of launchers) {
		problems.push(...prefetchProblems(located, site));
		// `react-router build` compiles the globs over the prefetched trees, so a prefetch
		// after it in the same script is a build that shipped the previous bundles, or none.
		const build = builds.find(
			(candidate) => candidate.script === located.script && candidate.order < located.order,
		);
		if (build !== undefined) {
			problems.push(
				`${quoted(located.segment.text)} runs after \`${build.segment.text}\`, which compiles the bundles before they are on disk.`,
			);
		}
	}

	if (guards.length === 0) {
		problems.push(
			`Nothing in \`${site.site}\`'s build chain runs \`node scripts/check-docs.mjs\`.`,
		);
	}
	for (const located of guards) problems.push(...guardProblems(located, site));

	// The guard after the prefetch, which is the order `install` writes. Required rather than
	// merely produced so that the guard's report is the last thing printed before the build:
	// a guard ahead of the prefetch can print all clear and the build then stop on a prefetch
	// row, which reads as the guard having missed something it was never asked about.
	const lastLauncher = Math.max(...launchers.map((located) => located.order));
	if (
		launchers.length > 0 &&
		guards.length > 0 &&
		!guards.some((located) => located.order > lastLauncher)
	) {
		problems.push(
			'`node scripts/check-docs.mjs` runs before `hexdocs prefetch` rather than after it.',
		);
	}

	return {
		scripts: present,
		problems,
		launcherSegments: launchers.map((located) => located.segment.text),
		guardSegments: guards.map((located) => located.segment.text),
	};
}

/**
 * The `prebuild` fragment `install` writes. One spelling, so the predicate and the applier agree.
 *
 * `root` is positional, because that is how `prefetch` declares it: the step-5 fragment passed
 * `--root` and the CLI refused it. `--bucket` is written only when `install` was given one,
 * and then only into a fragment `install` creates. The bucket name stays in the consumer's
 * private `package.json`, which no bundler reads, rather than in a site config an eager glob
 * would inline into every page's JavaScript.
 */
export function prebuildFragment(site: SiteDescriptor, bucket?: string): string {
	return (
		`${site.mountFromSite}/kit/bin/hexdocs prefetch ${site.repoFromSite} --site ${site.site}` +
		(bucket === undefined ? '' : ` --bucket ${bucket}`) +
		' && node scripts/check-docs.mjs'
	);
}
