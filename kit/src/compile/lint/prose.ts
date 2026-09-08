/**
 * The rules that read prose.
 *
 * Every rule here takes `ProseSegment`s and nothing else, which is what makes them
 * testable against a paragraph with no project around it. A segment is one block's text
 * with the inline markup gone, the inline code gone, the soft wraps folded and the
 * recognised status glyphs already turned into data. That last property is load bearing:
 * `no-decorative-unicode` has to see the tick that is decoration and must not see the
 * fifty-nine that are a support matrix, and the only place that distinction is made is
 * the compiler, before any of this runs.
 *
 * **Every finding points at a line and a column.** `positionAt` maps an offset in the
 * folded text back to the line the author typed it on, which is the whole reason the
 * folding keeps its runs. A finding that named only the file would send a reader to the
 * top of a two hundred line page to look for one word.
 *
 * **No banned character is ever written literally here**, in the source or in anything a
 * rule emits. The patterns are derived from the code points the contract declares, for
 * the reason `lint.ts` gives: a literal set would flag the file that declares the rule,
 * and an exemption for "the file that declares the rule" is the hole that later swallows
 * a real hit. `sanitiseExcerpt` applies the same rule to the text a finding quotes.
 */

import type { FindingLocation } from '../../../../src/contracts/diagnostics.js';
import type { PageKind } from '../../../../src/contracts/frontmatter.js';
import type { Locale } from '../../../../src/contracts/locales.js';
import type { DenyList, DocsProjectConfig } from '../../../../src/contracts/project.js';
import {
	type BannedPhrase,
	BANNED_CHARACTERS,
	BANNED_CHARS,
	EM_DASH_CHARS,
	EN_DASH_IN_PROSE,
	bannedCharacterName,
	type LintRuleId,
} from '../../../../src/contracts/lint.js';
import { RAW_HTML_PATTERN } from '../../../../src/contracts/source.js';
import { positionAt, raw, type ProseSegment, type RawFinding } from '../types.js';
import {
	AUSTRALIAN_SPELLINGS,
	FILLER_VERB_STACKS,
	HEDGING_STACKS,
	HOUSE_PHRASES,
	compiledPhrase,
	isParagraphOpener,
	isTriadAdjective,
} from './phrases.js';

/**
 * What a prose rule knows about the document its segments came from.
 *
 * Everything here is a fact the rule cannot derive from the text. `pageKind` is the one
 * that changes an answer rather than a message: a page whose front matter says it is a
 * set of questions is a page where a question heading is the content.
 */
export interface ProseRuleContext {
	/** Relative to `docs/site/`, matching the segments and the manifest. */
	file: string;
	locale: Locale;
	sourceLocale: Locale;
	project: DocsProjectConfig;
	/** `null` when `docs/docs.private.json` is absent, which is a finding of its own. */
	denyList: DenyList | null;
	/**
	 * The file's own lines, front matter included, read only by the two deny rules.
	 *
	 * Every other rule here reads prose and must keep doing so: the 59 support-matrix
	 * ticks and the em dashes inside code fences are why a prose segment has inline code
	 * removed and fences never present. The deny rules are the opposite case. What they
	 * stand between is a device UDID and a public mirror, and a sample command in a fence
	 * is the most likely place a UDID is typed, so scanning only prose left them blind to
	 * fence bodies, inline code, link and image targets and link titles, all of which are
	 * published in both the page payload and the raw markdown. `DenyList` in
	 * `src/contracts/project.ts` already said the scan covers "every published string and
	 * the raw markdown"; until this field existed it covered neither.
	 */
	sourceLines: readonly SourceLine[];
	pageKind: PageKind;
	isDraft: boolean;
}

/** One line of a file as the deny scan reads it: the text, and the line it really is. */
export interface SourceLine {
	text: string;
	line: number;
}

export type ProseRule = (
	segments: readonly ProseSegment[],
	context: ProseRuleContext,
) => RawFinding[];

/**
 * The deny list path, named in the finding that fires when there is no deny list.
 *
 * Outside `docs/site/` on purpose: it names the things that must not ship, so keeping it
 * inside the tree the publisher reads would be the same mistake in miniature.
 */
export const DENY_LIST_PATH = 'docs/docs.private.json';

// ---------------------------------------------------------------------------
// Positions, excerpts and the character partition
// ---------------------------------------------------------------------------

function at(segment: ProseSegment, offset: number): FindingLocation {
	const position = positionAt(segment.folded, segment.file, offset);
	return { kind: 'file', file: position.file, line: position.line, column: position.column };
}

/** `"U+2014"`, so a message can name a character without containing it. */
function spell(character: string): string {
	const point = character.codePointAt(0) ?? 0;
	return `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * A banned character in quoted text, replaced by its spelling.
 *
 * `BANNED_CHARACTERS` governs the strings this package produces, and a finding is one of
 * them. Without this an excerpt would carry the em dash it is reporting into every
 * report, every golden file and every message downstream of it, which is the thing the
 * list exists to stop. The spelling is what a reader needs anyway: an em dash and an en
 * dash look the same in a terminal.
 */
const BANNED_IN_EXCERPT = new RegExp(BANNED_CHARS.source, 'gu');

function sanitiseExcerpt(text: string): string {
	return text.replace(BANNED_IN_EXCERPT, (character) => `[${spell(character)}]`);
}

const EXCERPT_RADIUS = 40;

/** The offending text with enough either side of it to recognise, on one line. */
function excerptAt(text: string, index: number, length: number): string {
	const from = Math.max(0, index - EXCERPT_RADIUS);
	const to = Math.min(text.length, index + length + EXCERPT_RADIUS);
	const body = text.slice(from, to).replace(/\s+/gu, ' ').trim();
	const prefix = from > 0 ? '...' : '';
	const suffix = to < text.length ? '...' : '';
	return sanitiseExcerpt(`${prefix}${body}${suffix}`);
}

/**
 * Which of the three character rules owns each banned character.
 *
 * Derived from the contract's own patterns rather than from three hand-written lists,
 * which is what makes the partition hold when a character is added to
 * `BANNED_CHARACTERS`: the new character is matched by `EM_DASH_CHARS`, or by
 * `EN_DASH_IN_PROSE`, or by neither, and lands in exactly one bucket with nobody editing
 * anything. Three lists would let a character be reported twice or not at all, and the
 * second failure is silent.
 */
function partitionCharacters(): number[] {
	const decorative: number[] = [];
	for (const entry of BANNED_CHARACTERS) {
		const character = String.fromCodePoint(entry.codePoint);
		if (EM_DASH_CHARS.test(character)) continue;
		if (EN_DASH_IN_PROSE.test(character)) continue;
		decorative.push(entry.codePoint);
	}
	return decorative;
}

/** The code points `no-decorative-unicode` owns: every banned character neither dash rule takes. */
export const DECORATIVE_CODE_POINTS: readonly number[] = partitionCharacters();

function characterClass(points: readonly number[]): string {
	return `[${points.map((point) => `\\u{${point.toString(16)}}`).join('')}]`;
}

/*
 * The two dash scanners come straight from the contract patterns, so the digit exception
 * on the en dash is the contract's and not a copy of it. A numeric range is the one place
 * an en dash is correct, and rewriting a year range is not an improvement.
 */
const EM_DASH_SCAN = new RegExp(EM_DASH_CHARS.source, 'gu');
const EN_DASH_SCAN = new RegExp(EN_DASH_IN_PROSE.source, 'gu');
const DECORATIVE_SCAN = new RegExp(characterClass(DECORATIVE_CODE_POINTS), 'gu');
const RAW_HTML_SCAN = new RegExp(RAW_HTML_PATTERN.source, 'g');

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

interface Sentence {
	text: string;
	/** Offset of the first character of the sentence in the folded text. */
	offset: number;
}

/** Question marks in the scripts this estate publishes. Escapes, never literals. */
const QUESTION_MARKS = ['?', '\u061F', '\uFF1F'];

/** The full stops, exclamations and question marks that end a sentence. */
const TERMINATORS = ['.', '!', '?', '\u061F', '\u3002', '\uFF1F', '\uFF01'];

/** A terminator that always ends a sentence, because the script writes no space after it. */
const WIDE_TERMINATORS = ['\u3002', '\uFF1F', '\uFF01'];

/**
 * Splits folded prose into sentences, keeping each one's offset.
 *
 * A full stop ends a sentence only when what follows it is whitespace and then something
 * that is not a lower case letter or a digit. That one condition is what keeps "iOS
 * 18.2" and "1.4 ships" and "e.g. the reader" from becoming three sentences each, and
 * every one of those is in the fixture corpus. The wide terminators are unconditional,
 * because Japanese and Chinese write no space after them.
 */
export function splitSentences(text: string): Sentence[] {
	const found: Sentence[] = [];
	let start = 0;

	const push = (from: number, to: number): void => {
		const slice = text.slice(from, to);
		const lead = slice.length - slice.trimStart().length;
		const body = slice.trim();
		if (body.length > 0) found.push({ text: body, offset: from + lead });
	};

	for (let index = 0; index < text.length; index += 1) {
		const character = text[index] as string;
		if (!TERMINATORS.includes(character)) continue;

		if (!WIDE_TERMINATORS.includes(character)) {
			let next = index + 1;
			while (next < text.length && /\s/u.test(text[next] as string)) next += 1;
			if (next === index + 1 && next < text.length) continue;
			const following = text[next];
			if (following !== undefined && /[a-z0-9]/u.test(following)) continue;
		}

		push(start, index + 1);
		start = index + 1;
	}
	push(start, text.length);
	return found;
}

// ---------------------------------------------------------------------------
// The character rules
// ---------------------------------------------------------------------------

/**
 * One rule per character set, sharing everything but the pattern and the advice.
 *
 * The excerpt is deliberately `null`. The offending text is the character, and quoting it
 * would put the banned character into the finding, which is the one thing this package
 * must never emit. The line and column say where it is, and the message names it by
 * code point, which is more use than a quotation a terminal renders identically to the
 * character it is not.
 */
function characterRule(rule: LintRuleId, pattern: RegExp, remediation: string): ProseRule {
	return (segments, context) => {
		const findings: RawFinding[] = [];
		for (const segment of segments) {
			for (const match of segment.folded.text.matchAll(pattern)) {
				const character = match[0];
				const name = bannedCharacterName(character) ?? 'banned character';
				findings.push(
					raw(
						rule,
						at(segment, match.index),
						context.locale,
						`The prose uses ${spell(character)} ${name} as punctuation.`,
						{ remediation, excerpt: null },
					),
				);
			}
		}
		return findings;
	};
}

const noEmDash = characterRule(
	'no-em-dash',
	EM_DASH_SCAN,
	'Rewrite the sentence with a comma, a colon, brackets, or two sentences.',
);

const noEnDashInProse = characterRule(
	'no-en-dash-prose',
	EN_DASH_SCAN,
	'Rewrite the sentence with a comma or a colon. Between two digits the character is correct and this rule permits it.',
);

const noDecorativeUnicode = characterRule(
	'no-decorative-unicode',
	DECORATIVE_SCAN,
	'Write the word the character was standing in for. A glyph that carries data belongs in a table cell, where the compiler reads it as a status.',
);

// ---------------------------------------------------------------------------
// Phrase rules
// ---------------------------------------------------------------------------

/** True when nothing but whitespace or an opening quote precedes the offset. */
function atSegmentStart(text: string, index: number): boolean {
	return /^[\s"'(\[\u00AB\u201C\u2018]*$/u.test(text.slice(0, index));
}

/** The remediation text for a phrase: why it is banned, and what to write instead. */
function phraseRemediation(why: string, suggest: readonly string[]): string {
	if (suggest.length === 0) return why;
	return `${why} Consider ${suggest.map((option) => `"${option}"`).join(' or ')}.`;
}

/**
 * Literal phrases a project adds in its own `docs.json`, compiled once each.
 *
 * Word bounded only where the phrase begins or ends with a word character, so a project
 * banning a piece of punctuation or a bracketed marker still gets a match. Cached by the
 * phrase string, because the alternative is recompiling one regex per segment per page
 * per locale.
 */
const PROJECT_PHRASES = new Map<string, RegExp>();

function projectPhrasePattern(phrase: string): RegExp {
	const cached = PROJECT_PHRASES.get(phrase);
	if (cached !== undefined) return cached;
	const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	const before = /^\w/u.test(phrase) ? '\\b' : '';
	const after = /\w$/u.test(phrase) ? '\\b' : '';
	const compiled = new RegExp(`${before}${escaped}${after}`, 'gi');
	PROJECT_PHRASES.set(phrase, compiled);
	return compiled;
}

/**
 * The house pack plus whatever the project adds. A project may add and may never remove,
 * which is why the two lists are scanned rather than merged: a project entry cannot
 * shadow a house entry by reusing its id.
 */
const noBannedPhrase: ProseRule = (segments, context) => {
	const findings: RawFinding[] = [];
	const projectPhrases = context.project.lint.bannedPhrases ?? [];

	for (const segment of segments) {
		const text = segment.folded.text;

		for (const phrase of HOUSE_PHRASES) {
			const positional = isParagraphOpener(phrase.id);
			for (const match of text.matchAll(compiledPhrase(phrase))) {
				if (positional && !atSegmentStart(text, match.index)) continue;
				findings.push(
					raw(
						'no-banned-phrase',
						at(segment, match.index),
						context.locale,
						`The wording "${match[0]}" is on the house banned list.`,
						{
							remediation: phraseRemediation(phrase.why, phrase.suggest),
							excerpt: excerptAt(text, match.index, match[0].length),
						},
					),
				);
			}
		}

		for (const entry of projectPhrases) {
			for (const match of text.matchAll(projectPhrasePattern(entry.phrase))) {
				findings.push(
					raw(
						'no-banned-phrase',
						at(segment, match.index),
						context.locale,
						`The wording "${match[0]}" is on this project's banned list.`,
						{
							remediation: entry.why,
							suggestion: entry.replacement,
							excerpt: excerptAt(text, match.index, match[0].length),
						},
					),
				);
			}
		}
	}
	return findings;
};

/** Both stack rules are the same scan over a different table, so they share one body. */
function stackRule(
	rule: LintRuleId,
	table: readonly BannedPhrase[],
	describe: (matched: string) => string,
): ProseRule {
	return (segments, context) => {
		const findings: RawFinding[] = [];
		for (const segment of segments) {
			const text = segment.folded.text;
			for (const phrase of table) {
				for (const match of text.matchAll(compiledPhrase(phrase))) {
					findings.push(
						raw(rule, at(segment, match.index), context.locale, describe(match[0]), {
							remediation: phraseRemediation(phrase.why, phrase.suggest),
							excerpt: excerptAt(text, match.index, match[0].length),
						}),
					);
				}
			}
		}
		return findings;
	};
}

const noHedgingStack = stackRule(
	'no-hedging-stack',
	HEDGING_STACKS,
	(matched) => `"${matched}" stacks two hedges on one verb.`,
);

const noFillerVerbStack = stackRule(
	'no-filler-verb-stack',
	FILLER_VERB_STACKS,
	(matched) => `"${matched}" puts filler in front of the verb.`,
);

// ---------------------------------------------------------------------------
// Structural rules
// ---------------------------------------------------------------------------

/**
 * A question in a heading, or a question answered by the sentence after it.
 *
 * Exempt on a page whose front matter says `pageKind: faq`, because there the question is
 * the content rather than a way of introducing it. The fixture corpus carries a
 * troubleshooting page whose five headings are all questions and whose front matter says
 * so, which is what pins this: getting the exemption wrong is five findings on one page.
 */
const noRhetoricalOpener: ProseRule = (segments, context) => {
	if (context.pageKind === 'faq') return [];

	const findings: RawFinding[] = [];
	for (const segment of segments) {
		const text = segment.folded.text.trim();
		if (text.length === 0) continue;

		if (segment.kind === 'heading') {
			if (!QUESTION_MARKS.includes(text.slice(-1))) continue;
			const body = segment.folded.text;
			const lead = body.length - body.trimStart().length;
			findings.push(
				raw(
					'no-rhetorical-opener',
					at(segment, lead),
					context.locale,
					'The heading is a question.',
					{
						remediation:
							'Name the subject of the section. A page that really is a set of questions declares pageKind: faq in its front matter.',
						excerpt: excerptAt(body, lead, text.length),
					},
				),
			);
			continue;
		}

		const sentences = splitSentences(segment.folded.text);
		const first = sentences[0];
		if (first === undefined || sentences.length < 2) continue;
		if (!QUESTION_MARKS.includes(first.text.slice(-1))) continue;
		findings.push(
			raw(
				'no-rhetorical-opener',
				at(segment, first.offset),
				context.locale,
				'The paragraph opens with a question that the next sentence answers.',
				{
					remediation: 'Delete the question and keep the answer.',
					excerpt: excerptAt(segment.folded.text, first.offset, first.text.length),
				},
			),
		);
	}
	return findings;
};

/**
 * Three comma-separated words, every one of them from the triad list.
 *
 * Covers the three spellings a triad is written in: with an Oxford comma, without one,
 * and as a bare list of three. The list membership is the entire guard, and it is what
 * keeps "chip type, byte counts, and the error" out of the results.
 */
const TRIAD_SCAN = /\b([a-z]+),\s+([a-z]+)(?:,\s+(?:and\s+|or\s+)?|\s+(?:and|or)\s+)([a-z]+)\b/giu;

const noTriad: ProseRule = (segments, context) => {
	const findings: RawFinding[] = [];
	for (const segment of segments) {
		const text = segment.folded.text;
		for (const match of text.matchAll(TRIAD_SCAN)) {
			// The three capture groups, as strings. `slice` rather than three indexed reads,
			// because an index into a match is optional to the typechecker and a guard on one
			// that always participates is a branch no test can reach.
			if (!match.slice(1, 4).every((word) => isTriadAdjective(word.toLowerCase()))) continue;
			findings.push(
				raw(
					'no-triad',
					at(segment, match.index),
					context.locale,
					`Three adjectives are stacked for rhythm: "${match[0]}".`,
					{
						remediation:
							'Keep the one that carries a fact and delete the other two, or replace all three with the measurement they are standing in for.',
						excerpt: excerptAt(text, match.index, match[0].length),
					},
				),
			);
		}
	}
	return findings;
};

/**
 * Three consecutive sentences of nearly the same length.
 *
 * The strongest structural tell there is, and the fuzziest rule in this file, which is
 * why it defaults to `info` and why the thresholds are set where they are rather than
 * where they would catch the most.
 *
 * Measured against the fixture corpus, which is where the numbers come from. The closest
 * English run of three long sentences in it spans twenty characters, so a spread of eight
 * leaves a factor of two in hand. The floor of sixty characters is what keeps a run of
 * three short list sentences out: at twenty characters each, three sentences within eight
 * of each other is a coincidence rather than a cadence.
 *
 * It runs on the source locale only. A translation's sentence lengths belong to the
 * translator, and the corpus proves the point: the English paragraph whose sentences run
 * 88, 78 and 66 characters is 101, 99 and 100 in Portuguese. Reporting that would ask a
 * translator to rewrite a faithful translation to fix rhythm in a language the rule was
 * not measured in.
 */
const SYMMETRIC_RUN = 3;
const SYMMETRIC_MIN_LENGTH = 60;
const SYMMETRIC_MAX_SPREAD = 8;

const noSymmetricPairs: ProseRule = (segments, context) => {
	if (context.locale !== context.sourceLocale) return [];

	const findings: RawFinding[] = [];
	for (const segment of segments) {
		const sentences = splitSentences(segment.folded.text);
		const lengths = sentences.map((sentence) => sentence.text.length);
		// Walked with `entries` rather than by index, so the first sentence of each window
		// is a value the typechecker already knows is there. Indexing it would need a guard
		// on a position that is always in range, which is a branch no test can reach.
		let resumeAt = 0;
		for (const [index, first] of sentences.entries()) {
			if (index < resumeAt) continue;
			if (index + SYMMETRIC_RUN > sentences.length) break;

			const run = lengths.slice(index, index + SYMMETRIC_RUN);
			const shortest = Math.min(...run);
			if (shortest < SYMMETRIC_MIN_LENGTH) continue;
			if (Math.max(...run) - shortest > SYMMETRIC_MAX_SPREAD) continue;

			const span = run.reduce((total, length) => total + length, SYMMETRIC_RUN - 1);
			findings.push(
				raw(
					'no-symmetric-pairs',
					at(segment, first.offset),
					context.locale,
					`Three consecutive sentences run ${run.join(', ')} characters.`,
					{
						remediation:
							'Cut one of them to a clause, or join two. Varied length is what makes a paragraph read as written rather than generated.',
						excerpt: excerptAt(segment.folded.text, first.offset, span),
					},
				),
			);
			// Past the whole run, so one paragraph of five even sentences reports once rather
			// than three times about the same text.
			resumeAt = index + SYMMETRIC_RUN;
		}
	}
	return findings;
};

// ---------------------------------------------------------------------------
// Spelling
// ---------------------------------------------------------------------------

/*
 * One alternation over every American spelling, longest first.
 *
 * Longest first is belt and braces next to the word boundaries: `\bcolor\b` cannot match
 * inside "colors" anyway, and an ordering that depended on it would be an ordering
 * nobody could safely change.
 */
const SPELLING_BY_WORD = new Map(
	AUSTRALIAN_SPELLINGS.map((pair) => [pair.american.toLowerCase(), pair.australian]),
);

const SPELLING_SCAN = new RegExp(
	`\\b(?:${[...SPELLING_BY_WORD.keys()].sort((a, b) => b.length - a.length).join('|')})\\b`,
	'giu',
);

/** The Australian spelling, cased the way the author cased the word they wrote. */
function matchCase(matched: string, replacement: string): string {
	if (matched === matched.toUpperCase()) return replacement.toUpperCase();
	const first = matched.slice(0, 1);
	if (first === first.toUpperCase()) {
		return replacement.slice(0, 1).toUpperCase() + replacement.slice(1);
	}
	return replacement;
}

/**
 * True when the match sits inside one of the project's technical terms.
 *
 * The plain case is a term that is the word itself, and it is the common one. The other
 * case is a term of several words, one of which happens to be an American spelling, and
 * checking the surrounding text is the only way to tell that apart from a word the author
 * really did misspell two characters away from the term.
 */
function insideTechnicalTerm(
	text: string,
	index: number,
	length: number,
	terms: string[],
): boolean {
	const word = text.slice(index, index + length).toLowerCase();
	const lower = text.toLowerCase();
	for (const term of terms) {
		const needle = term.toLowerCase();
		if (needle === word) return true;
		if (!needle.includes(word)) continue;
		let from = lower.indexOf(needle);
		while (from !== -1) {
			if (from <= index && index + length <= from + needle.length) return true;
			from = lower.indexOf(needle, from + 1);
		}
	}
	return false;
}

/**
 * American spellings in the source locale.
 *
 * The source locale only, and this is a decision rather than an omission. Spanish
 * "color", French "centre" and Portuguese "humor" are all correct in their own language,
 * and a rule that flagged them would hand a translator a finding they cannot act on and
 * teach them to ignore the whole category.
 */
const australianSpelling: ProseRule = (segments, context) => {
	if (context.locale !== context.sourceLocale) return [];

	const terms = context.project.lint.technicalTerms ?? [];
	const findings: RawFinding[] = [];

	for (const segment of segments) {
		const text = segment.folded.text;
		for (const match of text.matchAll(SPELLING_SCAN)) {
			const matched = match[0];
			if (insideTechnicalTerm(text, match.index, matched.length, terms)) continue;
			const australian = SPELLING_BY_WORD.get(matched.toLowerCase());
			if (australian === undefined) continue;
			const suggestion = matchCase(matched, australian);
			findings.push(
				raw(
					'australian-spelling',
					at(segment, match.index),
					context.locale,
					`"${matched}" is the American spelling.`,
					{
						remediation: `This estate writes "${suggestion}". A term the project spells the American way on purpose belongs in lint.technicalTerms.`,
						suggestion,
						excerpt: excerptAt(text, match.index, matched.length),
					},
				),
			);
		}
	}
	return findings;
};

// ---------------------------------------------------------------------------
// The deny list
// ---------------------------------------------------------------------------

/**
 * The finding that fires when there is no deny list.
 *
 * A warning that names the path and says what it would have scanned for, never a silent
 * pass. A deny scan that examined nothing has cleared nothing, and this is the check
 * whose failure mode is a competitor name or a device identifier on a public page.
 *
 * One per call, and every one of them identical: same rule, same location, same message,
 * no locale. A rule sees one document's segments and cannot know whether it is the first,
 * so the report assembler is what collapses them, and it can only do that because nothing
 * here varies with the document.
 */
function denyScanMissing(rule: LintRuleId, scannedFor: string): RawFinding {
	return raw(
		rule,
		{ kind: 'file', file: DENY_LIST_PATH },
		null,
		`The deny scan examined nothing: ${DENY_LIST_PATH} is not present, so no page was checked for ${scannedFor}.`,
		{
			remediation: `Create ${DENY_LIST_PATH}. It lives outside docs/site/ on purpose, because it names the things that must not ship.`,
		},
	);
}

/**
 * The same finding for a deny list that exists and holds nothing of this rule's kind.
 *
 * An absent file was already refused and an empty one was not, which left the louder half
 * of the hole open: a `docs.private.json` with two empty arrays validates, scans zero
 * needles against every page, and both protected brand rules are then counted among the
 * summary's passing checks. A file that says the project has a deny list while clearing
 * nothing is worse than no file, because the absent one at least reports itself.
 */
function denyScanEmpty(rule: LintRuleId, kind: string, scannedFor: string): RawFinding {
	return raw(
		rule,
		{ kind: 'file', file: DENY_LIST_PATH },
		null,
		`The deny scan examined nothing: ${DENY_LIST_PATH} has no ${kind}, so no page was checked for ${scannedFor}.`,
		{
			remediation: `Add at least one entry, or delete the key and let the absent-file finding say so. A rule that scanned nothing has cleared nothing, and this one reads as a passing check.`,
		},
	);
}

const DENY_STRINGS = new Map<string, RegExp>();

function denyStringPattern(needle: string): RegExp {
	const cached = DENY_STRINGS.get(needle);
	if (cached !== undefined) return cached;
	const compiled = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gi');
	DENY_STRINGS.set(needle, compiled);
	return compiled;
}

/** One place a deny pattern matched: where to report it, and the text around it. */
interface DenyHit {
	location: FindingLocation;
	text: string;
	index: number;
	length: number;
}

/**
 * Every match of one pattern across both of a deny rule's inputs.
 *
 * The raw lines cover what prose deliberately drops: fence bodies, inline code, link and
 * image targets, titles, front matter keys. The prose covers the one thing the raw lines
 * cannot: a match folded across a soft wrap, two words on two lines that are one string
 * on the published page.
 *
 * They overlap on everything else, and nothing here dedupes that. It does not need to.
 * A `ProseSegment`'s run map records the source line and column of every run, so an
 * occurrence in ordinary prose resolves to the same line and column the raw scan reports,
 * even across markup: measured on `The **new** Contoso Tap reader`, both inputs say line
 * 8, column 13. Identical findings collapse in `runLint`, which dedupes on rule,
 * severity, location and message. An earlier version of this function carried an ordinal
 * dedupe for positions that turn out never to disagree, and a mutation removing it
 * changed no test, which is the definition of a guard that is not doing anything.
 *
 * Both rules go through this, so the two cannot come to cover different ground. That is
 * how one of them ended up scanning ground its own contract described and the other did
 * not.
 */
function denyHits(
	segments: readonly ProseSegment[],
	context: ProseRuleContext,
	pattern: RegExp,
): DenyHit[] {
	const hits: DenyHit[] = [];

	for (const line of context.sourceLines) {
		for (const match of line.text.matchAll(pattern)) {
			hits.push({
				location: { kind: 'file', file: context.file, line: line.line, column: match.index + 1 },
				text: line.text,
				index: match.index,
				length: match[0].length,
			});
		}
	}

	for (const segment of segments) {
		for (const match of segment.folded.text.matchAll(pattern)) {
			hits.push({
				location: at(segment, match.index),
				text: segment.folded.text,
				index: match.index,
				length: match[0].length,
			});
		}
	}
	return hits;
}

const noCompetitorName: ProseRule = (segments, context) => {
	const denyList = context.denyList;
	if (denyList === null) return [denyScanMissing('no-competitor-name', 'a competitor name')];
	if (denyList.strings.length === 0) {
		return [denyScanEmpty('no-competitor-name', 'strings', 'a competitor name')];
	}

	const findings: RawFinding[] = [];
	for (const needle of denyList.strings) {
		for (const hit of denyHits(segments, context, denyStringPattern(needle))) {
			findings.push(
				raw(
					'no-competitor-name',
					hit.location,
					context.locale,
					`"${needle}" is on the deny list and this page is published.`,
					{
						remediation:
							'Describe the behaviour without naming the product. A comparison on a public page is one the company has to stand behind.',
						excerpt: excerptAt(hit.text, hit.index, hit.length),
					},
				),
			);
		}
	}
	return findings;
};

/**
 * A pattern from the deny list, compiled once and cached against the entry it came from.
 *
 * The pattern is a string out of a JSON file, so it can fail to compile. That is reported
 * rather than thrown: a deny scan that could not run has cleared nothing, and a stack
 * trace out of the compiler would lose every other finding on the page.
 */
const DENY_PATTERNS = new Map<string, RegExp | null>();

function denyPattern(id: string, pattern: string, flags: string): RegExp | null {
	// The separator is written as an escape rather than as the character. A literal
	// U+0000 in source is invisible in review and makes every grep treat the file as
	// binary, which is how a rule in it stops being findable by the next person.
	const key = `${id}\u0000${pattern}\u0000${flags}`;
	const cached = DENY_PATTERNS.get(key);
	if (cached !== undefined) return cached;
	let compiled: RegExp | null = null;
	try {
		compiled = new RegExp(pattern, [...new Set([...flags, 'g'])].join(''));
	} catch {
		compiled = null;
	}
	DENY_PATTERNS.set(key, compiled);
	return compiled;
}

/**
 * The deny list patterns, which match the things that identify rather than name.
 *
 * The excerpt is `null` and the message quotes nothing. A deny pattern matches a device
 * identifier, an internal tree name or an export classification, and a finding that
 * quoted the match would copy the secret into the report, the CI log and whatever an
 * agent does with them next. The pattern id and the line say where to look, which is all
 * a reader who is allowed to see it needs.
 */
const internalLeak: ProseRule = (segments, context) => {
	const denyList = context.denyList;
	if (denyList === null) {
		return [denyScanMissing('internal-leak', 'an internal identifier')];
	}
	if (denyList.patterns.length === 0) {
		return [denyScanEmpty('internal-leak', 'patterns', 'an internal identifier')];
	}

	const findings: RawFinding[] = [];
	for (const entry of denyList.patterns) {
		const compiled = denyPattern(entry.id, entry.pattern, entry.flags);
		if (compiled === null) {
			findings.push(
				raw(
					'internal-leak',
					{ kind: 'file', file: DENY_LIST_PATH },
					null,
					`The deny list pattern "${entry.id}" is not a valid regular expression, so nothing was scanned for it.`,
					{ remediation: 'Fix the pattern. Until it compiles, this page has not been cleared.' },
				),
			);
			continue;
		}
		for (const hit of denyHits(segments, context, compiled)) {
			findings.push(
				raw(
					'internal-leak',
					hit.location,
					context.locale,
					`The text here matches the deny list pattern "${entry.id}".`,
					{ remediation: entry.why, excerpt: null },
				),
			);
		}
	}
	return findings;
};

// ---------------------------------------------------------------------------
// Raw HTML
// ---------------------------------------------------------------------------

/**
 * An HTML tag in prose.
 *
 * The pattern is the contract's, and it matches no HTML comment. That is deliberate
 * there and depended on here: `hexdocs-disable-next-line` is written as an HTML comment,
 * and a rule that flagged it would make every suppression a finding of its own.
 */
const noRawHtml: ProseRule = (segments, context) => {
	const findings: RawFinding[] = [];
	for (const segment of segments) {
		const text = segment.folded.text;
		for (const match of text.matchAll(RAW_HTML_SCAN)) {
			findings.push(
				raw(
					'no-raw-html',
					at(segment, match.index),
					context.locale,
					`The prose contains the raw HTML tag "${match[0]}".`,
					{
						remediation:
							'Write it in markdown, or use a directive. There is no html node in the AST, so the tag is dropped and only the words inside it are published.',
						excerpt: excerptAt(text, match.index, match[0].length),
					},
				),
			);
		}
	}
	return findings;
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Every rule that reads prose, by id.
 *
 * `Partial`, because most rules in the registry read something else: a tree, a config, a
 * navigation file or a set of bytes. Keying by `LintRuleId` is what makes a rule here
 * without an id in the contract a typecheck failure rather than findings nothing can
 * configure.
 */
export const PROSE_RULES: Readonly<Partial<Record<LintRuleId, ProseRule>>> = {
	'no-em-dash': noEmDash,
	'no-en-dash-prose': noEnDashInProse,
	'no-decorative-unicode': noDecorativeUnicode,
	'no-banned-phrase': noBannedPhrase,
	'no-filler-verb-stack': noFillerVerbStack,
	'no-hedging-stack': noHedgingStack,
	'no-rhetorical-opener': noRhetoricalOpener,
	'no-triad': noTriad,
	'no-symmetric-pairs': noSymmetricPairs,
	'australian-spelling': australianSpelling,
	'no-competitor-name': noCompetitorName,
	'internal-leak': internalLeak,
	'no-raw-html': noRawHtml,
};
