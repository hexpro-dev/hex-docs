/**
 * Every lint rule, fired at least once, with the set checked in both directions.
 *
 * This file exists because the answer to "is this rule implemented" was, for nine rule
 * arms, no test at all. Six rules and three arms of `page-size` could have their bodies
 * deleted with 1633 tests green: the golden `lint.json` pins the findings the corpus
 * produces, so a rule that starts over-firing is caught, and a rule that stops firing
 * changes nothing. `summary.passing` counts a rule that reported nothing as passing, so
 * it does not move either. A support matrix page with an unbalanced U+202B, a 200KB code
 * fence, or a Chinese page that dropped `NDEF` would have published clean.
 *
 * The shape is what matters more than the cases. Each entry in `CASES` claims the rules
 * it is responsible for producing, and two assertions run over the table: every claimed
 * rule really is produced by that case, and the union of every case's rules is exactly
 * `LINT_RULE_IDS`. So a rule added to the contract fails here until something fires it,
 * and a rule whose implementation is deleted fails here naming the rule. Neither
 * direction can be satisfied by a sentence describing what covers it, which is what the
 * `DESCRIBED` bucket in `registry.test.ts` used to accept.
 *
 * The relational rules need a whole project rather than a page, so the corpus is
 * materialised once and copied per case. That costs about a second and a half plus about
 * half a second a build, which is the price of the only guard that makes deleting a rule
 * fail.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus, REJECTED_ROOT, SITE_ROOT } from '../../../fixtures/index.js';
import { LINT_RULE_IDS, type LintRuleId } from '../../../src/contracts/lint.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';
import { buildBundle } from '../../src/compile/build.js';
import { compilePage } from '../../src/compile/page.js';
import { highlight } from '../../src/compile/highlight/index.js';
import { pageFindings } from '../../src/compile/lint/page.js';
import { PROSE_RULES } from '../../src/compile/lint/prose.js';
import type { ParseServices, RawFinding } from '../../src/compile/types.js';

const GENERATOR = '@hex-pro/docs-kit@0.1.0';
const CONFIG = JSON.parse(readFileSync(join(SITE_ROOT, 'docs.json'), 'utf8')) as DocsProjectConfig;

let root: string;
let template: string;
let copies = 0;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-rules-'));
	template = materialiseCorpus(join(root, 'template')).root;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function corpus(): string {
	copies += 1;
	const target = join(root, `copy-${copies}`);
	cpSync(template, target, { recursive: true, dereference: false, verbatimSymlinks: true });
	return target;
}

const site = (repo: string, path: string): string => join(repo, 'docs', 'site', path);

function write(repo: string, path: string, text: string): void {
	const full = site(repo, path);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(full, text);
}

function commit(repo: string): void {
	execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['commit', '-m', 'perturb', '--no-verify'], {
		cwd: repo,
		stdio: 'ignore',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
			GIT_AUTHOR_DATE: '2026-06-01T00:00:00Z',
			GIT_COMMITTER_DATE: '2026-06-01T00:00:00Z',
		},
	});
}

/** Everything a build of the perturbed tree reported, rule ids only. */
function built(perturb: (repo: string) => void): RawFinding[] {
	const repo = corpus();
	perturb(repo);
	commit(repo);
	return buildBundle(repo, { generator: GENERATOR }).lint.envelope.findings.map((finding) => ({
		...finding,
		remediation: null,
		suggestion: null,
		excerpt: null,
	})) as unknown as RawFinding[];
}

/**
 * Services that resolve what the corpus resolves and refuse everything else.
 *
 * Copied in shape from `registry.test.ts` rather than shared, because that file's set is
 * tuned to its own examples and a shared one would make each file's cases depend on the
 * other's.
 */
function services(): ParseServices {
	return {
		highlight,
		resolveLink: (href) =>
			href === 'chip-support.md'
				? { ok: true, link: { type: 'link', kind: 'internal', slug: 'reference/chip-support' } }
				: { ok: false, message: `"${href}" resolves to no page.`, remediation: null },
		resolveImage: () => ({ ok: true, src: `assets/${'a'.repeat(64)}.png`, width: 10, height: 10 }),
		resolveInclude: (id) =>
			id === 'safety-note'
				? { ok: true, blocks: [] }
				: { ok: false, message: `There is no snippet "${id}".`, remediation: null },
	};
}

/** One markdown body compiled as a page, with the page rules and the prose rules run. */
function page(body: string, front: Record<string, string> = {}): RawFinding[] {
	const frontMatter = { title: 'A page', description: 'One sentence about the page.', ...front };
	const text = `---\n${Object.entries(frontMatter)
		.map(([key, value]) => `${key}: ${value}`)
		.join('\n')}\n---\n\n${body}\n`;

	const output = compilePage({
		config: CONFIG,
		slug: 'reference/example',
		locale: 'en',
		document: {
			file: 'content/en/reference/example.md',
			repoPath: 'docs/site/content/en/reference/example.md',
			locale: 'en',
			id: 'reference/example',
			text,
		},
		services: services(),
		translation: { state: 'source', sourceUpdated: '2026-01-05T09:00:00Z' },
	});

	const context = {
		file: output.page.sourceFile,
		locale: 'en' as const,
		sourceLocale: 'en' as const,
		project: CONFIG,
		denyList: { private: 1 as const, strings: ['Contoso Tap'], patterns: [] },
		sourceLines: text.split('\n').map((line, index) => ({ text: line, line: index + 1 })),
		pageKind: output.page.pageKind,
		isDraft: false,
	};

	return [
		...output.findings,
		...pageFindings({
			config: CONFIG,
			page: output.page,
			parsed: output.parsed,
			file: output.page.sourceFile,
			locale: 'en',
		}),
		...Object.values(PROSE_RULES).flatMap((rule) => rule(output.parsed.prose, context)),
	];
}

interface Case {
	/** What is wrong, in the words a reader of a failure would want. */
	name: string;
	/** The rules this case answers for. Checked in both directions against the table. */
	rules: readonly LintRuleId[];
	/**
	 * The separate arms of one rule, each claimed by the message only it can produce.
	 *
	 * `page-size` is three budgets in two files, and a case tripping any one of them keeps
	 * the rule in the fired set while the other two are deleted. That is this whole file's
	 * hole one level down. Counting findings does not close it either: the nesting arm
	 * reports once per level and produced three distinct messages on its own, so a count
	 * of three was satisfied with the other two arms gone. A pattern per arm is what names
	 * the arm that stopped firing.
	 */
	arms?: readonly { rule: LintRuleId; matches: RegExp; why: string }[];
	run: () => RawFinding[];
}

const CASES: readonly Case[] = [
	// -------------------------------------------------------------------------
	// One page is enough
	// -------------------------------------------------------------------------
	{
		name: 'a body that starts with an h1 and then skips a level',
		rules: ['no-h1-in-body', 'heading-order'],
		run: () => page('# Scan a tag\n\n## Errors\n\n#### Retry behaviour\n\nText.'),
	},
	{
		name: 'a heading below the depth the table of contents shows',
		rules: ['heading-depth'],
		run: () => page('## A\n\n### B\n\n#### C\n\n##### D\n\n###### E\n\nText.'),
	},
	{
		name: 'raw HTML, a fence with no language and a table that does not line up',
		rules: ['no-raw-html', 'code-fence-language', 'table-header-required'],
		arms: [
			{
				rule: 'table-header-required',
				matches: /header cell with no text/,
				why: 'A column nobody named, which a screen reader announces as nothing.',
			},
			{
				rule: 'table-header-required',
				matches: /cells and the header has/,
				why: 'A row wider than the header, which leaves a cell with no entry in `align`.',
			},
		],
		run: () =>
			page(
				[
					'## Section',
					'',
					'A <span>tag</span> here.',
					'',
					'```',
					'plain',
					'```',
					'',
					'| Chip |  |',
					'| --- | --- |',
					'| NTAG213 | yes |',
					'| NTAG215 | yes | extra |',
				].join('\n'),
			),
	},
	{
		name: 'a link and an include that resolve to nothing, and an image with no alt text',
		rules: ['link-resolves', 'snippet-resolves', 'alt-text-required'],
		run: () =>
			page('## Section\n\nSee [the guide](missing.md).\n\n::include[absent]\n\n![](scan.png)\n'),
	},
	{
		name: 'a run of four emphasis delimiters, which this AST major cannot read',
		rules: ['unsupported-syntax'],
		run: () => page('## Section\n\nThe ****important**** part.\n'),
	},
	{
		name: 'every bullet in a list opening with a bolded lead-in',
		rules: ['no-bolded-bullet-leadins'],
		run: () => page('## Section\n\n- **Speed:** it is fast.\n- **Range:** it is short.\n'),
	},
	{
		name: 'a title and a description over their budgets, and a description that is a fragment',
		rules: ['title-length', 'description-length', 'description-is-a-sentence'],
		run: () =>
			page('## Section\n\nText.', {
				title: `Writing a tag ${'and reading it back '.repeat(4)}on iPhone`,
				description: `Scanning tags ${'in a warehouse '.repeat(12)}quickly`,
			}),
	},
	{
		name: 'front matter that does not validate',
		rules: ['front-matter-invalid'],
		run: () => page('## Section\n\nText.', { audience: 'nobody' }),
	},
	{
		name: 'a right-to-left override that is never closed',
		rules: ['bidi-balance'],
		arms: [
			{
				rule: 'bidi-balance',
				matches: /with nothing open before it/,
				why: 'A closing control with no opener, reported at the control itself.',
			},
			{
				rule: 'bidi-balance',
				matches: /opened here and never closed/,
				why: 'An opener with no close, reported at the opener rather than at offset zero.',
			},
		],
		run: () =>
			page(
				[
					'## Section',
					'',
					// Written as escapes, because these characters are invisible and a literal one
					// in a test file is a string nobody reviewing this can see.
					//
					// The rocket is the point of this line. The loop walked code points and handed
					// the index to `positionAt`, whose runs are UTF-16 units, so every astral
					// character earlier in the paragraph shifted the reported column one to the
					// left and the error named the character before the control.
					'ab\u{1F680}cd\u2069ef is the run.',
					'',
					// And an opener that never closes, on a paragraph whose first line is not the
					// line carrying the control: the unclosed branch reported offset zero, which is
					// the start of the paragraph and therefore the wrong line.
					'A paragraph that begins here and wraps,',
					'and the \u202b override starts on the second line.',
				].join('\n'),
			),
	},
	{
		name: 'a page past all three of the size budgets',
		rules: ['page-size'],
		arms: [
			{
				rule: 'page-size',
				matches: /^The compiled page is \d+ bytes/,
				why: 'The payload budget, checked in the bundle writer rather than on the page.',
			},
			{
				rule: 'page-size',
				matches: /^Block nesting reaches \d+/,
				why: 'The nesting budget, checked while walking the blocks.',
			},
			{
				rule: 'page-size',
				matches: /^A code fence is \d+ bytes/,
				why: 'The fence budget, which a listing pasted whole is the way to exceed.',
			},
		],
		run: () =>
			built((repo) =>
				write(
					repo,
					'content/en/reference/enormous.md',
					[
						'---',
						'title: An enormous page',
						'description: Past the nesting, fence and payload budgets at once.',
						'---',
						'',
						'## Section',
						'',
						Array.from(
							{ length: 34 },
							(_unused, level) => `${'  '.repeat(level)}- level ${level}`,
						).join('\n'),
						'',
						'```swift',
						'let sample = 0\n'.repeat(21000),
						'```',
						'',
					].join('\n'),
				),
			),
	},
	{
		name: 'every prose rule, in one paragraph written the way the house rules forbid',
		rules: [
			'no-em-dash',
			'no-en-dash-prose',
			'no-decorative-unicode',
			'no-banned-phrase',
			'no-filler-verb-stack',
			'no-hedging-stack',
			'no-rhetorical-opener',
			'no-triad',
			'no-symmetric-pairs',
			'australian-spelling',
			'no-competitor-name',
		],
		run: () =>
			page(
				[
					'## Section',
					'',
					'What makes a tag reliable? A tag is reliable when it is written once.',
					'',
					// Every banned character is written as an escape, the same trick the registry
					// and the contract use: a literal here would be flagged by this repository's own
					// house lint, and an exemption for "the file that tests the rule" is the hole the
					// exemption mechanism exists to refuse.
					`This is not just a reader \u2014 it is a platform. It is designed to unlock`,
					`the full potential of your workflow. On connect the state is polling \u2192 connected,`,
					`and the tag \u2013 the one on the desk \u2013 stays put.`,
					'',
					'It is fast, simple, and secure. The Contoso Tap reader may potentially help to',
					'behave differently. The color of the light tells you the state.',
					'',
					'The reader opens a session and waits for a tag to come into range. The writer',
					'replaces the message and reports the free bytes left. The logger records the chip',
					'type and the time the scan finished.',
				].join('\n'),
			),
	},

	// -------------------------------------------------------------------------
	// A relationship between files
	// -------------------------------------------------------------------------
	{
		name: 'a published page that is in no nav entry',
		rules: ['orphan-page'],
		run: () =>
			built((repo) =>
				write(
					repo,
					'content/en/reference/loose.md',
					'---\ntitle: A loose page\ndescription: Published and in no nav entry.\n---\n\n## Section\n\nText.\n',
				),
			),
	},
	{
		name: 'a nav that lists one slug twice and nests a fourth level',
		rules: ['nav-duplicate', 'nav-depth'],
		run: () =>
			built((repo) => {
				const nav = JSON.parse(readFileSync(site(repo, 'nav.json'), 'utf8')) as {
					items: unknown[];
				};
				// The label is borrowed from a real group, because `localisedLabelSchema`
				// wants every locale the project declares and a partial one is refused by
				// the loader before the rule can ever see the depth.
				const group = nav.items.find(
					(item): item is { group: string; label: unknown } =>
						typeof item === 'object' && item !== null && 'group' in item,
				);
				const label = group?.label;
				nav.items.push({ doc: 'index' });
				nav.items.push({
					group: 'one',
					label,
					items: [
						{
							group: 'two',
							label,
							items: [
								{
									group: 'three',
									label,
									items: [{ group: 'four', label, items: [{ doc: 'guide/first-tag' }] }],
								},
							],
						},
					],
				});
				writeFileSync(site(repo, 'nav.json'), JSON.stringify(nav, null, '\t'));
			}),
	},
	{
		name: 'a page whose slug ties with a built-in route',
		rules: ['slug-reserved'],
		run: () =>
			built((repo) =>
				write(
					repo,
					'content/en/search.md',
					'---\ntitle: Search\ndescription: A page named after a machine address.\n---\n\n## Section\n\nText.\n',
				),
			),
	},
	{
		name: 'a link to a fragment the target page does not have',
		rules: ['anchor-resolves'],
		run: () =>
			built((repo) =>
				write(
					repo,
					'content/en/reference/pointer.md',
					'---\ntitle: A pointer\ndescription: Links a fragment that is not there.\n---\n\n## Section\n\nSee [the matrix](chip-support.md#no-such-heading).\n',
				),
			),
	},
	{
		name: 'a translation that is still the English text, with a heading it does not share',
		rules: [
			'translation-is-source-text',
			'heading-set-matches-source',
			'glossary-term-translated',
			'translation-missing',
			'translation-stale',
		],
		run: () =>
			built((repo) => {
				// A fresh pair rather than a copy of an existing page, for two reasons that
				// both come from the compiler being right. Byte-identical would be
				// `scaffolded`, and `sourceTextFindings` returns nothing for that state on
				// purpose, because the state already says the page is untranslated; so one
				// word is changed. And every page in the corpus that would be worth copying
				// transcludes a snippet, whose French version really is French, which drops
				// the similarity below the threshold. What this rule is for is the page
				// nobody flagged, and that is what this pair is.
				const body = [
					'---',
					'title: Pairing the rig',
					'description: A short page that exists to be copied without being translated.',
					'---',
					'',
					'## Pairing',
					'',
					'Open the app and hold the phone against the reader until the light turns green.',
					'The reader keeps the session open for two seconds and then closes it.',
					'',
				].join('\n');
				write(repo, 'content/en/guide/pairing.md', body);
				write(repo, 'content/fr/guide/pairing.md', body.replace('Open', 'Ouvrez'));

				// The term has to leave the snippet as well as the page. `legend` is
				// transcluded into the compiled body, so a page that dropped NDEF everywhere
				// of its own still contains it through the include, which is the compiler
				// being right and the reason this perturbation touches two files.
				const chinese = readFileSync(site(repo, 'content/zh/reference/chip-support.md'), 'utf8');
				write(
					repo,
					'content/zh/reference/chip-support.md',
					`${chinese.replaceAll('NDEF', '\u6d88\u606f')}\n\n## \u4e2d\u6587\u6807\u9898\n\n\u6b63\u6587\u3002\n`,
				);
				const legend = readFileSync(site(repo, 'snippets/zh/legend.md'), 'utf8');
				write(repo, 'snippets/zh/legend.md', legend.replaceAll('NDEF', '\u6d88\u606f'));
			}),
	},
	{
		name: 'assets that are too large, in the wrong colour space, and an unsafe SVG',
		rules: ['asset-size', 'asset-colour-space', 'asset-svg-unsafe'],
		run: () =>
			built((repo) => {
				const config = JSON.parse(readFileSync(site(repo, 'docs.json'), 'utf8')) as {
					budgets: { assetBytesMax: number };
				};
				// 1024 is the floor the config schema allows, which is why the oversized
				// asset below is padded rather than the budget being lowered to meet it.
				config.budgets.assetBytesMax = 1024;
				writeFileSync(site(repo, 'docs.json'), JSON.stringify(config, null, '\t'));

				// The two refused assets are the corpus's own, kept in `rejected/` because a
				// tree the compiler is asked to build has to build. Copying them in is the
				// only way to see the findings they exist for.
				for (const name of ['display-p3.png', 'unsafe-diagram.svg']) {
					writeFileSync(site(repo, `assets/${name}`), readFileSync(join(REJECTED_ROOT, name)));
				}

				// A safe SVG over the budget: the corpus glyph with a comment padding it past
				// 1024 bytes, so `asset-size` fires on a file nothing else refuses first.
				const glyph = readFileSync(site(repo, 'assets/nfc-glyph.svg'), 'utf8');
				writeFileSync(
					site(repo, 'assets/padded-glyph.svg'),
					glyph.replace('</svg>', `<!-- ${'padding '.repeat(120)}-->\n</svg>`),
				);
			}),
	},
	{
		name: 'a deny list that exists and holds nothing',
		rules: ['internal-leak'],
		run: () =>
			built((repo) =>
				writeFileSync(
					join(repo, 'docs', 'docs.private.json'),
					JSON.stringify({ private: 1, strings: [], patterns: [] }, null, '\t'),
				),
			),
	},
];

let produced: Map<string, RawFinding[]>;

beforeAll(() => {
	produced = new Map(CASES.map((entry) => [entry.name, entry.run()]));
});

describe('bidi-balance points at the character', () => {
	// Split out from the case table because what is wrong here is the position, and the
	// table asserts which rules fire rather than where. This rule is an `error` whose own
	// remediation says the damage is invisible in a diff, so the column is the only thing
	// pointing at the character, and it was one to the left of it on any paragraph
	// carrying an astral character earlier in the same line.
	test('a closing control after an astral character reports its own column', () => {
		const findings = page('## Section\n\nab\u{1F680}cd\u2069ef is the run.\n').filter(
			(finding) => finding.rule === 'bidi-balance',
		);
		expect(findings).toHaveLength(1);
		const at = findings[0]?.location;
		// The rocket is two UTF-16 units, so the pop-directional-isolate sits at offset 6
		// and its column is 7. Walking code points made it 6, which is the letter `d`.
		expect(at?.kind === 'file' ? [at.line, at.column] : undefined).toEqual([8, 7]);
	});

	test('an unclosed control reports the opener, not the start of the paragraph', () => {
		const findings = page(
			'## Section\n\nA paragraph that begins here and wraps,\nand the \u202b override starts on the second line.\n',
		).filter((finding) => finding.rule === 'bidi-balance');
		expect(findings).toHaveLength(1);
		const at = findings[0]?.location;
		// Line 9, the continuation line the control is actually on. Offset zero put it on
		// line 8, the first line of the paragraph, where there is nothing to find.
		expect(at?.kind === 'file' ? at.line : undefined).toBe(9);
	});
});

describe('every rule fires', () => {
	test.each(CASES.map((entry) => [entry.name, entry] as const))(
		'%s produces the rules it claims',
		(_name, entry) => {
			const findings = produced.get(entry.name) as RawFinding[];
			const fired = new Set(findings.map((finding) => finding.rule));
			const missing = entry.rules.filter((rule) => !fired.has(rule));
			expect(missing.join(', '), `${entry.name}: claimed but did not fire`).toBe('');

			for (const arm of entry.arms ?? []) {
				const hit = findings.some(
					(finding) => finding.rule === arm.rule && arm.matches.test(finding.message),
				);
				expect(hit, `${entry.name}: ${arm.rule} arm did not fire. ${arm.why}`).toBe(true);
			}
		},
	);

	test('the union of the cases is exactly LINT_RULE_IDS', () => {
		// The direction that catches a deleted implementation. Every rule has to be
		// somebody's responsibility here, and a rule added to the contract lands in
		// `missing` until a case fires it.
		const claimed = new Set([
			...CASES.flatMap((entry) => entry.rules),
			...CASES.flatMap((entry) => (entry.arms ?? []).map((arm) => arm.rule)),
		]);
		const missing = LINT_RULE_IDS.filter((rule) => !claimed.has(rule));
		expect(missing, 'no case fires these rules').toEqual([]);

		// And the other direction, so a rule removed from the contract does not leave a
		// case claiming a rule that no longer exists.
		const unknown = [...claimed].filter(
			(rule) => !(LINT_RULE_IDS as readonly string[]).includes(rule),
		);
		expect(unknown, 'claimed by a case and not in LINT_RULE_IDS').toEqual([]);
		expect(claimed.size).toBe(LINT_RULE_IDS.length);
	});

	test('no case claims a rule another case already answers for', () => {
		// One owner per rule, so a failure names one case to look at rather than three.
		const owners = new Map<LintRuleId, string[]>();
		for (const entry of CASES) {
			for (const rule of entry.rules) owners.set(rule, [...(owners.get(rule) ?? []), entry.name]);
		}
		const shared = [...owners].filter(([, names]) => names.length > 1);
		expect(shared).toEqual([]);
	});
});
