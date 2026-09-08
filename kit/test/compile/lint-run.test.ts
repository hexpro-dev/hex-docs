import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
	compareFindings,
	type Finding,
	type FindingLocation,
	type Severity,
} from '../../../src/contracts/diagnostics.js';
import {
	CHECK_IDS,
	LINT_RULE_IDS,
	PROTECTED_RULES,
	RULE_CATEGORIES,
	type LintRuleId,
	type RuleSetting,
} from '../../../src/contracts/lint.js';
import { SOURCE_LOCALE } from '../../../src/contracts/locales.js';
import type { Locale } from '../../../src/contracts/locales.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';

import { SITE_ROOT } from '../../../fixtures/index.js';
import { docsProjectConfigSchema } from '../../src/contracts/config.schema.js';
import { CHECK_DEFINITIONS, RULE_DEFINITIONS } from '../../src/compile/lint/registry.js';
import {
	MAX_FINDINGS,
	runLint,
	type LintRunOptions,
	type LintRunResult,
} from '../../src/compile/lint/run.js';
import { raw, type DisableComment, type RawFinding } from '../../src/compile/types.js';

/**
 * The runner, which is the only place a raw finding becomes a reportable one.
 *
 * Three separate decisions land here and nowhere else: what severity a finding carries,
 * whether a suppression drops it, and what order the list comes back in. Each one is
 * silent when it regresses. A severity resolved one step too low publishes a broken link
 * as a warning; a suppression matched on the wrong line silences the finding below the
 * one somebody meant; an unsorted list makes an agent's second call address a different
 * problem from its first. None of those throws, so nothing but a test notices.
 *
 * Severities and categories are read out of `RULE_DEFINITIONS` and `RULE_CATEGORIES`
 * rather than written down here. A default that changes in the registry then changes the
 * expectation with it, and what stays pinned is the behaviour under test, which is
 * whether the config was honoured rather than which severity the rule happens to start
 * at.
 */

const FIXTURE_CONFIG = docsProjectConfigSchema.parse(
	JSON.parse(readFileSync(join(SITE_ROOT, 'docs.json'), 'utf8')),
) as DocsProjectConfig;

const KIT_VERSION = '@hex-pro/docs-kit@0.0.0-test';

const FILE = 'content/en/guide/first-tag.md';
const OTHER_FILE = 'content/fr/guide/first-tag.md';

function at(file: string, line: number, column: number): FindingLocation {
	return { kind: 'file', file, line, column };
}

interface Extra {
	maxDisables?: number;
	disables?: DisableComment[];
	overrides?: Partial<Record<LintRuleId, Severity>>;
}

/**
 * The fixture config with its rule table **replaced**, not merged.
 *
 * Merging would leave the corpus's own two overrides in every case below, so a test that
 * said nothing about `australian-spelling` would still be running against a project that
 * had raised it, and the reason a severity came out the way it did would depend on a file
 * in another directory. The corpus's real table gets its own test instead.
 *
 * `maxDisables` defaults far above anything a case here carries, so the cap fires only in
 * the test that is about the cap.
 */
function options(
	rules: Partial<Record<LintRuleId, RuleSetting>> = {},
	extra: Extra = {},
): LintRunOptions {
	return {
		config: {
			...FIXTURE_CONFIG,
			lint: { extends: 'house', maxDisables: extra.maxDisables ?? 16, rules },
		},
		disables: extra.disables ?? [],
		kitVersion: KIT_VERSION,
		...(extra.overrides === undefined ? {} : { overrides: extra.overrides }),
	};
}

function disable(file: string, line: number, rule: string, reason: string): DisableComment {
	return { file, line, rule, reason, used: false };
}

/** [rule, severity, file, line, column], so a position regression fails as loudly as a severity one. */
function shape(finding: Finding): [string, Severity, string, number, number] {
	const location = finding.location;
	return [
		finding.rule,
		finding.severity,
		'file' in location ? location.file : '',
		'line' in location ? (location.line ?? 0) : 0,
		'column' in location ? (location.column ?? 0) : 0,
	];
}

function shapes(result: LintRunResult): [string, Severity, string, number, number][] {
	return result.envelope.findings.map(shape);
}

function only(result: LintRunResult): Finding {
	expect(result.envelope.findings).toHaveLength(1);
	const finding = result.envelope.findings[0];
	if (finding === undefined) throw new Error('runLint returned no finding');
	return finding;
}

// ---------------------------------------------------------------------------
// Severity: what the project config is allowed to change
// ---------------------------------------------------------------------------

describe('a project config decides a severity', () => {
	test('with no override every rule carries the registry default', () => {
		const result = runLint(
			[
				raw('no-h1-in-body', at(FILE, 12, 3), null, 'A second h1.'),
				raw('australian-spelling', at(FILE, 20, 5), null, 'organize.'),
			],
			options(),
		);

		expect(shapes(result)).toEqual([
			['no-h1-in-body', RULE_DEFINITIONS['no-h1-in-body'].defaultSeverity, FILE, 12, 3],
			['australian-spelling', RULE_DEFINITIONS['australian-spelling'].defaultSeverity, FILE, 20, 5],
		]);
		// The control for the two cases below: these two defaults are different from each
		// other and from what the config sets them to, so neither result can be an accident.
		expect(RULE_DEFINITIONS['no-h1-in-body'].defaultSeverity).toBe('error');
		expect(RULE_DEFINITIONS['australian-spelling'].defaultSeverity).toBe('info');
	});

	test('a config lowers one rule and raises another, and both are honoured', () => {
		const result = runLint(
			[
				raw('no-h1-in-body', at(FILE, 12, 3), null, 'A second h1.'),
				raw('australian-spelling', at(FILE, 20, 5), null, 'organize.'),
			],
			options({ 'no-h1-in-body': 'info', 'australian-spelling': 'error' }),
		);

		expect(shapes(result)).toEqual([
			['australian-spelling', 'error', FILE, 20, 5],
			['no-h1-in-body', 'info', FILE, 12, 3],
		]);
		expect(result.envelope.summary.errors).toBe(1);
		expect(result.envelope.summary.infos).toBe(1);
	});

	test('a rule set to off produces no finding at all', () => {
		const result = runLint(
			[raw('no-h1-in-body', at(FILE, 12, 3), null, 'A second h1.')],
			options({ 'no-h1-in-body': 'off' }),
		);
		expect(result.envelope.findings).toEqual([]);
		expect(result.envelope.summary.errors).toBe(0);
	});

	test('the corpus config own two declarations are honoured as written', () => {
		// The fixture project raises `australian-spelling` outright and raises
		// `description-is-a-sentence` for English only. Running the real table is what
		// catches a resolver that only works against a config a test wrote for it.
		const result = runLint(
			[
				raw('australian-spelling', at(FILE, 4, 1), 'en', 'organize.'),
				raw('description-is-a-sentence', at(FILE, 5, 1), 'en', 'No full stop.'),
				raw('description-is-a-sentence', at(OTHER_FILE, 6, 1), 'fr', 'No full stop.'),
			],
			{ config: FIXTURE_CONFIG, disables: [], kitVersion: KIT_VERSION },
		);

		expect(FIXTURE_CONFIG.lint.rules?.['australian-spelling']).toBe('warning');
		expect(FIXTURE_CONFIG.lint.rules?.['description-is-a-sentence']).toEqual({
			severity: 'warning',
			locales: ['en'],
		});
		expect(shapes(result)).toEqual([
			['australian-spelling', 'warning', FILE, 4, 1],
			['description-is-a-sentence', 'warning', FILE, 5, 1],
			['description-is-a-sentence', 'info', OTHER_FILE, 6, 1],
		]);
	});

	test('every finding carries the registry consequence for its rule', () => {
		// The consequence is copied onto the finding rather than fetched later, because an
		// agent that has to ask why will instead guess. A rule whose consequence went
		// missing would still report, and would report a sentence nobody wrote.
		const finding = only(
			runLint([raw('link-resolves', at(FILE, 9, 2), null, 'Dead link.')], options()),
		);
		expect(finding.consequence).toBe(RULE_DEFINITIONS['link-resolves'].consequence);
		expect(finding.category).toBe(RULE_CATEGORIES['link-resolves']);
	});
});

// ---------------------------------------------------------------------------
// Protected rules
// ---------------------------------------------------------------------------

describe('a protected rule is not the project decision', () => {
	// Every way a config can name a rule. `off` and the two lower severities are the
	// settings the schema refuses; the runner has to refuse them too, because a config can
	// reach it from a branch, from a hand edit, or from a caller that skipped the schema.
	const LOWERING: RuleSetting[] = [
		'off',
		'warning',
		'info',
		{ severity: 'info' },
		{ severity: 'warning', locales: ['en'] },
		{ severity: 'info', locales: [] },
	];

	test('every protected rule stays at error however the config sets it', () => {
		let swept = 0;
		for (const rule of PROTECTED_RULES) {
			for (const setting of LOWERING) {
				const result = runLint(
					[raw(rule, at(FILE, 7, 1), 'en', 'A planted violation.')],
					options({ [rule]: setting }),
				);
				expect([rule, setting, shape(only(result))]).toEqual([
					rule,
					setting,
					[rule, 'error', FILE, 7, 1],
				]);
				swept += 1;
			}
		}
		expect(swept).toBe(PROTECTED_RULES.length * LOWERING.length);
		expect(PROTECTED_RULES.length).toBeGreaterThan(0);
	});

	test('the same settings do lower an unprotected rule, so the sweep above is not vacuous', () => {
		// Without this the sweep would pass against a runner that ignored the config
		// entirely, which is the opposite bug and just as bad.
		let swept = 0;
		for (const setting of LOWERING) {
			const result = runLint(
				[raw('no-h1-in-body', at(FILE, 7, 1), 'en', 'A second h1.')],
				options({ 'no-h1-in-body': setting }),
			);
			const expected = typeof setting === 'string' ? setting : setting.severity;
			expect([setting, result.envelope.findings.map((finding) => finding.severity)]).toEqual([
				setting,
				expected === 'off' ? [] : [expected],
			]);
			swept += 1;
		}
		expect(swept).toBe(LOWERING.length);
	});
});

// ---------------------------------------------------------------------------
// Locale-narrowed overrides
// ---------------------------------------------------------------------------

describe('a rule config with a locales list', () => {
	test('narrows the override to those locales and leaves the rest at the default', () => {
		const fallback = RULE_DEFINITIONS['australian-spelling'].defaultSeverity;
		const result = runLint(
			[
				raw('australian-spelling', at(OTHER_FILE, 3, 1), 'fr', 'Listed locale.'),
				raw('australian-spelling', at(FILE, 4, 1), 'en', 'Unlisted locale.'),
				raw('australian-spelling', at('docs.json', 5, 1), null, 'No locale at all.'),
			],
			options({ 'australian-spelling': { severity: 'error', locales: ['fr'] } }),
		);

		expect(fallback).not.toBe('error');
		expect(shapes(result)).toEqual([
			['australian-spelling', 'error', OTHER_FILE, 3, 1],
			['australian-spelling', fallback, FILE, 4, 1],
			['australian-spelling', fallback, 'docs.json', 5, 1],
		]);
	});

	test('a finding with no locale resolves against the source locale', () => {
		// `null` is not "every locale". A project-level finding is about the source text, so
		// a list naming the source locale has to cover it and a list that does not must not.
		const covering = runLint(
			[raw('australian-spelling', at('docs.json', 1, 1), null, 'x')],
			options({ 'australian-spelling': { severity: 'error', locales: [SOURCE_LOCALE] } }),
		);
		expect(only(covering).severity).toBe('error');

		const notCovering = runLint(
			[raw('australian-spelling', at('docs.json', 1, 1), null, 'x')],
			options({ 'australian-spelling': { severity: 'error', locales: ['ja'] } }),
		);
		expect(only(notCovering).severity).toBe(
			RULE_DEFINITIONS['australian-spelling'].defaultSeverity,
		);
	});

	test('an empty locales list means every locale, not none of them', () => {
		const locales: Locale[] = ['en', 'ja'];
		const result = runLint(
			locales.map((locale, index) =>
				raw('australian-spelling', at(FILE, index + 1, 1), locale, 'x'),
			),
			options({ 'australian-spelling': { severity: 'error', locales: [] } }),
		);
		expect(result.envelope.findings.map((finding) => finding.severity)).toEqual(['error', 'error']);
	});
});

// ---------------------------------------------------------------------------
// The parity override
// ---------------------------------------------------------------------------

describe('the parity override, which the config cannot express', () => {
	const missing = (): RawFinding =>
		raw('translation-missing', at(FILE, 1, 1), 'ja', 'No Japanese file.');

	test('translation-missing stays at its default under graceful parity', () => {
		expect(FIXTURE_CONFIG.i18n.parity).toBe('graceful');
		const finding = only(runLint([missing()], options()));
		expect(finding.severity).toBe(RULE_DEFINITIONS['translation-missing'].defaultSeverity);
		expect(finding.severity).not.toBe('error');
	});

	test('translation-missing becomes an error under required parity', () => {
		const finding = only(
			runLint([missing()], options({}, { overrides: { 'translation-missing': 'error' } })),
		);
		expect(shape(finding)).toEqual(['translation-missing', 'error', FILE, 1, 1]);
		expect(finding.locale).toBe('ja');
	});

	test('the override outranks a project that switched the rule off', () => {
		// Required parity is the mode a project chose. A rule it also set to `off` must not
		// be the way back out of it, or the mode means nothing.
		const result = runLint(
			[missing()],
			options({ 'translation-missing': 'off' }, { overrides: { 'translation-missing': 'error' } }),
		);
		expect(only(result).severity).toBe('error');
	});

	test('the override is a floor, so a config that raised higher keeps its severity', () => {
		// The comparison here is the one that is easy to write backwards. `SEVERITIES` runs
		// worst first, so a smaller index is more severe, and an override that took the
		// larger index would quietly demote every rule a project had raised.
		const result = runLint(
			[raw('translation-stale', at(FILE, 2, 1), 'ja', 'Older than the source.')],
			options({ 'translation-stale': 'error' }, { overrides: { 'translation-stale': 'warning' } }),
		);
		expect(only(result).severity).toBe('error');
	});

	test('a rule with no override is untouched by the presence of one', () => {
		const result = runLint(
			[raw('translation-stale', at(FILE, 2, 1), 'ja', 'Older than the source.')],
			options({}, { overrides: { 'translation-missing': 'error' } }),
		);
		expect(only(result).severity).toBe(RULE_DEFINITIONS['translation-stale'].defaultSeverity);
	});
});

// ---------------------------------------------------------------------------
// Checks, which are not rules
// ---------------------------------------------------------------------------

describe('a check id is not configurable', () => {
	test('a wiring check reports as an error carrying its own consequence', () => {
		const finding = only(
			runLint(
				[raw('wiring-submodule', { kind: 'project' }, null, 'The submodule is not here.')],
				options(),
			),
		);
		expect([finding.rule, finding.severity, finding.category]).toEqual([
			'wiring-submodule',
			'error',
			'wiring',
		]);
		// From `CHECK_DEFINITIONS`, not from the runner. Every check used to share one
		// sentence, `The package cannot do its job in this state.`, which is true of all
		// eighteen and useful about none of them.
		expect(finding.consequence).toBe(CHECK_DEFINITIONS['wiring-submodule'].consequence);
	});

	test('the category comes from the table, not from the id prefix', () => {
		// `source-layout` is the case a prefix test gets wrong: it begins with neither
		// `wiring-` nor `bundle-`, so it fell through to `config` and a filter by category
		// could not find the one category it belongs to.
		const finding = only(
			runLint(
				[
					raw(
						'source-layout',
						{ kind: 'file', file: 'docs/site/stray.png' },
						null,
						'Not markdown.',
					),
				],
				options(),
			),
		);
		expect(finding.category).toBe('structure');
		expect(CHECK_DEFINITIONS['source-layout'].category).toBe('structure');
	});

	test('every check has a definition, a distinct consequence and a plural unit', () => {
		// The exhaustiveness is a typecheck (`satisfies Record<CheckId, CheckDefinition>`),
		// so what is left to assert is that the entries say something. A table satisfying
		// the type with eighteen copies of one sentence would compile.
		const consequences = new Set<string>();
		for (const id of CHECK_IDS) {
			const definition = CHECK_DEFINITIONS[id];
			expect(definition.id).toBe(id);
			expect(definition.title.length).toBeGreaterThan(20);
			expect(definition.consequence.length).toBeGreaterThan(60);
			expect(definition.unit).toMatch(/^[a-z][a-z ]+s$/);
			consequences.add(definition.consequence);
		}
		expect(consequences.size).toBe(CHECK_IDS.length);
	});

	test('a bundle check takes the bundle category', () => {
		const finding = only(
			runLint(
				[raw('bundle-missing-object', { kind: 'file', file: 'manifest.json' }, null, 'Gone.')],
				options(),
			),
		);
		expect([finding.rule, finding.severity, finding.category]).toEqual([
			'bundle-missing-object',
			'error',
			'bundle',
		]);
	});
});

// ---------------------------------------------------------------------------
// Suppression comments
// ---------------------------------------------------------------------------

describe('a suppression comment drops the finding on the line below it', () => {
	test('the line above drops it, a different rule does not, and the same line does not', () => {
		const entries: RawFinding[] = [
			raw('no-h1-in-body', at(FILE, 12, 1), null, 'Suppressed.'),
			raw('no-h1-in-body', at(FILE, 20, 1), null, 'Named rule does not match.'),
			raw('no-h1-in-body', at(FILE, 30, 1), null, 'Comment sits on this line.'),
			raw('no-h1-in-body', at(FILE, 40, 1), null, 'Comment is in another file.'),
		];
		const disables = [
			disable(FILE, 11, 'no-h1-in-body', 'The reference index really does open with an h1.'),
			disable(FILE, 19, 'australian-spelling', 'A different rule, on the right line.'),
			disable(FILE, 30, 'no-h1-in-body', 'The right rule, on the finding own line.'),
			disable(OTHER_FILE, 39, 'no-h1-in-body', 'The right rule and line, wrong file.'),
		];

		const result = runLint(entries, options({}, { disables }));

		// The infos in the same list are the notices about the three comments that dropped
		// nothing, which the next block covers. What matters here is which findings survived.
		expect(shapes(result).filter(([, severity]) => severity === 'error')).toEqual([
			['no-h1-in-body', 'error', FILE, 20, 1],
			['no-h1-in-body', 'error', FILE, 30, 1],
			['no-h1-in-body', 'error', FILE, 40, 1],
		]);
		expect(result.unusedDisables.map((comment) => [comment.file, comment.line])).toEqual([
			[FILE, 19],
			[FILE, 30],
			[OTHER_FILE, 39],
		]);
	});

	test('one comment covers every finding of that rule on the line below it', () => {
		const result = runLint(
			[
				raw('no-h1-in-body', at(FILE, 8, 1), null, 'First.'),
				raw('no-h1-in-body', at(FILE, 8, 40), null, 'Second, same line.'),
			],
			options(
				{},
				{ disables: [disable(FILE, 7, 'no-h1-in-body', 'Two on one line, both known.')] },
			),
		);
		expect(result.envelope.findings).toEqual([]);
		expect(result.unusedDisables).toEqual([]);
	});

	test('a finding with no line cannot be suppressed by a comment near it', () => {
		// A file-level or project-level finding has nothing for a next-line comment to sit
		// above. Matching one on a missing line would let a comment anywhere in the file
		// silence a finding about the whole file.
		const result = runLint(
			[raw('orphan-page', { kind: 'file', file: FILE }, null, 'Not in the nav.')],
			options(
				{},
				{ disables: [disable(FILE, 0, 'orphan-page', 'A comment with nowhere to sit.')] },
			),
		);
		expect(result.envelope.findings.map((finding) => finding.rule)).toEqual([
			'orphan-page',
			'orphan-page',
		]);
		expect(result.unusedDisables).toHaveLength(1);
	});

	test('the caller list is not mutated, so a second run sees the same comments', () => {
		// `used` is written during a run. Writing it onto the caller's objects would make a
		// second run over the same project report every suppression as already used.
		const disables = [disable(FILE, 11, 'no-h1-in-body', 'The reason this line is exempt.')];
		runLint([raw('no-h1-in-body', at(FILE, 12, 1), null, 'x')], options({}, { disables }));
		expect(disables[0]?.used).toBe(false);
	});
});

describe('a suppression that dropped nothing', () => {
	test('is reported at info whatever the rule it names resolves to, with the reason as the excerpt', () => {
		const reason = 'Left over from a paragraph that was rewritten in March.';
		const result = runLint(
			[],
			options({}, { disables: [disable(FILE, 14, 'no-em-dash', reason)] }),
		);

		const finding = only(result);
		expect(shape(finding)).toEqual(['no-em-dash', 'info', FILE, 14, 0]);
		// `no-em-dash` is protected and resolves to `error` for every project. A stale
		// comment inheriting that would block a publish over a line nobody has a problem
		// with, which is the opposite of what a suppression is for.
		expect(PROTECTED_RULES).toContain('no-em-dash');
		expect(finding.category).toBe(RULE_CATEGORIES['no-em-dash']);
		expect(finding.excerpt).toBe(reason);
		expect(finding.locale).toBeNull();
		expect(finding.suggestion).toBeNull();
		expect(result.envelope.summary.infos).toBe(1);
		expect(result.envelope.summary.errors).toBe(0);
	});

	test('takes its category from whichever id space names the rule', () => {
		const result = runLint(
			[],
			options(
				{},
				{
					disables: [
						disable(FILE, 1, 'no-em-dash', 'A configurable rule, so the rule table has it.'),
						disable(FILE, 2, 'bundle-missing-object', 'A check id, categorised by prefix.'),
						disable(FILE, 3, 'invented-rule', 'A name neither space knows.'),
					],
				},
			),
		);
		expect(result.envelope.findings.map((finding) => [finding.rule, finding.category])).toEqual([
			['no-em-dash', 'house-style'],
			['bundle-missing-object', 'bundle'],
			['invented-rule', 'config'],
		]);
	});

	test('a comment that did drop something is neither reported nor returned', () => {
		const result = runLint(
			[raw('no-h1-in-body', at(FILE, 12, 1), null, 'x')],
			options({}, { disables: [disable(FILE, 11, 'no-h1-in-body', 'A reason worth reading.')] }),
		);
		expect(result.envelope.findings).toEqual([]);
		expect(result.unusedDisables).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// maxDisables
// ---------------------------------------------------------------------------

describe('the suppression cap', () => {
	const capMessage = (result: LintRunResult): string | undefined =>
		result.envelope.findings.find((finding) => finding.message.includes('suppression comments'))
			?.message;

	test('a project at the cap is fine', () => {
		const disables = [
			disable(FILE, 11, 'no-h1-in-body', 'One reason.'),
			disable(FILE, 21, 'no-h1-in-body', 'Another reason.'),
		];
		const result = runLint(
			[
				raw('no-h1-in-body', at(FILE, 12, 1), null, 'x'),
				raw('no-h1-in-body', at(FILE, 22, 1), null, 'x'),
			],
			options({}, { disables, maxDisables: 2 }),
		);
		expect(result.envelope.findings).toEqual([]);
		expect(capMessage(result)).toBeUndefined();
	});

	test('one over the cap is an error naming both numbers', () => {
		const disables = [
			disable(FILE, 11, 'no-h1-in-body', 'One reason.'),
			disable(FILE, 21, 'no-h1-in-body', 'Another reason.'),
			disable(FILE, 31, 'no-h1-in-body', 'A third reason.'),
		];
		const result = runLint(
			[
				raw('no-h1-in-body', at(FILE, 12, 1), null, 'x'),
				raw('no-h1-in-body', at(FILE, 22, 1), null, 'x'),
				raw('no-h1-in-body', at(FILE, 32, 1), null, 'x'),
			],
			options({}, { disables, maxDisables: 2 }),
		);

		const finding = only(result);
		expect([finding.severity, finding.category, finding.location]).toEqual([
			'error',
			'config',
			{ kind: 'file', file: 'docs.json' },
		]);
		expect(finding.message).toContain('3 suppression comments');
		expect(finding.message).toContain('cap is 2');
		expect(finding.remediation).toContain('lint.maxDisables');
	});

	test('a comment counts against the cap whether or not it dropped anything', () => {
		// The cap is over comments carried, not over comments that worked. Counting only the
		// used ones would make deleting the findings, rather than the comments, the way to
		// get back under it.
		const result = runLint(
			[],
			options(
				{},
				{
					disables: [
						disable(FILE, 11, 'no-h1-in-body', 'Dropped nothing.'),
						disable(FILE, 21, 'no-h1-in-body', 'Dropped nothing either.'),
					],
					maxDisables: 1,
				},
			),
		);
		expect(result.unusedDisables).toHaveLength(2);
		expect(capMessage(result)).toContain('2 suppression comments');
	});
});

// ---------------------------------------------------------------------------
// Identical findings
// ---------------------------------------------------------------------------

describe('two findings that say the same thing in the same place are one finding', () => {
	test('a project-level fact reported once per file is reported once', () => {
		// A rule that reads prose runs once per file, so a fact about the project rather than
		// about a page arrives once for every file in the tree. Fifty-one copies of one
		// sentence is a report nobody reads, with a summary claiming fifty-one problems.
		const entries = Array.from({ length: 51 }, () =>
			raw('internal-leak', { kind: 'project' }, null, 'There is no deny list.'),
		);
		const result = runLint(entries, options());
		expect(result.envelope.findings).toHaveLength(1);
		expect(result.envelope.summary.errors).toBe(1);
	});

	test('two findings that differ in the column alone are two findings', () => {
		// The collapse has to be exact. Two hits on one line are two things to fix, and a
		// reader who fixes the first and re-runs must not be told the second one is new.
		const result = runLint(
			[
				raw('no-em-dash', at(FILE, 8, 3), null, 'A banned character.'),
				raw('no-em-dash', at(FILE, 8, 41), null, 'A banned character.'),
			],
			options(),
		);
		expect(shapes(result)).toEqual([
			['no-em-dash', 'error', FILE, 8, 3],
			['no-em-dash', 'error', FILE, 8, 41],
		]);
	});

	test('two findings that differ in the message alone are two findings', () => {
		const result = runLint(
			[
				raw('link-resolves', at(FILE, 8, 3), null, 'No page has the slug "guide/setup".'),
				raw('link-resolves', at(FILE, 8, 3), null, 'No page has the slug "guide/pairing".'),
			],
			options(),
		);
		expect(result.envelope.findings).toHaveLength(2);
		expect(result.envelope.summary.errors).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

describe('the findings come back in compareFindings order', () => {
	// Worst first, then by category, then by file, then by line, then by rule. Every tier is
	// exercised: two errors that differ only by rule on one line, two categories inside one
	// severity, and three severities.
	const SORTED: [string, Severity, string, number, number][] = [
		['code-fence-language', 'error', 'b.md', 5, 1],
		['no-h1-in-body', 'error', 'b.md', 5, 9],
		['no-decorative-unicode', 'error', 'a.md', 9, 2],
		['no-em-dash', 'error', 'a.md', 9, 7],
		['link-resolves', 'error', 'a.md', 3, 1],
		['heading-depth', 'warning', 'a.md', 2, 1],
		['orphan-page', 'warning', 'z.md', 1, 1],
		['no-triad', 'info', 'a.md', 4, 1],
	];

	// A fixed permutation rather than a random one, so a failure is reproducible. It is not
	// the sorted order in any tier, which is what makes a dropped sort fail here.
	const SHUFFLED = [7, 4, 1, 6, 2, 5, 3, 0].map((index) => {
		const row = SORTED[index];
		if (row === undefined) throw new Error('the shuffle names a row that is not there');
		return row;
	});

	test('a shuffled input comes back in the documented order', () => {
		expect(SHUFFLED.map((row) => row[0])).not.toEqual(SORTED.map((row) => row[0]));

		const result = runLint(
			SHUFFLED.map(([rule, , file, line, column]) =>
				raw(rule as LintRuleId, at(file, line, column), null, 'x'),
			),
			options({
				'code-fence-language': 'error',
				'no-h1-in-body': 'error',
				'no-decorative-unicode': 'error',
				'no-em-dash': 'error',
				'link-resolves': 'error',
				'heading-depth': 'warning',
				'orphan-page': 'warning',
				'no-triad': 'info',
			}),
		);

		expect(shapes(result)).toEqual(SORTED);
	});

	test('the returned list is non-decreasing under the comparator itself', () => {
		// The hand-written order above is the expectation; this is the invariant, and the two
		// disagreeing is a comparator change nobody meant to make.
		const result = runLint(
			SHUFFLED.map(([rule, , file, line, column]) =>
				raw(rule as LintRuleId, at(file, line, column), null, 'x'),
			),
			options(),
		);
		const findings = result.envelope.findings;
		let compared = 0;
		for (let index = 1; index < findings.length; index += 1) {
			const previous = findings[index - 1];
			const current = findings[index];
			if (previous === undefined || current === undefined) throw new Error('short list');
			expect(compareFindings(previous, current)).toBeLessThanOrEqual(0);
			compared += 1;
		}
		expect(compared).toBe(SORTED.length - 1);
	});
});

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

describe('summary.passing counts rules that ran and found nothing', () => {
	test('a clean run passes every rule the project has on', () => {
		const result = runLint([], options());
		expect(result.envelope.summary).toEqual({
			errors: 0,
			warnings: 0,
			infos: 0,
			passing: LINT_RULE_IDS.length,
		});
		expect(LINT_RULE_IDS.length).toBeGreaterThan(0);
	});

	test('a rule that fired is not passing, and a rule that is off is not either', () => {
		const result = runLint(
			[raw('no-h1-in-body', at(FILE, 12, 1), null, 'x')],
			options({ 'heading-depth': 'off', 'orphan-page': 'off' }),
		);
		// One firing plus two switched off. Derived from the id list rather than written as a
		// number, so a rule added to the contract moves this with it.
		expect(result.envelope.summary.passing).toBe(LINT_RULE_IDS.length - 3);
		expect(result.envelope.summary.errors).toBe(1);
	});

	test('a rule that is off and would have fired is counted once, not twice', () => {
		const result = runLint(
			[raw('heading-depth', at(FILE, 12, 1), null, 'x')],
			options({ 'heading-depth': 'off' }),
		);
		expect(result.envelope.findings).toEqual([]);
		expect(result.envelope.summary.passing).toBe(LINT_RULE_IDS.length - 1);
	});

	test('a check that fired does not come out of the rule count', () => {
		// Checks are a separate id space with no severity to configure, so a wiring failure
		// says nothing about how many rules passed.
		const result = runLint([raw('wiring-submodule', { kind: 'project' }, null, 'x')], options());
		expect(result.envelope.summary.passing).toBe(LINT_RULE_IDS.length);
		expect(result.envelope.summary.errors).toBe(1);
	});

	test('the counts are over the whole list, not over the truncated one', () => {
		const entries = Array.from({ length: MAX_FINDINGS + 3 }, (_unused, index) =>
			raw('no-h1-in-body', at(FILE, index + 1, 1), null, 'x'),
		);
		const result = runLint(entries, options());
		expect(result.envelope.summary.errors).toBe(MAX_FINDINGS + 3);
		expect(result.envelope.findings).toHaveLength(MAX_FINDINGS);
	});

	test('the kit version is carried through verbatim', () => {
		expect(runLint([], options()).envelope.kitVersion).toBe(KIT_VERSION);
	});
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe('truncated', () => {
	const errors = (count: number): RawFinding[] =>
		Array.from({ length: count }, (_unused, index) =>
			raw('no-h1-in-body', at(FILE, index + 1, 1), null, 'x'),
		);

	test('a list exactly at the limit is not truncated', () => {
		const result = runLint(errors(MAX_FINDINGS), options());
		expect(result.envelope.truncated).toBe(false);
		expect(result.envelope.findings).toHaveLength(MAX_FINDINGS);
	});

	test('one over the limit is truncated to exactly the limit', () => {
		const result = runLint(errors(MAX_FINDINGS + 1), options());
		expect(result.envelope.truncated).toBe(true);
		expect(result.envelope.findings).toHaveLength(MAX_FINDINGS);
	});

	test('what survives truncation is the worst of the list, because the sort came first', () => {
		// A truncation applied before the sort would keep whichever findings happened to be
		// discovered first, and the report would open on an info while an error went unsent.
		const entries = [
			...Array.from({ length: MAX_FINDINGS }, (_unused, index) =>
				raw('no-triad', at(FILE, index + 1, 1), null, 'info finding'),
			),
			raw('link-resolves', at(FILE, MAX_FINDINGS + 1, 1), null, 'error finding'),
		];
		const result = runLint(entries, options());
		expect(result.envelope.truncated).toBe(true);
		expect(result.envelope.findings).toHaveLength(MAX_FINDINGS);
		expect(shape(result.envelope.findings[0] as Finding)).toEqual([
			'link-resolves',
			'error',
			FILE,
			MAX_FINDINGS + 1,
			1,
		]);
		expect(result.envelope.findings.filter((finding) => finding.rule === 'no-triad')).toHaveLength(
			MAX_FINDINGS - 1,
		);
	});
});

// ---------------------------------------------------------------------------
// nextAction
// ---------------------------------------------------------------------------

describe('nextAction names one thing to do', () => {
	test('it names the first error and the file it is in', () => {
		const result = runLint(
			[
				raw('no-triad', at('a.md', 1, 1), null, 'x'),
				raw('link-resolves', at('b.md', 4, 1), null, 'x'),
				raw('link-resolves', at('c.md', 9, 1), null, 'x'),
			],
			options(),
		);
		const action = result.envelope.nextAction;
		expect(action.kind).toBe('command');
		if (action.kind !== 'command') throw new Error('expected a command');
		expect(action.argv).toEqual(['hexdocs', 'check', 'b.md']);
		expect(action.why).toContain('2 errors block a publish');
		expect(action.why).toContain('"link-resolves" in b.md');
		expect(action.why).not.toContain('truncated');
	});

	test('an error with no file names the project rather than an empty string', () => {
		const result = runLint([raw('wiring-submodule', { kind: 'project' }, null, 'x')], options());
		const action = result.envelope.nextAction;
		if (action.kind !== 'command') throw new Error('expected a command');
		expect(action.argv).toEqual(['hexdocs', 'check', 'the project']);
		expect(action.why).toContain('"wiring-submodule" in the project');
	});

	test('a truncated list says so, because the count is the whole list and the report is not', () => {
		const result = runLint(
			Array.from({ length: MAX_FINDINGS + 2 }, (_unused, index) =>
				raw('link-resolves', at(FILE, index + 1, 1), null, 'x'),
			),
			options(),
		);
		const action = result.envelope.nextAction;
		if (action.kind !== 'command') throw new Error('expected a command');
		expect(action.why).toContain(`${MAX_FINDINGS + 2} errors block a publish`);
		expect(action.why).toContain('The list is truncated: fix these and run it again.');
	});

	test('warnings alone do not block a publish and get no command', () => {
		const result = runLint(
			[
				raw('heading-depth', at('a.md', 1, 1), null, 'x'),
				raw('orphan-page', at('b.md', 1, 1), null, 'x'),
				raw('no-triad', at('c.md', 1, 1), null, 'x'),
			],
			options(),
		);
		const action = result.envelope.nextAction;
		expect(action.kind).toBe('none');
		expect(action.why).toContain('Nothing blocks a publish.');
		expect(action.why).toContain('2 warnings');
	});

	test('a clean run has nothing to do', () => {
		expect(runLint([], options()).envelope.nextAction).toEqual({
			kind: 'none',
			why: 'Nothing to do.',
		});
	});

	test('an info-only run has nothing to do either', () => {
		// `info` is advice. A next action pointing at one would make every run look like it
		// needed something, and the field would stop being read.
		const result = runLint([raw('no-triad', at('a.md', 1, 1), null, 'x')], options());
		expect(result.envelope.nextAction).toEqual({ kind: 'none', why: 'Nothing to do.' });
	});
});
