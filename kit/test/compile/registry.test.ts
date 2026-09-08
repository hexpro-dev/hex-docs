/**
 * Every rule's example, and which half of the compiler answers for it.
 *
 * `RuleDefinition.examples` says "the bad example must actually trip the rule", and
 * `prose.test.ts` proves that for the thirteen rules that read prose. This file does the
 * same for the rules the compiler itself emits, and closes the gap between them: every
 * id in `LINT_RULE_IDS` is classified here, so a rule added without an implementation
 * and without a stated reason fails the classification rather than sitting in the
 * registry with an example nothing has ever run.
 *
 * The third category is the honest one. Some rules cannot be demonstrated by a snippet
 * because the thing that is wrong is a relationship between files: a page missing from
 * the nav, a translation older than its source, an asset in the wrong colour space.
 * Their examples describe the situation instead, and what covers those rules is
 * `corpus.test.ts`, where the corpus is the situation.
 */

import { describe, expect, test } from 'vitest';

import { LINT_RULE_IDS, type LintRuleId } from '../../../src/contracts/lint.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';
import { readAppFile, SITE_ROOT } from '../../../fixtures/index.js';
import { compilePage } from '../../src/compile/page.js';
import { highlight } from '../../src/compile/highlight/index.js';
import { pageFindings } from '../../src/compile/lint/page.js';
import { RULE_DEFINITIONS } from '../../src/compile/lint/registry.js';
import type { ParseServices, RawFinding } from '../../src/compile/types.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This directory, so a file a sentence names can be checked to exist rather than assumed. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The thirteen `prose.test.ts` owns. Listed, not imported, so a move fails here too. */
const PROSE: readonly LintRuleId[] = [
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
	'internal-leak',
	'no-raw-html',
];

/** Rules whose example is a markdown body the compiler can be handed directly. */
const IN_MARKDOWN: readonly LintRuleId[] = [
	'no-h1-in-body',
	'heading-depth',
	'heading-order',
	'code-fence-language',
	'table-header-required',
	'unsupported-syntax',
	'alt-text-required',
	'no-bolded-bullet-leadins',
	'link-resolves',
	'snippet-resolves',
];

/** Rules whose example is a front matter value rather than a body. */
const IN_FRONT_MATTER = [
	'title-length',
	'description-length',
	'description-is-a-sentence',
	'front-matter-invalid',
] as const satisfies readonly LintRuleId[];

/**
 * Which front matter key each of those rules reads, so its example can be put there.
 *
 * `null` means the example is a whole front matter block rather than one value, which is
 * what `front-matter-invalid`'s has to be: the thing that is wrong is the block.
 */
const FRONT_MATTER_KEY: Readonly<Record<(typeof IN_FRONT_MATTER)[number], string | null>> = {
	'title-length': 'title',
	'description-length': 'description',
	'description-is-a-sentence': 'description',
	'front-matter-invalid': null,
};

/**
 * Rules whose example describes a situation rather than showing a snippet, with the file
 * that fires them.
 *
 * Each of these is a relationship between files, so there is no page that demonstrates it
 * on its own. This bucket used to say the corpus was the demonstration, and for most of
 * them that was untrue: the corpus trips none of them, and six of these rules plus three
 * arms of `page-size` could have their bodies deleted with the whole suite green. The
 * sentences below now name the file that really does fire each one, and the coverage they
 * claim is asserted there rather than here: `rules-fire.test.ts` builds a case per
 * situation and checks the union of its cases against `LINT_RULE_IDS` in both directions,
 * so a rule that stops firing fails by name.
 */
const DESCRIBED: Readonly<Partial<Record<LintRuleId, string>>> = {
	'page-size':
		'Three budgets in two files. rules-fire.test.ts claims each arm by the message only it produces.',
	'orphan-page':
		'A page missing from nav.json. The corpus has a draft that must not be one; rules-fire.test.ts adds one that must.',
	'nav-duplicate': 'Two nav entries for one slug, built by rules-fire.test.ts.',
	'nav-depth':
		'A fourth level of nav groups, built by rules-fire.test.ts. The corpus nests exactly three.',
	'slug-reserved': 'A filename that ties with a built-in route, planted by rules-fire.test.ts.',
	'anchor-resolves':
		'A fragment checked against another page. rules-fire.test.ts writes the pointer.',
	'translation-missing':
		'A locale with no file, which the corpus has four of and rules-fire.test.ts asserts.',
	'translation-stale':
		'A comparison of two git committer dates, replayed by the corpus and asserted in rules-fire.test.ts.',
	'translation-is-source-text':
		'A near-copy that nobody flagged, written by rules-fire.test.ts. A byte-for-byte copy is scaffolded instead.',
	'heading-set-matches-source': 'A comparison of two pages headings, built by rules-fire.test.ts.',
	'glossary-term-translated':
		'A term dropped from a translation and from the snippet it transcludes, in rules-fire.test.ts.',
	'bidi-balance':
		'An unbalanced directional control, invisible in an example and written as an escape in rules-fire.test.ts.',
	'asset-colour-space':
		'A PNG with a cICP chunk, in assets.test.ts and as a finding in rules-fire.test.ts.',
	'asset-size': 'A byte count against a budget, tripped by a padded asset in rules-fire.test.ts.',
	'asset-svg-unsafe': 'An SVG document, in assets.test.ts and as a finding in rules-fire.test.ts.',
};

const CONFIG = JSON.parse(readFileSync(join(SITE_ROOT, 'docs.json'), 'utf8')) as DocsProjectConfig;

/**
 * Services that resolve what the corpus resolves and refuse everything else.
 *
 * `link-resolves` needs a resolver that says no, and `alt-text-required` needs one that
 * says yes to an image, so both are here rather than stubbed per test.
 */
function services(): ParseServices {
	return {
		highlight,
		resolveLink: (href) =>
			href === 'chip-support.md'
				? { ok: true, link: { type: 'link', kind: 'internal', slug: 'reference/chip-support' } }
				: {
						ok: false,
						message: `"${href}" resolves to a slug no page in this project has.`,
						remediation: null,
					},
		resolveImage: () => ({ ok: true, src: `assets/${'a'.repeat(64)}.png`, width: 10, height: 10 }),
		resolveInclude: (id) =>
			id === 'safety-note'
				? { ok: true, blocks: [] }
				: { ok: false, message: `There is no snippet "${id}".`, remediation: null },
	};
}

/** Compiles one markdown body as a page and returns every finding it produced. */
function findingsFor(body: string, front: Record<string, string> = {}): RawFinding[] {
	const frontMatter = {
		title: 'A page',
		description: 'One sentence about the page.',
		...front,
	};
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

	return [
		...output.findings,
		...pageFindings({
			config: CONFIG,
			page: output.page,
			parsed: output.parsed,
			file: output.page.sourceFile,
			locale: 'en',
		}),
	];
}

/**
 * A whole document, front matter and all, for the one rule whose example is the block.
 *
 * `compilePage` throws on front matter it cannot read at all, and the rule exists to
 * report exactly that, so the throw is caught and turned back into the finding the caller
 * would have got from a build. What matters is that the example is run rather than
 * measured for length.
 */
function findingsOfDocument(text: string): RawFinding[] {
	try {
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
		return output.findings;
	} catch (error) {
		const problems = (error as { findings?: RawFinding[]; finding?: RawFinding }).findings;
		if (problems !== undefined) return problems;
		const one = (error as { finding?: RawFinding }).finding;
		return one === undefined ? [] : [one];
	}
}

describe('every rule is classified', () => {
	test('the four lists together are exactly LINT_RULE_IDS', () => {
		const classified = [...PROSE, ...IN_MARKDOWN, ...IN_FRONT_MATTER, ...Object.keys(DESCRIBED)];
		expect(classified.length).toBe(new Set(classified).size);
		expect([...classified].sort()).toEqual([...LINT_RULE_IDS].sort());
	});

	test('a described rule names the file that fires it', () => {
		// The sentence is documentation and this test now says so. What used to be here was
		// a length check and a full stop, which is satisfied by a sentence claiming coverage
		// that does not exist: most of these named the corpus and the corpus trips none of
		// them. The coverage itself is asserted in the file each sentence names, where it
		// can fail. What is worth checking here is that the pointer is a real file, so it
		// cannot rot into naming one that was renamed or deleted.
		const files = new Set<string>();
		for (const [id, why] of Object.entries(DESCRIBED)) {
			expect(why.length, id).toBeGreaterThan(30);
			expect(why.endsWith('.'), id).toBe(true);
			const named = why.match(/[a-z-]+\.test\.ts/gu) ?? [];
			expect(named.length, `${id}: names no test file`).toBeGreaterThan(0);
			for (const file of named) files.add(file);
		}
		for (const file of files) {
			expect(existsSync(join(HERE, file)), `${file} is named and does not exist`).toBe(true);
		}

		// Derived, not a literal. A rule moved out of this bucket into one of the three that
		// run their examples should not need this number edited, and a rule added to the
		// contract and dropped in here should not keep it correct by accident.
		expect(Object.keys(DESCRIBED).length).toBe(
			LINT_RULE_IDS.length - PROSE.length - IN_MARKDOWN.length - IN_FRONT_MATTER.length,
		);
	});
});

describe('the registry examples the compiler can run', () => {
	test.each(IN_MARKDOWN)('the bad example for %s trips it and the good one does not', (id) => {
		const definition = RULE_DEFINITIONS[id];
		let examined = 0;
		for (const example of definition.examples) {
			const bad = findingsFor(example.bad).filter((finding) => finding.rule === id);
			expect(bad.length, `${id}: the bad example produced no ${id} finding`).toBeGreaterThan(0);
			for (const finding of bad) {
				// Every finding carries a line. A rule that could only name the file would send
				// a reader to the top of a two hundred line page to look for one word.
				expect('line' in finding.location && finding.location.line, id).toBeGreaterThan(0);
			}

			const good = findingsFor(example.good).filter((finding) => finding.rule === id);
			expect(good, `${id}: the good example produced ${good.length} findings`).toEqual([]);
			examined += 1;
		}
		expect(examined).toBe(definition.examples.length);
	});

	test.each(IN_FRONT_MATTER)('the bad example for %s trips it and the good one does not', (id) => {
		// This used to assert that two strings were non-empty, while the file above it said
		// "the bad example must actually trip the rule". Under that assertion
		// `description-length` had no test anywhere, so its budget arm could be deleted and
		// the suite stayed green. Running the example is what IN_MARKDOWN already does, with
		// the value put in the key the rule reads rather than in the body.
		const definition = RULE_DEFINITIONS[id];
		const key = FRONT_MATTER_KEY[id];
		const where = key ?? 'the whole block';
		const run = (value: string): RawFinding[] =>
			key === null
				? findingsOfDocument(`${value}\n\n## Section\n\nText.\n`)
				: findingsFor('## Section\n\nText.', { [key]: value });

		let examined = 0;
		for (const example of definition.examples) {
			expect(
				run(example.bad).some((finding) => finding.rule === id),
				`${id}: the bad example in ${where} produced no ${id} finding`,
			).toBe(true);
			expect(
				run(example.good).filter((finding) => finding.rule === id),
				`${id}: the good example in ${where} tripped it`,
			).toEqual([]);
			examined += 1;
		}
		expect(examined).toBe(definition.examples.length);
	});

	test('a title over the budget trips title-length, and one under it does not', () => {
		const long = RULE_DEFINITIONS['title-length'].examples[0];
		expect(long).toBeDefined();
		const bad = findingsFor('Body.', { title: long?.bad ?? '' });
		expect(bad.some((finding) => finding.rule === 'title-length')).toBe(true);
		const good = findingsFor('Body.', { title: long?.good ?? '' });
		expect(good.some((finding) => finding.rule === 'title-length')).toBe(false);
	});

	test('a description that is not a sentence trips its rule', () => {
		const example = RULE_DEFINITIONS['description-is-a-sentence'].examples[0];
		expect(example).toBeDefined();
		const bad = findingsFor('Body.', { description: example?.bad ?? '' });
		expect(bad.some((finding) => finding.rule === 'description-is-a-sentence')).toBe(true);
		const good = findingsFor('Body.', { description: example?.good ?? '' });
		expect(good.some((finding) => finding.rule === 'description-is-a-sentence')).toBe(false);
	});
});

describe('the corpus is the situation the described rules need', () => {
	test('the fixture guide is the one place the authoring rules are written down', () => {
		// A cheap assertion with a real purpose: the guide at docs/CLAUDE.md is what an
		// agent reads before writing a page, and it is one level above docs/site/ because
		// FORBIDDEN_SOURCE_NAMES refuses that name inside the publishable root. If it moves,
		// the prune step in sync-public.sh kills a tagged release over a file nobody put
		// there on purpose.
		const guide = readAppFile('docs/CLAUDE.md');
		expect(guide).toContain('docs/site/docs.json');
		expect(guide).toContain('::include[safety-note]');
	});
});
