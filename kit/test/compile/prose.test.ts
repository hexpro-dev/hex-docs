import { describe, expect, test } from 'vitest';

import {
	LINT_RULE_IDS,
	PROTECTED_RULES,
	BANNED_CHARACTERS,
	RULE_CATEGORIES,
	type LintRuleId,
} from '../../../src/contracts/lint.js';
import { SEVERITIES } from '../../../src/contracts/diagnostics.js';
import {
	DEFAULT_BUDGETS,
	DOCS_CONFIG_VERSION,
	type DenyList,
	type DocsProjectConfig,
} from '../../../src/contracts/project.js';
import type { Locale } from '../../../src/contracts/locales.js';
import type {
	FoldedText,
	ProseKind,
	ProseSegment,
	RawFinding,
	SourceRun,
} from '../../src/compile/types.js';
import { RULE_DEFINITIONS, resolveSeverity } from '../../src/compile/lint/registry.js';
import {
	DECORATIVE_CODE_POINTS,
	DENY_LIST_PATH,
	PROSE_RULES,
	splitSentences,
	type ProseRule,
	type ProseRuleContext,
} from '../../src/compile/lint/prose.js';

// ---------------------------------------------------------------------------
// Building a segment by hand
// ---------------------------------------------------------------------------

/**
 * Folds source lines the way the parser does: one run per line, joined by one space.
 *
 * Written out here rather than imported, so the position assertions below are assertions
 * about this file's own arithmetic. A helper that shared its implementation with the
 * thing under test would agree with it whatever either of them did.
 */
function fold(lines: readonly string[], firstLine = 1, column = 1): FoldedText {
	let text = '';
	const runs: SourceRun[] = [];
	for (const [index, body] of lines.entries()) {
		if (index > 0) text += ' ';
		runs.push({ offset: text.length, length: body.length, line: firstLine + index, column });
		text += body;
	}
	return { text, runs };
}

function segmentOf(
	lines: readonly string[],
	options: { kind?: ProseKind; firstLine?: number; column?: number; file?: string } = {},
): ProseSegment {
	return {
		file: options.file ?? 'content/en/guide/index.md',
		kind: options.kind ?? 'paragraph',
		folded: fold(lines, options.firstLine ?? 1, options.column ?? 1),
	};
}

/** One paragraph on one line, which is what most of these tests want. */
function paragraph(text: string): ProseSegment {
	return segmentOf([text]);
}

const PROJECT: DocsProjectConfig = {
	docs: DOCS_CONFIG_VERSION,
	project: 'fixture-app',
	productName: 'Fixture App',
	repo: 'hexpro-dev/fixture-app',
	defaultAudience: 'both',
	headingIds: 'slug',
	sections: [{ id: 'guide', kind: 'guide' }],
	i18n: { locales: ['en', 'es'], sourceLocale: 'en', parity: 'graceful' },
	budgets: DEFAULT_BUDGETS,
	code: { languages: ['text'] },
	toc: { enabled: true, maxDepth: 3, minHeadings: 3 },
	lint: { extends: 'house', maxDisables: 2 },
};

const DENY: DenyList = {
	private: 1,
	strings: ['Contoso Tap'],
	patterns: [
		{
			id: 'station-pack',
			pattern: 'station-pack-[a-z0-9-]+',
			flags: 'i',
			why: 'Names an internal test fixture directory.',
		},
	],
};

function contextOf(overrides: Partial<ProseRuleContext> = {}): ProseRuleContext {
	return {
		file: 'content/en/guide/index.md',
		locale: 'en',
		sourceLocale: 'en',
		project: PROJECT,
		denyList: DENY,
		// Empty unless a test supplies one. The deny rules read both this and the segments,
		// and a test that hands them a paragraph with no file behind it is exercising the
		// prose half on purpose.
		sourceLines: [],
		pageKind: 'article',
		isDraft: false,
		...overrides,
	};
}

function ruleFor(id: LintRuleId): ProseRule {
	const rule = PROSE_RULES[id];
	if (rule === undefined) throw new Error(`${id} has no implementation`);
	return rule;
}

function run(
	id: LintRuleId,
	segments: readonly ProseSegment[],
	overrides: Partial<ProseRuleContext> = {},
): RawFinding[] {
	return ruleFor(id)(segments, contextOf(overrides));
}

/** The line and column a finding points at, as one string, so a mismatch reads plainly. */
function positionOf(finding: RawFinding): string {
	const location = finding.location;
	if (location.kind !== 'file') return location.kind;
	return `${location.file}:${location.line}:${location.column}`;
}

const IMPLEMENTED = Object.keys(PROSE_RULES) as LintRuleId[];

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('the rule registry', () => {
	test('has one entry per rule id, keyed by its own id', () => {
		let examined = 0;
		for (const id of LINT_RULE_IDS) {
			const definition = RULE_DEFINITIONS[id];
			expect(definition, `${id} has no registry entry`).toBeDefined();
			expect(definition.id).toBe(id);
			examined += 1;
		}
		expect(examined).toBe(LINT_RULE_IDS.length);
		expect(Object.keys(RULE_DEFINITIONS).length).toBe(LINT_RULE_IDS.length);
	});

	test('every category matches the contract, rather than a second opinion of it', () => {
		for (const id of LINT_RULE_IDS) {
			expect(RULE_DEFINITIONS[id].category, id).toBe(RULE_CATEGORIES[id]);
		}
	});

	test('every protected rule defaults to error', () => {
		// A protected rule that defaulted to warning would be raiseable only, from a floor
		// that is already too low, and the schema check on the config would never see it.
		let examined = 0;
		for (const id of PROTECTED_RULES) {
			expect(RULE_DEFINITIONS[id].defaultSeverity, id).toBe('error');
			examined += 1;
		}
		expect(examined).toBe(PROTECTED_RULES.length);
	});

	test('every entry carries a title, a consequence and at least one example pair', () => {
		for (const id of LINT_RULE_IDS) {
			const definition = RULE_DEFINITIONS[id];
			expect(SEVERITIES).toContain(definition.defaultSeverity);
			expect(definition.title.length, id).toBeGreaterThan(10);
			expect(definition.title.endsWith('.'), `${id} title is not a sentence`).toBe(true);
			expect(definition.consequence.length, id).toBeGreaterThan(60);
			expect(definition.examples.length, id).toBeGreaterThan(0);
			for (const example of definition.examples) {
				expect(example.bad.length, id).toBeGreaterThan(0);
				expect(example.good.length, id).toBeGreaterThan(0);
				expect(example.bad, id).not.toBe(example.good);
			}
		}
	});

	test('a heuristic rule never defaults to error', () => {
		// The reason the split exists: error blocks a publish, and a project cannot argue
		// with a rule that reads rhythm.
		const heuristic: LintRuleId[] = [
			'no-triad',
			'no-symmetric-pairs',
			'australian-spelling',
			'no-hedging-stack',
			'no-filler-verb-stack',
			'no-rhetorical-opener',
			'description-is-a-sentence',
		];
		for (const id of heuristic) {
			expect(RULE_DEFINITIONS[id].defaultSeverity, id).not.toBe('error');
		}
		expect(heuristic.length).toBe(7);
	});
});

describe('resolveSeverity', () => {
	test('falls back to the registry default', () => {
		expect(resolveSeverity('no-triad', undefined, 'en')).toBe('info');
		expect(resolveSeverity('orphan-page', { extends: 'house', maxDisables: 0 }, 'en')).toBe(
			'warning',
		);
	});

	test('applies a plain override, including off', () => {
		const lint: DocsProjectConfig['lint'] = {
			extends: 'house',
			maxDisables: 0,
			rules: { 'no-triad': 'error', 'orphan-page': 'off' },
		};
		expect(resolveSeverity('no-triad', lint, 'en')).toBe('error');
		expect(resolveSeverity('orphan-page', lint, 'en')).toBe('off');
	});

	test('honours the locales an override names, and leaves the rest at the default', () => {
		const lint: DocsProjectConfig['lint'] = {
			extends: 'house',
			maxDisables: 0,
			rules: { 'australian-spelling': { severity: 'error', locales: ['en'] } },
		};
		expect(resolveSeverity('australian-spelling', lint, 'en')).toBe('error');
		expect(resolveSeverity('australian-spelling', lint, 'ja')).toBe('info');
	});

	test('an empty locale list means every locale', () => {
		const lint: DocsProjectConfig['lint'] = {
			extends: 'house',
			maxDisables: 0,
			rules: { 'no-triad': { severity: 'warning', locales: [] } },
		};
		for (const locale of ['en', 'ja'] as Locale[]) {
			expect(resolveSeverity('no-triad', lint, locale)).toBe('warning');
		}
	});

	test('refuses to lower a protected rule, whatever the config says', () => {
		// The schema already refuses such a config. This is the second half of the same
		// guarantee: a config that reached the runner without passing the schema must not be
		// able to switch off internal-leak.
		const lint: DocsProjectConfig['lint'] = {
			extends: 'house',
			maxDisables: 0,
			rules: {
				'internal-leak': 'off',
				'no-em-dash': 'info',
				'no-banned-phrase': { severity: 'warning', locales: ['en'] },
			},
		};
		let examined = 0;
		for (const id of PROTECTED_RULES) {
			expect(resolveSeverity(id, lint, 'en'), id).toBe('error');
			expect(resolveSeverity(id, lint, 'ja'), id).toBe('error');
			examined += 1;
		}
		expect(examined).toBe(PROTECTED_RULES.length);
	});
});

describe('the implemented rules and the registry agree', () => {
	test('every implemented id is a lint rule with an entry', () => {
		expect(IMPLEMENTED.length).toBe(13);
		for (const id of IMPLEMENTED) {
			expect(LINT_RULE_IDS, id).toContain(id);
			expect(RULE_DEFINITIONS[id].id).toBe(id);
		}
	});

	test.each(IMPLEMENTED)('the registry example for %s really trips it', (id) => {
		const definition = RULE_DEFINITIONS[id];
		let examined = 0;
		for (const example of definition.examples) {
			const bad = run(id, [segmentOf(example.bad.split('\n'))]);
			expect(bad.length, `${id}: the bad example produced nothing`).toBeGreaterThan(0);
			expect(bad.every((finding) => finding.rule === id)).toBe(true);

			const good = run(id, [segmentOf(example.good.split('\n'))]);
			expect(good.map((finding) => finding.message).join(' | '), `${id}: good example`).toBe('');
			examined += 1;
		}
		expect(examined).toBe(definition.examples.length);
	});
});

// ---------------------------------------------------------------------------
// The character partition
// ---------------------------------------------------------------------------

describe('the three character rules partition the banned set', () => {
	const CHARACTER_RULES: LintRuleId[] = ['no-em-dash', 'no-en-dash-prose', 'no-decorative-unicode'];

	test('every banned character is owned by exactly one rule', () => {
		let examined = 0;
		for (const entry of BANNED_CHARACTERS) {
			// Letters either side, so the en dash rule's numeric exception does not apply and
			// every character is in the state its rule is meant to catch.
			const text = `a${String.fromCodePoint(entry.codePoint)}b`;
			const owners = CHARACTER_RULES.filter((id) => run(id, [paragraph(text)]).length > 0);
			expect(owners.length, `U+${entry.codePoint.toString(16)} ${entry.name}`).toBe(1);
			examined += 1;
		}
		expect(examined).toBe(BANNED_CHARACTERS.length);
	});

	test('the decorative set is the banned set minus the two dash rules', () => {
		const dashes = BANNED_CHARACTERS.filter(
			(entry) => !DECORATIVE_CODE_POINTS.includes(entry.codePoint),
		);
		expect(dashes.map((entry) => entry.name).sort()).toEqual([
			'em dash',
			'en dash',
			'horizontal bar',
		]);
		expect(DECORATIVE_CODE_POINTS.length).toBe(BANNED_CHARACTERS.length - 3);
	});
});

// ---------------------------------------------------------------------------
// The rules, one at a time
// ---------------------------------------------------------------------------

describe('no-em-dash', () => {
	test('reports the line and column of the character, not the file', () => {
		const segment = segmentOf(
			[
				'Nobody has measured how long the session stays alive',
				'after the sheet is dismissed \u2014 the number came from a run.',
			],
			{ firstLine: 20, file: 'content/en/notes/scratch.md' },
		);
		const findings = run('no-em-dash', [segment]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/notes/scratch.md:21:30');
		expect(findings[0]?.message).toContain('U+2014');
		expect(findings[0]?.locale).toBe('en');
	});

	test('quotes nothing, because the quotation would be the banned character', () => {
		const findings = run('no-em-dash', [paragraph('One \u2014 two.')]);
		expect(findings[0]?.excerpt).toBeNull();
		expect(findings[0]?.remediation).not.toBeNull();
	});

	test('reports the horizontal bar as well as the em dash', () => {
		expect(run('no-em-dash', [paragraph('One \u2015 two.')]).length).toBe(1);
	});
});

describe('no-en-dash-prose', () => {
	test('reports an en dash between letters', () => {
		const findings = run('no-en-dash-prose', [
			segmentOf(['owns the radio \u2013 the codec owns the bytes'], { firstLine: 71 }),
		]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:71:16');
	});

	test('permits it between digits, which is the one place it is correct', () => {
		expect(run('no-en-dash-prose', [paragraph('The 2019\u20132024 revisions.')])).toEqual([]);
	});

	test('still reports a digit on one side only', () => {
		expect(run('no-en-dash-prose', [paragraph('The 2019\u2013revision.')]).length).toBe(1);
	});
});

describe('no-decorative-unicode', () => {
	test('reports an arrow used to mean "becomes"', () => {
		const findings = run('no-decorative-unicode', [
			segmentOf(['On a successful connect the state is polling \u2192 connected.'], {
				firstLine: 60,
			}),
		]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:60:46');
		expect(findings[0]?.message).toContain('rightwards arrow');
	});

	test('reports an emoji outside the basic plane at the right offset', () => {
		const findings = run('no-decorative-unicode', [paragraph('Ship it \u{1F680} now.')]);
		expect(findings.length).toBe(1);
		expect(findings[0]?.message).toContain('U+1F680');
	});

	test('leaves the dashes to the rules that own them', () => {
		expect(run('no-decorative-unicode', [paragraph('a \u2014 b \u2013 c')])).toEqual([]);
	});
});

describe('no-banned-phrase', () => {
	test('reports a house phrase where the author typed it', () => {
		const segment = segmentOf(
			[
				'`TagSession` owns the radio and the codec owns the bytes, and neither',
				'reaches across. Passing a payload between them is seamless because',
			],
			{ firstLine: 71 },
		);
		const findings = run('no-banned-phrase', [segment]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:72:51');
		expect(findings[0]?.message).toContain('seamless');
		expect(findings[0]?.excerpt).toContain('seamless');
	});

	test('reports a phrase the project added, with its replacement', () => {
		const lint: DocsProjectConfig['lint'] = {
			extends: 'house',
			maxDisables: 2,
			bannedPhrases: [
				{
					phrase: 'tap and go',
					replacement: 'hold the tag against the phone',
					why: 'It names a contactless payment scheme this app has nothing to do with.',
				},
			],
		};
		const findings = run(
			'no-banned-phrase',
			[paragraph('The store listing calls this "tap and go".')],
			{
				project: { ...PROJECT, lint },
			},
		);
		expect(findings.length).toBe(1);
		expect(findings[0]?.suggestion).toBe('hold the tag against the phone');
		expect(findings[0]?.remediation).toBe(lint.bannedPhrases?.[0]?.why);
	});

	test('a project phrase that is not a word still matches', () => {
		const lint: DocsProjectConfig['lint'] = {
			extends: 'house',
			maxDisables: 2,
			bannedPhrases: [
				{ phrase: '(TBD)', replacement: null, why: 'A placeholder must not publish.' },
			],
		};
		const findings = run('no-banned-phrase', [paragraph('The limit is (TBD) bytes.')], {
			project: { ...PROJECT, lint },
		});
		expect(findings.length).toBe(1);
		expect(findings[0]?.suggestion).toBeNull();
	});

	test('an opener is a violation at the start of a paragraph and nowhere else', () => {
		expect(run('no-banned-phrase', [paragraph('Additionally, the tag decides.')]).length).toBe(1);
		expect(run('no-banned-phrase', [paragraph('The tag additionally decides.')])).toEqual([]);
		expect(run('no-banned-phrase', [paragraph('"Ultimately" is the word.')]).length).toBe(1);
	});

	test('the corpus sentence that would trip a badly anchored opener does not', () => {
		// From the fixture troubleshooting page. `from-x-to-y` would match it anywhere but at
		// the start of a paragraph, which is why the rule applies the position.
		expect(
			run('no-banned-phrase', [
				paragraph('pull the phone well away from it, count to two, and scan again.'),
			]),
		).toEqual([]);
	});

	test('sanitises a banned character out of the excerpt it quotes', () => {
		const findings = run('no-banned-phrase', [
			paragraph('The handover \u2014 which is seamless \u2014 needs no conversion.'),
		]);
		expect(findings.length).toBe(1);
		expect(findings[0]?.excerpt).toContain('[U+2014]');
		expect(findings[0]?.excerpt).not.toContain('\u2014');
	});

	test('quotes with an ellipsis when the paragraph runs past the excerpt window', () => {
		const filler = 'the reader waits for a tag and reports what it found on it, again and again. ';
		const findings = run('no-banned-phrase', [
			paragraph(`${filler}${filler}It is seamless. ${filler}`),
		]);
		expect(findings.length).toBe(1);
		expect(findings[0]?.excerpt?.startsWith('...')).toBe(true);
		expect(findings[0]?.excerpt?.endsWith('...')).toBe(true);
	});

	test('names the replacements a phrase carries in its remediation', () => {
		const findings = run('no-banned-phrase', [paragraph('We leverage the capability container.')]);
		expect(findings.length).toBe(1);
		expect(findings[0]?.remediation).toContain('"use"');
	});
});

describe('the stack rules', () => {
	test('no-filler-verb-stack reports the filler and where it is', () => {
		const findings = run('no-filler-verb-stack', [
			segmentOf(['The retry loop is designed to handle a tag that moves.'], { firstLine: 12 }),
		]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:12:19');
		expect(findings[0]?.message).toContain('designed to handle');
	});

	test('no-hedging-stack reports a stacked hedge', () => {
		const findings = run('no-hedging-stack', [
			paragraph('A thicker case may potentially block it.'),
		]);
		expect(findings.length).toBe(1);
		expect(findings[0]?.remediation).toContain('"may"');
	});

	test('one hedge on its own is left alone', () => {
		expect(run('no-hedging-stack', [paragraph('A thicker case may block the antenna.')])).toEqual(
			[],
		);
	});
});

describe('no-rhetorical-opener', () => {
	test('reports a heading that is a question', () => {
		const findings = run('no-rhetorical-opener', [
			segmentOf(['Why does the scan stop halfway through?'], { kind: 'heading', firstLine: 52 }),
		]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:52:1');
	});

	test('is silent on a page whose front matter says it is a set of questions', () => {
		// The fixture corpus has a troubleshooting page whose five headings are all questions
		// and whose front matter says pageKind: faq, which is what pins this exemption.
		const headings = ['Why does the scan stop?', 'What should I send in?'].map((text) =>
			segmentOf([text], { kind: 'heading' }),
		);
		expect(run('no-rhetorical-opener', headings, { pageKind: 'faq' })).toEqual([]);
		expect(run('no-rhetorical-opener', headings).length).toBe(2);
	});

	test('reports a question the next sentence answers', () => {
		const findings = run('no-rhetorical-opener', [
			paragraph('Why does the read fail? The antenna sits at the top edge of the phone.'),
		]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:1:1');
	});

	test('leaves a question with no answer after it alone', () => {
		expect(run('no-rhetorical-opener', [paragraph('Which chip is in the tag?')])).toEqual([]);
	});

	test('recognises the question mark of the scripts this estate publishes', () => {
		const arabic = segmentOf(['لماذا يتوقف؟'], { kind: 'heading' });
		expect(run('no-rhetorical-opener', [arabic], { locale: 'ar' }).length).toBe(1);
	});

	test('an empty segment is not a question', () => {
		expect(run('no-rhetorical-opener', [segmentOf(['   '], { kind: 'heading' })])).toEqual([]);
	});
});

describe('no-triad', () => {
	test('reports three adjectives, in all three spellings of the list', () => {
		for (const text of [
			'The reader is fast, simple, and reliable.',
			'The reader is fast, simple and reliable.',
			'The reader is fast, simple, reliable.',
		]) {
			expect(run('no-triad', [paragraph(text)]).length, text).toBe(1);
		}
	});

	test('leaves a list of facts alone, which is why the list is curated', () => {
		// Straight out of the fixture corpus. A rule that flagged any three comma-separated
		// items would report this one.
		expect(
			run('no-triad', [paragraph('The log covers chip type, byte counts, and the error.')]),
		).toEqual([]);
	});

	test('points at the first word of the triad', () => {
		const findings = run('no-triad', [
			segmentOf(['It is fast, simple and secure.'], { firstLine: 9 }),
		]);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:9:7');
		expect(findings[0]?.excerpt).toContain('fast, simple and secure');
	});
});

describe('no-symmetric-pairs', () => {
	const EVEN = [
		'The reader opens a session and waits for a tag to come into range.',
		'The writer replaces the message and reports the free bytes left.',
		'The logger records the chip type and the time the scan finished.',
	].join(' ');

	test('reports a run of three sentences of nearly the same length', () => {
		const findings = run('no-symmetric-pairs', [segmentOf([EVEN], { firstLine: 4 })]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:4:1');
		expect(findings[0]?.message).toContain('66, 64, 64');
	});

	test('reports a run once rather than once per window inside it', () => {
		expect(run('no-symmetric-pairs', [segmentOf([`${EVEN} ${EVEN}`])]).length).toBe(2);
	});

	test('leaves varied sentence lengths alone', () => {
		const varied =
			'The reader opens a session and waits. The writer replaces the whole message, reports the free bytes left, and hands the session back. Then the logger records it.';
		expect(run('no-symmetric-pairs', [paragraph(varied)])).toEqual([]);
	});

	test('leaves three short sentences alone, however even they are', () => {
		expect(
			run('no-symmetric-pairs', [paragraph('Hold it still. Wait for one. Then read it.')]),
		).toEqual([]);
	});

	test('runs on the source locale only', () => {
		// The fixture corpus is the argument: the English paragraph whose sentences run 88,
		// 78 and 66 characters is 101, 99 and 100 in its Portuguese translation.
		expect(run('no-symmetric-pairs', [paragraph(EVEN)], { locale: 'pt-BR' })).toEqual([]);
	});
});

describe('australian-spelling', () => {
	test('reports the American spelling and suggests the local one', () => {
		const findings = run('australian-spelling', [
			segmentOf(['The Design package holds the color tokens.'], { firstLine: 40 }),
		]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:40:30');
		expect(findings[0]?.suggestion).toBe('colour');
	});

	test('keeps the case the author wrote', () => {
		expect(run('australian-spelling', [paragraph('Color tokens.')])[0]?.suggestion).toBe('Colour');
		expect(run('australian-spelling', [paragraph('COLOR TOKENS.')])[0]?.suggestion).toBe('COLOUR');
		expect(run('australian-spelling', [paragraph('the color tokens')])[0]?.suggestion).toBe(
			'colour',
		);
	});

	test('skips a word the project declares a technical term', () => {
		const lint: DocsProjectConfig['lint'] = {
			extends: 'house',
			maxDisables: 0,
			technicalTerms: ['color'],
		};
		expect(
			run('australian-spelling', [paragraph('The color tokens.')], {
				project: { ...PROJECT, lint },
			}),
		).toEqual([]);
	});

	test('skips a word inside a technical term of several words, and only there', () => {
		const lint: DocsProjectConfig['lint'] = {
			extends: 'house',
			maxDisables: 0,
			technicalTerms: ['Display P3 color space'],
		};
		const findings = run(
			'australian-spelling',
			[paragraph('The Display P3 color space is wide, and the color tokens are not.')],
			{ project: { ...PROJECT, lint } },
		);
		expect(findings.length).toBe(1);
		expect(findings[0]?.excerpt).toContain('color tokens');
	});

	test('runs on the source locale only', () => {
		// "color" is Spanish and "humor" is Portuguese, and both are correct. A finding on
		// either is one a translator cannot act on.
		expect(
			run('australian-spelling', [paragraph('El color de la etiqueta.')], { locale: 'es' }),
		).toEqual([]);
	});
});

describe('the deny list rules', () => {
	test('no-competitor-name reports a deny list string where it appears', () => {
		const findings = run('no-competitor-name', [
			segmentOf(['Contoso Tap keeps its codec inside the app target.'], { firstLine: 88 }),
		]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:88:1');
		// Naming it is fine: it is already a string in a file in this repository.
		expect(findings[0]?.message).toContain('Contoso Tap');
	});

	test('no-competitor-name matches without regard to case', () => {
		expect(
			run('no-competitor-name', [paragraph('Unlike contoso tap, we split it out.')]).length,
		).toBe(1);
	});

	test('internal-leak reports the pattern id and never the match', () => {
		const findings = run('internal-leak', [
			segmentOf(['Our internal builds add station-pack-alpha, the profile set'], { firstLine: 84 }),
		]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:84:25');
		expect(findings[0]?.message).toContain('station-pack');
		// The message names the pattern, not what it matched, and there is no excerpt at all.
		expect(findings[0]?.message).not.toContain('station-pack-alpha');
		expect(findings[0]?.excerpt).toBeNull();
		expect(findings[0]?.remediation).toBe(DENY.patterns[0]?.why);
	});

	test('a deny pattern that does not compile is reported, not thrown', () => {
		const broken: DenyList = {
			private: 1,
			strings: [],
			patterns: [{ id: 'broken', pattern: '([a-z', flags: '', why: 'A pattern with no close.' }],
		};
		const findings = run('internal-leak', [paragraph('Anything at all.')], { denyList: broken });
		expect(findings.length).toBe(1);
		expect(findings[0]?.message).toContain('not a valid regular expression');
		expect(findings[0]?.location).toEqual({ kind: 'file', file: DENY_LIST_PATH });
	});

	test.each(['no-competitor-name', 'internal-leak'] as LintRuleId[])(
		'%s reports that it examined nothing when there is no deny list',
		(id) => {
			const findings = run(id, [paragraph('Contoso Tap and station-pack-alpha.')], {
				denyList: null,
			});
			expect(findings.length).toBe(1);
			expect(findings[0]?.message).toContain(DENY_LIST_PATH);
			expect(findings[0]?.message).toContain('examined nothing');
			expect(findings[0]?.locale).toBeNull();
			expect(findings[0]?.location).toEqual({ kind: 'file', file: DENY_LIST_PATH });
		},
	);
});

describe('no-raw-html', () => {
	test('reports an opening tag in prose', () => {
		const findings = run('no-raw-html', [
			segmentOf(['Wrap the value in <span class="chip"> before printing it.'], { firstLine: 5 }),
		]);
		expect(findings.length).toBe(1);
		expect(positionOf(findings[0] as RawFinding)).toBe('content/en/guide/index.md:5:19');
		expect(findings[0]?.message).toContain('span');
	});

	test('leaves an HTML comment alone, because a suppression is written as one', () => {
		expect(
			run('no-raw-html', [
				paragraph('<!-- hexdocs-disable-next-line no-banned-phrase: quoting the listing -->'),
			]),
		).toEqual([]);
	});

	test('leaves an autolink alone', () => {
		expect(
			run('no-raw-html', [paragraph('See <https://example.com/chips> for the list.')]),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The sentence splitter, which three rules depend on
// ---------------------------------------------------------------------------

describe('splitSentences', () => {
	test('keeps a version number and an abbreviation in one sentence', () => {
		// Both halves matter. A full stop inside a version number has a digit after it, and a
		// full stop inside an abbreviation has a lower case letter after it, and every one of
		// these forms is in the fixture corpus.
		const text =
			'Every result came from iOS 18.2, against blank tags. The lab uses e.g. an NTAG213.';
		expect(splitSentences(text).map((sentence) => sentence.text)).toEqual([
			'Every result came from iOS 18.2, against blank tags.',
			'The lab uses e.g. an NTAG213.',
		]);
	});

	test('splits on a wide terminator with no space after it', () => {
		const sentences = splitSentences('タグを読みます。次に書きます。');
		expect(sentences.length).toBe(2);
		expect(sentences[1]?.offset).toBe(8);
	});

	test('records the offset of each sentence, not of the space in front of it', () => {
		const sentences = splitSentences('One.  Two.');
		expect(sentences.map((sentence) => sentence.offset)).toEqual([0, 6]);
	});

	test('returns nothing for text with no words in it', () => {
		expect(splitSentences('   ')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Every rule, on the ordinary case
// ---------------------------------------------------------------------------

describe('every implemented rule', () => {
	const CLEAN = [
		segmentOf(['Hold the top edge of the phone against a tag and the app decodes'], {
			kind: 'paragraph',
		}),
		segmentOf(['What you need'], { kind: 'heading' }),
		segmentOf(['144'], { kind: 'tableCell' }),
		segmentOf(['Which NFC chips the app can read and write on iOS.'], { kind: 'frontMatter' }),
	];

	test.each(IMPLEMENTED)('%s finds nothing in ordinary prose', (id) => {
		expect(
			run(id, CLEAN)
				.map((finding) => finding.message)
				.join(' | '),
		).toBe('');
	});

	test.each(IMPLEMENTED)('%s reports the rule it is registered under', (id) => {
		const definition = RULE_DEFINITIONS[id];
		const first = definition.examples[0];
		expect(first).toBeDefined();
		if (first === undefined) return;
		for (const finding of run(id, [segmentOf(first.bad.split('\n'))])) {
			expect(finding.rule).toBe(id);
			expect(finding.message.length).toBeGreaterThan(0);
		}
	});

	test('an empty document produces nothing from any rule that has something to scan', () => {
		let examined = 0;
		for (const id of IMPLEMENTED) {
			const findings = run(id, []);
			// The two deny rules answer for the scan itself, not for the text, so an empty
			// document still gets the finding that says the deny list is there.
			expect(findings, id).toEqual([]);
			examined += 1;
		}
		expect(examined).toBe(IMPLEMENTED.length);
	});
});
