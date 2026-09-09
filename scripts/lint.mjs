#!/usr/bin/env node
/**
 * The house lint, applied to this repository's own source.
 *
 * hex-docs lints other people's documentation for a living, and the first thing that
 * would discredit it is shipping an em dash in a finding message. Everything this
 * package emits goes through here: contract comments, diagnostic strings, UI strings,
 * skills, markdown.
 *
 * The rules are not restated here. They are read from `kit/schema/house-rules.json`,
 * which is generated from `src/contracts/lint.ts`, so this guard and the rule pack a
 * consuming repository imports cannot disagree about what an em dash is. That was the
 * whole point of exporting the pack as data.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { check, notRun, render, skipped } from './lib/report.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RULES_RELATIVE = 'kit/schema/house-rules.json';
const PLANTED_RELATIVE = 'fixtures/planted.json';

// `.sh` joined this list in step 5, and the gap it closed is worth naming: the two
// launchers are shipped content full of comment paragraphs, and until they existed no
// shell file did, so nothing scanned one for a banned character or an attribution
// trailer. A repository whose stated position is that there are no exemptions had an
// unscanned file type rather than an exemption, which is the same hole with no name on
// it.
const SCANNED_EXTENSIONS = [
	'.ts',
	'.tsx',
	'.mjs',
	'.js',
	'.md',
	'.json',
	'.yml',
	'.yaml',
	'.css',
	'.sh',
	// `.tf` and `.hcl` joined in step 6, and the reason is the account-identifier row below
	// rather than the banned characters. `infra/` is the one place in a public repository
	// where an account id, a bucket name or a role ARN is plausible, and until these two
	// extensions were listed the whole directory contributed nothing to any row. The
	// existing optional-root check would have caught that as zero files, which is how the
	// gap was going to be found; naming the extensions is how it is closed.
	'.tf',
	'.hcl',
];

/**
 * Roots that must exist and must contain something.
 *
 * `kit` rather than `kit/src`, so a stray file at the toolchain's root is scanned too:
 * a scratch file left at `kit/` was outside both the narrower list and
 * `kit/tsconfig.json`'s `include`, so neither saw it.
 *
 * Each is counted separately. A single total across six roots hides the case this
 * check exists for, which is one root being renamed or moved: the count stays large,
 * the summary stays green, and a whole directory stops being linted.
 *
 * Counting per root is not on its own enough, and this list used to be the only
 * statement of what gets linted. Deleting `.github` from it left the run at exit 0 with
 * every row green, the file count quietly one lower, and the workflow that publishes
 * bundles no longer scanned for attribution or banned characters. So the list is
 * cross-checked against the directories actually on disk below: an entry removed from
 * here is a directory nothing lints, and that is now a failure rather than a smaller
 * number.
 */
export const REQUIRED_DIRS = ['src', 'kit', 'scripts', 'test', '.github', 'fixtures', '.claude'];

/** Roots a later step creates. Absent is fine; present and empty is not. */
const OPTIONAL_DIRS = {
	infra: 'the terraform stack, step 6 of the plan',
};

/**
 * Directories the walk never descends into, and therefore the only top-level names
 * allowed to be in neither list above. Shared with `walk` so the two cannot disagree,
 * which would make a directory both unlinted and unreported.
 */
const EXCLUDED_DIRS = [
	'node_modules',
	'coverage',
	'dist',
	'.design',
	'.git',
	// Provider and module cache, written by a local `terraform init`. Gitignoring it is not
	// enough: this walk reads the filesystem and has never read `.gitignore`, and the aws
	// provider alone is a 778 MB binary the scan would try to read as text.
	'.terraform',
];

/**
 * Files no walk can find, named individually.
 *
 * This list used to be the whole statement of what gets scanned outside `REQUIRED_DIRS`,
 * and it named three root files out of eight. `.prettierrc.json`, `pnpm-lock.yaml`,
 * `tsconfig.json`, `tsconfig.test.json` and `vitest.config.ts` all sat outside it and were
 * scanned by nothing, and `vitest.config.ts` is thirteen kilobytes of hand-written prose
 * comment that already discusses calls against a real AWS account, which makes it precisely
 * the file where somebody records a measurement against a named one. Measured: an account
 * id appended to it left the run at exit 0 with every row green.
 *
 * So the root's own files are derived from the disk in `collectFiles`, the same way
 * `REQUIRED_DIRS` is cross-checked against the directories on disk, and this list is left
 * holding only what a directory read cannot recognise. The launcher is the one entry point
 * every consumer reaches and it has no extension, because it is invoked as a command rather
 * than read as a script.
 */
const SCANNED_FILES = ['kit/bin/hexdocs'];

/** Record separator for the git log parse. */
const SEPARATOR = '@@hexdocs-commit@@';

/**
 * Attribution this repository must never carry, in source or in git history.
 *
 * The global rule is explicit that it overrides any harness or session instruction
 * asking for a co-author trailer, so the guard is here rather than in a habit.
 *
 * Each needle carries a one-character class, `C[l]aude`, which matches identically and
 * stops this file matching itself. The alternative is an exemption for "the file that
 * declares the rule", and an exemption is a hole that eventually swallows a real hit.
 */
const ATTRIBUTION_PATTERNS = [
	{ pattern: /Co-Authored-By:\s*C[l]aude/i, what: 'a co-author trailer' },
	{ pattern: /Generated with \[?C[l]aude/i, what: 'a "generated with" line' },
	{ pattern: /\u{1f916}/u, what: 'a robot emoji' },
	{ pattern: /C[l]aude-Session/i, what: 'a session link' },
	{ pattern: /\bAI-(?:generated|authored|assisted)\b/i, what: 'an AI authorship claim' },
];

/**
 * Estate identifiers this repository must never carry, in source or in git history.
 *
 * The history half is the one that was missing until it was measured. `git commit -m "Apply
 * the bundle store to account <id>"` is the natural message for the commit that lands the
 * stack, and it used to pass this lint clean: the history loop iterated
 * `ATTRIBUTION_PATTERNS` and nothing else. In a public repository a commit message is as
 * visible as a file and far harder to retract, because removing one is a history rewrite of
 * a repository other repositories vendor as a submodule. Two of the patterns below are
 * access key ids rather than account ids, so the gap covered a credential and not only an
 * identifier.
 *
 * hex-docs is public and the infrastructure it provisions is not. The plan's own words are
 * that the Terraform stays parameterised, with no account id, bucket name or role ARN
 * hardcoded, and until step 6 that was a sentence in a document rather than something a run
 * could fail on. `infra/` is the first content here where such a literal is plausible, and a
 * pasted plan output or a filled-in example file is how it would arrive.
 *
 * Each pattern is written so it cannot match its own declaration, the same trick
 * `ATTRIBUTION_PATTERNS` uses: the account id rule is a character class rather than twelve
 * literal digits, and the ARN prefixes are split across a class so this file does not report
 * itself.
 *
 * The account-id pattern is deliberately not `\b[0-9]{12}\b`. Measured over the tree it
 * scans: the plain word-boundary form matched nine times inside the sha256 digests in
 * `kit/test/golden/manifest.json`, because a boundary sits between a letter and a digit. The
 * lookarounds below refuse a hex neighbour on either side and produce zero matches across the
 * whole repository, while still catching `arn:aws:iam::<id>:role/x`, `account <id> is ours`
 * and `BUCKET=<id>-docs`.
 *
 * A bucket name and a deploy host alias cannot be recognised generically, so they are not
 * here. What covers them is that no committed file has a reason to hold one: the stack takes
 * them as variables with no default, and `infra/README.md` carries placeholders rather than
 * an example tfvars.
 */
const IDENTIFIER_PATTERNS = [
	{
		pattern: /(?<![0-9A-Fa-f])[0-9]{12}(?![0-9A-Fa-f])/,
		what: 'a twelve digit run, which is the shape of an AWS account id',
	},
	{ pattern: /arn:aw[s]:iam::[0-9]/, what: 'an IAM ARN carrying an account id' },
	{ pattern: /arn:aw[s]:sts::[0-9]/, what: 'an STS ARN carrying an account id' },
	{ pattern: /AKIA[0-9A-Z]{16}/, what: 'an AWS access key id' },
	{ pattern: /ASIA[0-9A-Z]{16}/, what: 'an AWS temporary access key id' },
];

/**
 * Characters the fixture corpus is allowed to carry, and the declaration that allows
 * them.
 *
 * The corpus has to contain an em dash, a rightwards arrow and two banned emoji, because
 * those are the things the compiler's own rules exist to catch and the things the status
 * node exists to recognise. Skipping `fixtures/` would take a whole root out of this
 * guard to get them past it, which is the shape of exemption this repository refuses
 * everywhere else.
 *
 * So nothing is skipped. Every occurrence is checked against a declaration naming the
 * file, the code point and the reason, and the check runs in both directions: an
 * undeclared hit fails, and a declared pair that is no longer present fails too. The
 * second half is the one that matters. A planted character quietly deleted leaves the
 * rule it was the only coverage for untested, with every row still green.
 *
 * The file is read defensively rather than trusted. A truncated JSON file, an absent
 * `groups` key or a `files` given as a string each used to throw straight out of `run`,
 * so the process died with a node stack trace and the whole report was lost: banned
 * characters, attribution in source and attribution in history all went unreported. The
 * missing-file case was already handled with `notRun`, which is what made the untreated
 * malformed case read as an oversight rather than a decision.
 *
 * @param {string} root
 * @returns {{ allowed: Map<string, Set<number>>, pairs: {file: string, point: number, group: string}[], problems: string[], loaded: boolean, reason: string }}
 */
function loadPlanted(root) {
	/** @type {Map<string, Set<number>>} */
	const allowed = new Map();
	/** @type {{file: string, point: number, group: string}[]} */
	const pairs = [];
	/** @type {string[]} */
	const problems = [];

	const path = join(root, PLANTED_RELATIVE);
	if (!existsSync(path)) {
		return {
			allowed,
			pairs,
			problems,
			loaded: false,
			reason: `${PLANTED_RELATIVE} is missing, so every character the corpus carries on purpose has just been reported as a violation.`,
		};
	}

	/** @type {{groups: {id: string, kind: string, rule: string, codePoints: string[], files: string[], why: string}[]}} */
	let declared;
	try {
		declared = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		return {
			allowed,
			pairs,
			problems,
			loaded: false,
			reason: `${PLANTED_RELATIVE} could not be read: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!Array.isArray(declared?.groups)) {
		return {
			allowed,
			pairs,
			problems,
			loaded: false,
			reason: `${PLANTED_RELATIVE} has no "groups" array. Nothing can be exempted until it does.`,
		};
	}

	for (const group of declared.groups) {
		if (!Array.isArray(group?.files) || !Array.isArray(group?.codePoints)) {
			problems.push(
				`${PLANTED_RELATIVE}: group "${group?.id ?? '(unnamed)'}" needs both "files" and "codePoints" as arrays. A string here iterates its characters and reports one nonsense problem per letter.`,
			);
			continue;
		}
		if (typeof group.why !== 'string' || group.why.length < 40) {
			problems.push(
				`${PLANTED_RELATIVE}: group "${group.id}" has no real reason. A declaration without one is an exemption nobody decided on.`,
			);
		}
		for (const file of group.files) {
			// The declaration must never be able to reach real source. Without this the
			// corpus becomes a way to exempt anything, which is the hole the whole
			// no-exemptions rule exists to close.
			if (!file.startsWith('fixtures/')) {
				problems.push(
					`${PLANTED_RELATIVE}: group "${group.id}" declares ${file}, which is outside fixtures/. This mechanism may only exempt the corpus.`,
				);
				continue;
			}
			if (!existsSync(join(root, file))) {
				problems.push(
					`${PLANTED_RELATIVE}: group "${group.id}" declares ${file}, which does not exist. Either the file moved or the declaration is stale, and either way nothing is being exempted.`,
				);
				continue;
			}
			const points = allowed.get(file) ?? new Set();
			for (const spelling of group.codePoints) {
				const match = /^U\+([0-9A-F]{4,6})$/.exec(spelling);
				if (match === null) {
					problems.push(
						`${PLANTED_RELATIVE}: "${spelling}" is not a code point. Write U+XXXX in upper case hex, so this file never contains the character it declares.`,
					);
					continue;
				}
				const point = Number.parseInt(match[1], 16);
				points.add(point);
				pairs.push({ file, point, group: group.id });
			}
			allowed.set(file, points);
		}
	}

	return { allowed, pairs, problems, loaded: true, reason: '' };
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
	/** @type {string[]} */
	const found = [];
	/** @type {string[]} */
	const queue = [dir];

	while (queue.length > 0) {
		const current = /** @type {string} */ (queue.pop());
		/** @type {import('node:fs').Dirent[]} */
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (EXCLUDED_DIRS.includes(entry.name)) continue;
				queue.push(full);
			} else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
				found.push(full);
			}
		}
	}

	return found.sort();
}

/**
 * Files to scan, and how many came from each root.
 *
 * @param {string} root
 * @returns {{ files: string[], perRoot: Record<string, number>, problems: string[] }}
 */
function collectFiles(root) {
	/** @type {string[]} */
	const files = [];
	/** @type {Record<string, number>} */
	const perRoot = {};
	/** @type {string[]} */
	const problems = [];

	for (const dir of REQUIRED_DIRS) {
		const found = walk(join(root, dir));
		perRoot[dir] = found.length;
		files.push(...found);
		if (found.length === 0) {
			problems.push(
				`${dir}/ contributed no files. It is a required root, so either it moved and REQUIRED_DIRS is stale, or the extension list stopped matching. Either way a whole directory is no longer linted.`,
			);
		}
	}

	for (const [dir, owner] of Object.entries(OPTIONAL_DIRS)) {
		if (!existsSync(join(root, dir))) continue;
		const found = walk(join(root, dir));
		perRoot[dir] = found.length;
		files.push(...found);
		if (found.length === 0) {
			problems.push(`${dir}/ exists but contributed no files (${owner}).`);
		}
	}

	// The list-against-disk cross-check. Without it REQUIRED_DIRS is the only statement
	// of what gets linted, and a name deleted from it takes a whole directory out of the
	// run with nothing to show for it but a smaller count.
	/** @type {import('node:fs').Dirent[]} */
	let topLevel = [];
	try {
		topLevel = readdirSync(root, { withFileTypes: true });
	} catch {
		problems.push(`${root} could not be read, so the root list could not be cross-checked.`);
	}
	for (const entry of topLevel) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		if (EXCLUDED_DIRS.includes(entry.name)) continue;
		// `Object.hasOwn`, not `in`. A directory named `toString` or `constructor` is legal on
		// every filesystem here, and `in` walks the prototype chain, so either one would read as
		// declared and go unlinted with every row green.
		if (REQUIRED_DIRS.includes(entry.name) || Object.hasOwn(OPTIONAL_DIRS, entry.name)) continue;
		problems.push(
			`${entry.name}/ is on disk but is in neither REQUIRED_DIRS nor OPTIONAL_DIRS nor EXCLUDED_DIRS, so nothing lints it. Add it to one of the three, saying which and why.`,
		);
	}

	// The root's own files, derived from the same read the cross-check above uses rather than
	// from a list. A file at the top level belongs to no root in `REQUIRED_DIRS`, so before
	// this loop existed the only ones scanned were the three `SCANNED_FILES` happened to name
	// and five with scannable extensions were read by nothing at all.
	/** @type {Set<string>} */
	const rootFiles = new Set();
	for (const entry of topLevel) {
		if (!entry.isFile() || entry.isSymbolicLink()) continue;
		if (!SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
		rootFiles.add(join(root, entry.name));
	}
	for (const name of SCANNED_FILES) {
		const path = join(root, name);
		if (existsSync(path)) rootFiles.add(path);
	}
	files.push(...rootFiles);
	perRoot['(root files)'] = rootFiles.size;

	return { files: [...new Set(files)].sort(), perRoot, problems };
}

/** @param {string} path */
function lines(path) {
	return readFileSync(path, 'utf8').split('\n');
}

/**
 * @param {string} [root] The tree to lint. Parameterised so the suite can point it at
 *   a fixture that really does contain an em dash, rather than trusting that the
 *   failure path works.
 * @returns {import('./lib/report.mjs').CheckResult[]}
 */
export function run(root = ROOT) {
	/** @type {import('./lib/report.mjs').CheckResult[]} */
	const results = [];
	const rulesPath = join(root, RULES_RELATIVE);

	if (!existsSync(rulesPath)) {
		return [
			notRun(
				'house rule pack',
				'rules',
				`${relative(root, rulesPath)} is missing. Run \`pnpm --dir kit schemas\` to generate it.`,
			),
			notRun('banned characters', 'files', 'The rule pack did not load.'),
			notRun('no AI attribution in source', 'files', 'The rule pack did not load.'),
			notRun('no AI attribution in git history', 'commits', 'The rule pack did not load.'),
		];
	}

	const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
	const banned = new Map(
		rules.bannedCharacters.map((/** @type {{codePoint: number, name: string}} */ entry) => [
			String.fromCodePoint(entry.codePoint),
			entry.name,
		]),
	);

	results.push(
		check('house rule pack', banned.size, 'banned characters', [], {
			note: `loaded from ${relative(root, rulesPath)}`,
		}),
	);

	const { files, perRoot, problems: rootProblems } = collectFiles(root);
	const perRootNote = Object.entries(perRoot)
		.map(([dir, count]) => `${dir} ${count}`)
		.join(', ');

	results.push(
		check('every root contributes files', Object.keys(perRoot).length, 'roots', rootProblems, {
			note: perRootNote,
		}),
	);

	// ---- banned characters -------------------------------------------------
	const planted = loadPlanted(root);
	/** @type {Set<string>} */
	const plantedSeen = new Set();

	/** @type {string[]} */
	const characterProblems = [];
	for (const file of files) {
		const where = relative(root, file);
		const exempt = planted.allowed.get(where);
		lines(file).forEach((line, index) => {
			for (const [character, name] of banned) {
				// Every occurrence, not just the first. `indexOf` alone meant a numeric
				// range early in a line exempted the whole line, so
				// `2019-2024; // the API - as documented - changed` reported nothing and
				// two real prose dashes shipped.
				for (
					let column = line.indexOf(character);
					column !== -1;
					column = line.indexOf(character, column + 1)
				) {
					// A digit on both sides is a numeric range, which is the one place an
					// en dash is correct. Rewriting a year range is not an improvement.
					if (
						name === 'en dash' &&
						/[0-9]/.test(line[column - 1] ?? '') &&
						/[0-9]/.test(line[column + 1] ?? '')
					) {
						continue;
					}
					// Declared in `fixtures/planted.json`, with a file, a code point and a
					// reason. Recorded rather than merely skipped, so the run can also fail
					// on a declaration whose character has gone.
					const point = character.codePointAt(0);
					if (exempt !== undefined && point !== undefined && exempt.has(point)) {
						plantedSeen.add(`${where}\u0000${point}`);
						continue;
					}
					characterProblems.push(
						`${where}:${index + 1}:${column + 1} contains ${name} (U+${character
							.codePointAt(0)
							?.toString(16)
							.toUpperCase()
							.padStart(4, '0')}). ${line.trim().slice(0, 90)}`,
					);
				}
			}
		});
	}
	results.push(check('banned characters', files.length, 'files', characterProblems));

	// ---- the planted declarations, in the other direction ------------------
	if (!planted.loaded) {
		results.push(notRun('planted fixture characters', 'declarations', planted.reason));
	} else {
		/** @type {string[]} */
		const plantedProblems = [...planted.problems];
		for (const pair of planted.pairs) {
			if (plantedSeen.has(`${pair.file}\u0000${pair.point}`)) continue;
			plantedProblems.push(
				`${pair.file} declares U+${pair.point.toString(16).toUpperCase().padStart(4, '0')} (group "${pair.group}") and does not contain it. A planted character that has gone leaves the rule it was the only coverage for untested, with every row still green.`,
			);
		}
		results.push(
			check('planted fixture characters', planted.pairs.length, 'declarations', plantedProblems, {
				note: `declared in ${PLANTED_RELATIVE}`,
			}),
		);
	}

	// ---- AI attribution in source ------------------------------------------
	/** @type {string[]} */
	const sourceAttribution = [];
	for (const file of files) {
		const where = relative(root, file);
		lines(file).forEach((line, index) => {
			for (const { pattern, what } of ATTRIBUTION_PATTERNS) {
				if (pattern.test(line)) sourceAttribution.push(`${where}:${index + 1} contains ${what}.`);
			}
		});
	}
	results.push(check('no AI attribution in source', files.length, 'files', sourceAttribution));

	// ---- estate identifiers -------------------------------------------------
	/** @type {string[]} */
	const identifiers = [];
	for (const file of files) {
		const where = relative(root, file);
		lines(file).forEach((line, index) => {
			for (const { pattern, what } of IDENTIFIER_PATTERNS) {
				const found = pattern.exec(line);
				if (found === null) continue;
				// The match itself is never printed. A guard that reports a leaked account id
				// by quoting it has put the value in a CI log, which is one of the places it
				// was not supposed to reach.
				identifiers.push(
					`${where}:${index + 1}:${found.index + 1} contains ${what}. This repository is public and the infrastructure it provisions is not.`,
				);
			}
		});
	}
	results.push(check('no estate identifiers in source', files.length, 'files', identifiers));

	// ---- git history, read twice ---------------------------------------------
	//
	// Two rows, not one list. `historyAttribution` feeds a row named "no AI attribution in
	// git history", and an account id reported under that name is a mislabelled report,
	// which this repository treats as worse than no report at all. So the identifier
	// patterns get a row of their own, and every early return below has to push both of
	// them: a shallow clone that dropped one would shrink `render`'s "n/n checks ran"
	// footer silently, which is the counting failure the four-state report exists to
	// refuse.
	let log = '';
	let commits = 0;

	const hasCommits = (() => {
		try {
			execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
				cwd: root,
				stdio: ['ignore', 'ignore', 'ignore'],
			});
			return true;
		} catch {
			return false;
		}
	})();

	const isShallow = (() => {
		try {
			return (
				execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
					cwd: root,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'ignore'],
				}).trim() === 'true'
			);
		} catch {
			return false;
		}
	})();

	if (isShallow) {
		// `actions/checkout` defaults to fetch-depth 1, so this would examine one commit
		// and report a pass having seen almost no history. The workflow sets
		// fetch-depth: 0, which the compiler needs anyway for git timestamps; saying so
		// here is what makes a regression in that setting visible.
		const why = 'Shallow clone: only the tip is present. Set fetch-depth: 0 on the checkout.';
		results.push(notRun('no AI attribution in git history', 'commits', why));
		results.push(notRun('no estate identifiers in git history', 'commits', why));
		return results;
	}

	if (!hasCommits) {
		// SKIPPED rather than NOT RUN. A repository with no commits is a real, explained
		// state nobody can act on, and NOT RUN now fails the run. The two branches below
		// are different: a `git log` that fails, and a missing rule pack, are both things
		// somebody has to fix.
		const why = 'No commits yet, or not a git repository.';
		results.push(skipped('no AI attribution in git history', 'commits', why));
		results.push(skipped('no estate identifiers in git history', 'commits', why));
		return results;
	}

	try {
		log = execFileSync('git', ['log', `--format=%H%n%B%n${SEPARATOR}`, '-n', '300'], {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
	} catch {
		results.push(notRun('no AI attribution in git history', 'commits', 'git log failed.'));
		results.push(notRun('no estate identifiers in git history', 'commits', 'git log failed.'));
		return results;
	}

	/** @type {string[]} */
	const historyAttribution = [];
	/** @type {string[]} */
	const historyIdentifiers = [];
	for (const entry of log.split(SEPARATOR)) {
		const trimmed = entry.trim();
		if (trimmed.length === 0) continue;
		commits += 1;
		const newline = trimmed.indexOf('\n');
		const sha = newline === -1 ? trimmed : trimmed.slice(0, newline);
		const body = newline === -1 ? '' : trimmed.slice(newline + 1);
		for (const { pattern, what } of ATTRIBUTION_PATTERNS) {
			if (pattern.test(body)) historyAttribution.push(`${sha.slice(0, 8)} contains ${what}.`);
		}
		for (const { pattern, what } of IDENTIFIER_PATTERNS) {
			// The short sha and the description, never the matched value, for the reason the
			// source row already gives: a guard that reports a leaked identifier by quoting it
			// has put the value in a CI log, which is one of the places it was not supposed to
			// reach. Here it would also put it in the log of a run whose whole point is that the
			// value is already somewhere it cannot easily be removed from.
			if (pattern.test(body)) historyIdentifiers.push(`${sha.slice(0, 8)} contains ${what}.`);
		}
	}

	results.push(check('no AI attribution in git history', commits, 'commits', historyAttribution));
	results.push(
		check('no estate identifiers in git history', commits, 'commits', historyIdentifiers),
	);

	return results;
}

/**
 * Only when invoked directly. Exporting `run` lets the suite exercise the checks
 * without spawning a process, and a guard that cannot be tested is a guard nobody
 * knows the failure output of until it fires.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { ok } = render('hex-docs house lint', run());
	process.exit(ok ? 0 : 1);
}
