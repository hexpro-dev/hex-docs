import { describe, expect, test } from 'vitest';

import { RULE_ID_PATTERN } from '../../../src/contracts/lint.js';
import {
	AUSTRALIAN_SPELLINGS,
	FILLER_VERB_STACKS,
	HEDGING_STACKS,
	HOUSE_PHRASES,
	PARAGRAPH_OPENERS,
	TRIAD_ADJECTIVES,
	compiledPhrase,
	isParagraphOpener,
	isTriadAdjective,
} from '../../src/compile/lint/phrases.js';

const TABLES = {
	HOUSE_PHRASES: HOUSE_PHRASES,
	HEDGING_STACKS: HEDGING_STACKS,
	FILLER_VERB_STACKS: FILLER_VERB_STACKS,
} as const;

/** Every entry in every table, so a sweep cannot silently skip a whole table. */
const EVERY_PHRASE = [...HOUSE_PHRASES, ...HEDGING_STACKS, ...FILLER_VERB_STACKS];

describe('the shape of the pack', () => {
	test('every table has entries, and the sweep below covers all of them', () => {
		for (const [name, table] of Object.entries(TABLES)) {
			expect(table.length, `${name} is empty`).toBeGreaterThan(0);
		}
		expect(EVERY_PHRASE.length).toBe(
			HOUSE_PHRASES.length + HEDGING_STACKS.length + FILLER_VERB_STACKS.length,
		);
		// A floor rather than an exact count: the pack grows, and a test that pinned the
		// number would be edited every time it did, which is how it stops being read.
		expect(EVERY_PHRASE.length).toBeGreaterThanOrEqual(35);
	});

	test('every id is kebab case and unique across every table', () => {
		const seen = new Set<string>();
		for (const phrase of EVERY_PHRASE) {
			expect(phrase.id, `${phrase.id} is not kebab case`).toMatch(RULE_ID_PATTERN);
			expect(seen.has(phrase.id), `${phrase.id} is declared twice`).toBe(false);
			seen.add(phrase.id);
		}
		expect(seen.size).toBe(EVERY_PHRASE.length);
	});

	test('every pattern compiles, is case insensitive and scans globally', () => {
		let examined = 0;
		for (const phrase of EVERY_PHRASE) {
			const compiled = compiledPhrase(phrase);
			expect(compiled.flags, phrase.id).toContain('i');
			expect(compiled.flags, phrase.id).toContain('g');
			expect(compiled.source).toBe(phrase.pattern);
			examined += 1;
		}
		expect(examined).toBe(EVERY_PHRASE.length);
	});

	test('a pattern is compiled once and the same instance comes back', () => {
		const first = HOUSE_PHRASES[0];
		expect(first).toBeDefined();
		if (first === undefined) return;
		expect(compiledPhrase(first)).toBe(compiledPhrase(first));
	});

	test('every entry states why, and suggests only replacements', () => {
		for (const phrase of EVERY_PHRASE) {
			// A sentence, not a label. A one-word reason is an exemption nobody decided on.
			expect(phrase.why.length, phrase.id).toBeGreaterThan(30);
			for (const suggestion of phrase.suggest) {
				// `Finding.suggestion` is applied verbatim, so an instruction here would reach an
				// agent as text it is entitled to paste into the page.
				expect(suggestion.endsWith('.'), `${phrase.id} suggests an instruction`).toBe(false);
				expect(suggestion.slice(0, 1)).toBe(suggestion.slice(0, 1).toLowerCase());
			}
		}
	});

	test('the openers are house phrases, marked and not duplicated', () => {
		for (const opener of PARAGRAPH_OPENERS) {
			expect(HOUSE_PHRASES).toContain(opener);
			expect(isParagraphOpener(opener.id)).toBe(true);
		}
		expect(PARAGRAPH_OPENERS.length).toBeGreaterThanOrEqual(10);
		expect(isParagraphOpener('seamless')).toBe(false);
	});
});

/**
 * The list the global rules state, checked term by term.
 *
 * Without this the pack could lose an entry and every other test would still pass: the
 * sweeps above check shape, and a shape holds just as well with a rule missing.
 */
describe('the global banned list is covered', () => {
	const HITS: [string, string][] = [
		['not-just', "It's not just a reader, it's a writer."],
		['more-than-just', 'The app is more than just a reader.'],
		['in-todays-world', "In today's fast-paced world, tags are everywhere."],
		['in-an-era-of', 'In an era of contactless payment, tags are everywhere.'],
		['unlock', 'Unlock the full potential of your tags.'],
		['unleash', 'Unleash the reader on a fresh tag.'],
		['empower', 'The app empowers you to write a tag.'],
		['elevate', 'It elevates your workflow.'],
		['supercharge', 'It supercharges the write path.'],
		['revolutionise-british', 'This revolutionises tag writing.'],
		['revolutionise-american', 'This revolutionizes tag writing.'],
		['transform-your', 'Transform your phone into a reader.'],
		['next-level', 'It takes your workflow to the next level.'],
		['game-changer', 'The new codec is a game-changer.'],
		['seamless', 'The handover is seamless.'],
		['seamlessly', 'The handover happens seamlessly.'],
		['effortless', 'Writing a tag is effortless.'],
		['robust', 'The parser is robust.'],
		['cutting-edge', 'A cutting-edge reader.'],
		['state-of-the-art', 'A state-of-the-art reader.'],
		['best-in-class', 'Best-in-class range.'],
		['world-class', 'World-class range.'],
		['leverage', 'We leverage the capability container.'],
		['delve', 'Delve into the lock bytes.'],
		['harness', 'You can harness the reader session.'],
		['navigate-the-landscape', 'Navigating the landscape of chip families.'],
		['tapestry', 'A tapestry of protocols.'],
		['testament-to', 'The range is a testament to the antenna design.'],
		['realm', 'This is outside the realm of what iOS exposes.'],
		['lets-dive-in', "Let's dive into the lock bytes."],
		['thats-where-x-comes-in', "That's where the capability container comes in."],
		['the-best-part', 'The best part is the retry.'],
		['heres-the-thing', "Here's the thing about lock bytes."],
		['simply-put', 'Simply put, the tag is locked.'],
		['at-its-core', 'At its core the reader is a poller.'],
		['ultimately', 'Ultimately the tag decides.'],
		['moreover', 'Moreover the tag decides.'],
		['furthermore', 'Furthermore the tag decides.'],
		['additionally', 'Additionally the tag decides.'],
		['whether-you-are', 'Whether you are reading or writing, hold the phone still.'],
		['from-x-to-y', 'From the Scan sheet to the Library, nothing leaves the phone.'],
	];

	test.each(HITS)('%s is caught by some house phrase', (_name, text) => {
		const matched = HOUSE_PHRASES.filter((phrase) => compiledPhrase(phrase).test(text));
		expect(matched.map((phrase) => phrase.id).join(',')).not.toBe('');
	});

	test('every listed term was actually swept', () => {
		expect(HITS.length).toBeGreaterThanOrEqual(40);
	});

	test('the hedging and filler tables catch what they are named for', () => {
		const hedges = [
			'A thicker case may potentially block the antenna.',
			'The ferrite layer can help to restore the range.',
			'The reader aims to provide a decoded record.',
			'A locked tag may be able to answer a read.',
			'The writer seeks to ensure the message is whole.',
		];
		for (const text of hedges) {
			expect(
				HEDGING_STACKS.some((phrase) => compiledPhrase(phrase).test(text)),
				text,
			).toBe(true);
		}
		const filler = [
			'The loop is designed to handle a moving tag.',
			'The copy was crafted to reassure the reader.',
			'The codec was built to run without a device.',
			'The antenna is engineered to reach 40 mm.',
		];
		for (const text of filler) {
			expect(
				FILLER_VERB_STACKS.some((phrase) => compiledPhrase(phrase).test(text)),
				text,
			).toBe(true);
		}
		expect(hedges.length + filler.length).toBe(9);
	});
});

/**
 * The two words the global rules ban as verbs and that a technical page needs as nouns.
 *
 * This is the trap the patterns are shaped around, so it is the one worth pinning: a
 * later edit that simplified either pattern to a bare word would pass every other test in
 * this file and start refusing pages that say "test harness".
 */
describe('leverage and harness are banned as verbs, not as nouns', () => {
	const leverage = HOUSE_PHRASES.find((phrase) => phrase.id === 'leverage-as-a-verb');
	const harness = HOUSE_PHRASES.find((phrase) => phrase.id === 'harness-as-a-verb');

	test('both entries exist', () => {
		expect(leverage).toBeDefined();
		expect(harness).toBeDefined();
	});

	test.each([
		['We leverage the capability container.', true],
		['You leverage it at call time.', true],
		['Leveraging the existing session saves a poll.', true],
		['The mechanism gives you leverage over the lock bits.', false],
		['Financial leverage is not what this page is about.', false],
	])('%s', (text, expected) => {
		expect(leverage !== undefined && compiledPhrase(leverage).test(text)).toBe(expected);
	});

	test.each([
		['We harness the reader session.', true],
		['Harnessing the polling loop costs a frame.', true],
		['The test harness runs without a device.', false],
		['A wiring harness inside the inlay.', false],
	])('%s', (text, expected) => {
		expect(harness !== undefined && compiledPhrase(harness).test(text)).toBe(expected);
	});
});

describe('the triad list', () => {
	test('holds only lower case single words, with no duplicates', () => {
		const seen = new Set<string>();
		for (const word of TRIAD_ADJECTIVES) {
			expect(word).toBe(word.toLowerCase());
			expect(word).toMatch(/^[a-z]+$/);
			expect(seen.has(word), `${word} is listed twice`).toBe(false);
			seen.add(word);
		}
		expect(seen.size).toBe(TRIAD_ADJECTIVES.length);
		expect(TRIAD_ADJECTIVES.length).toBeGreaterThanOrEqual(20);
	});

	test('membership is what separates a cadence from a list of facts', () => {
		expect(isTriadAdjective('fast')).toBe(true);
		expect(isTriadAdjective('secure')).toBe(true);
		// The words in "chip type, byte counts, and the error", which is the fixture corpus
		// sentence this rule must never report.
		expect(isTriadAdjective('type')).toBe(false);
		expect(isTriadAdjective('counts')).toBe(false);
		expect(isTriadAdjective('the')).toBe(false);
	});
});

describe('the spelling table', () => {
	test('has at least twenty pairs, each a real change', () => {
		expect(AUSTRALIAN_SPELLINGS.length).toBeGreaterThanOrEqual(20);
		for (const pair of AUSTRALIAN_SPELLINGS) {
			expect(pair.american).not.toBe(pair.australian);
			expect(pair.american).toBe(pair.american.toLowerCase());
			expect(pair.australian).toBe(pair.australian.toLowerCase());
			expect(pair.american).toMatch(/^[a-z]+$/);
		}
	});

	test('lists each American spelling once', () => {
		const seen = new Set<string>();
		for (const pair of AUSTRALIAN_SPELLINGS) {
			expect(seen.has(pair.american), `${pair.american} is listed twice`).toBe(false);
			seen.add(pair.american);
		}
		expect(seen.size).toBe(AUSTRALIAN_SPELLINGS.length);
	});

	test('covers every family the house rules name', () => {
		const american = new Set(AUSTRALIAN_SPELLINGS.map((pair) => pair.american));
		for (const word of ['organize', 'color', 'center', 'defense', 'traveled']) {
			expect(american.has(word), `${word} is missing`).toBe(true);
		}
		expect(american.size).toBeGreaterThanOrEqual(20);
	});

	test('leaves out the words that are correct here already', () => {
		const american = new Set(AUSTRALIAN_SPELLINGS.map((pair) => pair.american));
		// "in practice" is in the fixture corpus and is correct: the noun is `practice` in
		// Australian English and only the verb is `practise`. `program` is correct in
		// computing. Bare `meter` is a device, so only the compounds are listed.
		for (const word of ['practice', 'program', 'meter']) {
			expect(american.has(word), `${word} would be a false positive`).toBe(false);
		}
	});
});
