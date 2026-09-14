/**
 * The prebuild predicate, which binds the prefetch segment the way the CLI binds it.
 *
 * Step 5's predicate asked for three substrings. Against the real hex-web it passed the
 * fragment `install` wrote, `prefetch --root ../..`, which the CLI refuses with exit 2 on
 * every build; it refused `--site=apps/front`, which the CLI accepts; and it accepted
 * `... || true && node scripts/check-docs.mjs`, where a failed prefetch fails nothing. Each
 * of those is a case below, and each names the arm of `readPrebuild` it proves.
 *
 * Everything runs over an in-memory descriptor. The predicate reads the script table and the
 * descriptor's path arithmetic and nothing else, so no fixture tree is needed to show it.
 */

import { describe, expect, test } from 'vitest';

import { bucketOf } from '../../src/commands/common.js';
import { detectSite, memoryFiles } from '../../src/wiring/detect.js';
import { prebuildFragment, readPrebuild, splitScript } from '../../src/wiring/prebuild.js';
import type { SiteDescriptor } from '../../src/wiring/site.js';

const HEXWEB: SiteDescriptor = detectSite({
	repoRoot: '/nowhere',
	site: 'apps/front',
	mount: 'common/docs',
	files: memoryFiles({}),
});

const KCALC: SiteDescriptor = detectSite({
	repoRoot: '/nowhere',
	site: 'kcalc-web/front',
	mount: 'kcalc-web/docs',
	files: memoryFiles({}),
});

const LAUNCHER = '../../common/docs/kit/bin/hexdocs';
const PREFETCH = `${LAUNCHER} prefetch ../.. --site apps/front`;
const GUARD = 'node scripts/check-docs.mjs';

function problems(
	scripts: Record<string, unknown>,
	site: SiteDescriptor = HEXWEB,
): readonly string[] {
	return readPrebuild(scripts, site).problems;
}

describe('splitScript', () => {
	test('splits on the five control operators and records the one on each side', () => {
		const segments = splitScript('a && b || c ; d | e & f') ?? [];
		expect(segments.map((segment) => [segment.before, segment.text, segment.after])).toEqual([
			[null, 'a', '&&'],
			['&&', 'b', '||'],
			['||', 'c', ';'],
			[';', 'd', '|'],
			['|', 'e', '&'],
			['&', 'f', null],
		]);
	});

	test('an operator inside quotes is part of the command, not a separator', () => {
		// `echo "a && prefetch"` is one command. A split that ignored quotes would find a
		// prefetch segment the shell never runs.
		const segments = splitScript(`echo "x && ${PREFETCH}" && ${GUARD}`) ?? [];
		expect(segments.map((segment) => segment.text)).toEqual([`echo "x && ${PREFETCH}"`, GUARD]);
		expect(splitScript("echo 'a || b; c'")?.map((segment) => segment.text)).toEqual([
			"echo 'a || b; c'",
		]);
	});

	test('a redirection is not a background operator', () => {
		expect(splitScript('build 2>&1 && next')?.map((segment) => segment.text)).toEqual([
			'build 2>&1',
			'next',
		]);
		expect(splitScript('build &> log')?.map((segment) => segment.text)).toEqual(['build &> log']);
	});

	test('a newline separates like a semicolon, and an escaped character is kept', () => {
		expect(splitScript('a\nb')?.map((segment) => [segment.text, segment.before])).toEqual([
			['a', null],
			['b', ';'],
		]);
		// Each `&` escaped is an argument. One escaped and one bare is an argument and then a
		// background operator, which is how a shell reads it too.
		expect(splitScript('a \\&\\& b')?.map((segment) => segment.text)).toEqual(['a \\&\\& b']);
		expect(splitScript('a \\&& b')?.map((segment) => [segment.text, segment.after])).toEqual([
			['a \\&', '&'],
			['b', null],
		]);
	});

	test('what only a shell can split is refused rather than guessed at', () => {
		expect(splitScript('echo "unterminated')).toBeNull();
		expect(splitScript("echo 'unterminated")).toBeNull();
		expect(splitScript('x=$(a && b)')).toBeNull();
		expect(splitScript('x=`a && b`')).toBeNull();
		expect(splitScript('echo "$(a && b)"')).toBeNull();
		// Single quotes do not substitute, so that one is readable.
		expect(splitScript("echo '$(a && b)'")).not.toBeNull();
	});
});

describe('the fragment install writes is accepted on both shapes', () => {
	test('hex-web: appended to a shared prebuild', () => {
		expect(
			problems({ prebuild: `../../common/copy-assets.sh && ${prebuildFragment(HEXWEB)}` }),
		).toEqual([]);
	});

	test('kcalc: a prebuild created where there was none, beside a build that chains', () => {
		expect(
			problems(
				{
					prebuild: prebuildFragment(KCALC),
					build: 'node scripts/build-lastmod.mjs && react-router build',
				},
				KCALC,
			),
		).toEqual([]);
	});

	test('with a bucket', () => {
		expect(problems({ prebuild: prebuildFragment(HEXWEB, 'docs-bucket-example') })).toEqual([]);
	});

	test('in build, ahead of react-router build, which is kcalc own idiom for a pre-step', () => {
		expect(problems({ build: `${PREFETCH} && ${GUARD} && react-router build` })).toEqual([]);
	});

	test('the guard in build and the prefetch in prebuild, which is still the right order', () => {
		expect(problems({ prebuild: PREFETCH, build: `${GUARD} && react-router build` })).toEqual([]);
	});
});

describe('the CLI accepts spellings a substring test refused', () => {
	test.each([
		['an equals sign', `${LAUNCHER} prefetch ../.. --site=apps/front`],
		['flags before the positional', `${LAUNCHER} prefetch --site apps/front ../..`],
		['a trailing slash on the site', `${LAUNCHER} prefetch ../.. --site apps/front/`],
		[
			'a launcher path with a dot segment',
			`./../../common/docs/kit/bin/hexdocs prefetch ../.. --site apps/front`,
		],
		['an offline flag', `${LAUNCHER} prefetch ../.. --site apps/front --offline`],
	])('%s', (_name, segment) => {
		expect(problems({ prebuild: `${segment} && ${GUARD}` })).toEqual([]);
	});
});

describe('every arm refuses what it exists to refuse', () => {
	const refuses = (scripts: Record<string, unknown>, pattern: RegExp, site = HEXWEB) => {
		const found = problems(scripts, site);
		expect(found.find((problem) => pattern.test(problem)) ?? found.join(' | ')).toMatch(pattern);
	};

	test('no prefetch at all', () => {
		refuses({ prebuild: '../../common/copy-assets.sh' }, /runs `hexdocs prefetch`\.$/);
	});

	test('no guard at all', () => {
		refuses({ prebuild: PREFETCH }, /runs `node scripts\/check-docs\.mjs`\.$/);
	});

	test('the step 5 fragment, which passes --root', () => {
		refuses(
			{ prebuild: `${LAUNCHER} prefetch --root ../.. --site apps/front && ${GUARD}` },
			/is refused by the CLI before it runs: .*'--root'/,
		);
	});

	test('a second positional', () => {
		refuses(
			{ prebuild: `${PREFETCH} extra && ${GUARD}` },
			/is refused by the CLI before it runs: .*positional/,
		);
	});

	test('a value the schema refuses', () => {
		// `--site` bound with nothing after it would be a usage error; `--site ""` is refused
		// by the shell-rewrite arm first, so the schema is reached through a missing site.
		refuses(
			{ prebuild: `${LAUNCHER} prefetch ../.. && ${GUARD}` },
			/is refused by the CLI's argument schema: site:/,
		);
	});

	test('a root that resolves to the site rather than the repository', () => {
		refuses(
			{ prebuild: `${LAUNCHER} prefetch . --site apps/front && ${GUARD}` },
			/names `\.` as the repository root, which from `apps\/front` is `apps\/front`/,
		);
	});

	test('a root that climbs out of the repository', () => {
		// `resolveFrom` pops an empty stack silently and would call this the root.
		refuses(
			{ prebuild: `${LAUNCHER} prefetch ../../.. --site apps/front && ${GUARD}` },
			/is outside the repository/,
		);
	});

	test('an absolute root', () => {
		refuses(
			{ prebuild: `${LAUNCHER} prefetch /srv/web --site apps/front && ${GUARD}` },
			/is outside the repository/,
		);
	});

	test('a different site', () => {
		refuses(
			{ prebuild: `${LAUNCHER} prefetch ../.. --site apps/other && ${GUARD}` },
			/names `--site apps\/other`, and this site is `apps\/front`/,
		);
	});

	test('a launcher that is not this mount', () => {
		refuses(
			{ prebuild: `npx hexdocs prefetch ../.. --site apps/front && ${GUARD}` },
			/runs `npx`, which is not this mount's launcher/,
		);
	});

	test('a hexdocs command other than prefetch', () => {
		refuses(
			{ prebuild: `${LAUNCHER} verify-install --site apps/front && ${GUARD}` },
			/runs `hexdocs verify-install` rather than `hexdocs prefetch`/,
		);
	});

	test('a shell variable, a quote and a glob in the segment', () => {
		for (const segment of [
			`${PREFETCH} --bucket $HEXDOCS_BUCKET`,
			`${LAUNCHER} prefetch ../.. --site "apps/front"`,
			`${LAUNCHER} prefetch ../.. --site apps/*`,
		]) {
			refuses({ prebuild: `${segment} && ${GUARD}` }, /holds a character the shell rewrites/);
		}
	});

	test('a masking operator anywhere after the prefetch', () => {
		// Each pattern names the prefetch segment itself, because the guard segment after it can
		// be masked by the same operator and a pattern that matched either would not show that
		// the prefetch was read past its own neighbour.
		const prefetchFollowedBy = (separator: string) =>
			new RegExp(
				`^\`[^\`]*hexdocs prefetch[^\`]*\` is followed in \`prebuild\` by \`${separator}\``,
			);
		refuses({ prebuild: `${PREFETCH} || true && ${GUARD}` }, prefetchFollowedBy('\\|\\|'));
		refuses({ prebuild: `${PREFETCH} && ${GUARD} || true` }, prefetchFollowedBy('\\|\\|'));
		refuses({ prebuild: `${PREFETCH} && ${GUARD}; echo done` }, prefetchFollowedBy(';'));
		refuses({ prebuild: `${PREFETCH} | tee log && ${GUARD}` }, prefetchFollowedBy('\\|'));
	});

	test('a prefetch that only runs when the command before it fails', () => {
		refuses({ prebuild: `build-assets || ${PREFETCH} && ${GUARD}` }, /follows `\|\|`/);
	});

	test('a guard that is masked, or is not the guard', () => {
		refuses({ prebuild: `${PREFETCH} && ${GUARD} || true` }, /check-docs\.mjs` is followed/);
		refuses(
			{ prebuild: `${PREFETCH} && node ../other/scripts/check-docs.mjs` },
			/is not `node scripts\/check-docs\.mjs` run from `apps\/front`/,
		);
		refuses(
			{ prebuild: `${PREFETCH} && node scripts/check-docs.mjs --quiet` },
			/is not `node scripts\/check-docs\.mjs` run from `apps\/front`/,
		);
	});

	test('the guard before the prefetch', () => {
		refuses(
			{ prebuild: `${GUARD} && ${PREFETCH}` },
			/runs before `hexdocs prefetch` rather than after it/,
		);
		refuses(
			{ prebuild: GUARD, build: `${PREFETCH} && react-router build` },
			/runs before `hexdocs prefetch`/,
		);
	});

	test('the prefetch after react-router build in the same script', () => {
		refuses(
			{ build: `react-router build && ${PREFETCH} && ${GUARD}` },
			/runs after `react-router build`, which compiles the bundles before they are on disk/,
		);
	});

	test('every prefetch segment has to pass, not just one of them', () => {
		// A step 5 fragment left ahead of a correct one still exits 2 and stops the build
		// before the correct one runs.
		refuses(
			{
				prebuild: `${LAUNCHER} prefetch --root ../.. --site apps/front && ${PREFETCH} && ${GUARD}`,
			},
			/'--root'/,
		);
	});

	test('a script only a shell could split, when it names the guard', () => {
		refuses(
			{ prebuild: `x=$(${PREFETCH}) && ${GUARD}` },
			/holds an open quote or a command substitution/,
		);
		// And not when it does not: an unrelated script is not this check's business.
		expect(
			problems({ prebuild: `${PREFETCH} && ${GUARD}`, build: 'x=$(date) && react-router build' }),
		).toEqual([]);
	});
});

describe('what the reading reports beside the problems', () => {
	test('it counts the always-run scripts and names the segments it found', () => {
		const reading = readPrebuild(
			{
				prebuild: `../../common/copy-assets.sh && ${PREFETCH} && ${GUARD}`,
				build: 'react-router build',
				dev: 'x',
			},
			HEXWEB,
		);
		expect(reading.scripts).toBe(2);
		expect(reading.launcherSegments).toEqual([PREFETCH]);
		expect(reading.guardSegments).toEqual([GUARD]);
	});

	test('a bucket is refused exactly when prefetch would refuse it', () => {
		// Agreement with `bucketOf` rather than a list of names, so the bucket grammar lives in
		// one place and this predicate cannot accept a bucket prefetch will refuse at build time.
		for (const bucket of ['docs-bucket-example', 'file://bucket', 'Bucket_Name', 'ab']) {
			const found = problems({ prebuild: `${PREFETCH} --bucket ${bucket} && ${GUARD}` });
			expect([
				bucket,
				found.some((problem) => /names a bucket prefetch refuses/.test(problem)),
			]).toEqual([bucket, 'why' in bucketOf(bucket)]);
		}
	});
});
