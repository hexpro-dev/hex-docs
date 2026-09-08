import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
	AUDIENCES,
	DEFAULT_AUDIENCE,
	DEFAULT_PAGE_KIND,
	FORBIDDEN_FRONT_MATTER_KEYS,
	PAGE_KINDS,
	SEMVER_PATTERN,
	TRANSLATION_STATES,
} from '../../src/contracts/frontmatter.js';
import {
	BANNED_CHARACTERS,
	BANNED_CHARS,
	bannedCharacterName,
	CHECK_IDS,
	DISABLE_COMMENT_PATTERN,
	EM_DASH_CHARS,
	EN_DASH_IN_PROSE,
	houseStyleRules,
	isProtectedRule,
	LINT_RULE_IDS,
	RULE_CATEGORIES,
	PROTECTED_RULES,
	RULE_ID_PATTERN,
} from '../../src/contracts/lint.js';
import { FINDING_CATEGORIES } from '../../src/contracts/diagnostics.js';
import type { LintConfig } from '../../src/contracts/project.js';
import {
	DEFAULT_BUDGETS,
	FORBIDDEN_SOURCE_NAMES,
	HEADING_ID_MODES,
	PARITY_MODES,
	PLAIN_CODE_LANGUAGE,
	PROJECT_ID_PATTERN,
	REPO_PATTERN,
	SECTION_KINDS,
} from '../../src/contracts/project.js';
import {
	COMMIT_SHA_PATTERN,
	RELEASE_DATE_PATTERN,
	SHA256_PATTERN,
	VERSION_LABEL_PATTERN,
} from '../../src/contracts/site.js';

describe('the audience enum', () => {
	test('spells the third member developer, not technical', () => {
		// Two spellings across the compiler and the manifest is a filter that quietly
		// matches nothing, so the constant is declared once and both sides import it.
		expect([...AUDIENCES]).toEqual(['user', 'developer', 'both']);
		expect(AUDIENCES as readonly string[]).not.toContain('technical');
		expect(DEFAULT_AUDIENCE).toBe('both');
	});
});

describe('page kinds', () => {
	test('exist so HowTo and FAQPage are declared rather than guessed from a section', () => {
		expect([...PAGE_KINDS]).toEqual(['article', 'howto', 'faq']);
		expect(DEFAULT_PAGE_KIND).toBe('article');
	});
});

describe('translation states', () => {
	test('include scaffolded, which timestamps cannot derive', () => {
		expect([...TRANSLATION_STATES]).toEqual([
			'source',
			'current',
			'stale',
			'scaffolded',
			'missing',
		]);
	});
});

describe('forbidden front matter keys', () => {
	test('every entry names the real owner of the fact', () => {
		const keys = Object.keys(FORBIDDEN_FRONT_MATTER_KEYS);
		expect(keys.length).toBeGreaterThan(15);
		for (const key of keys) {
			expect(FORBIDDEN_FRONT_MATTER_KEYS[key]?.length ?? 0).toBeGreaterThan(20);
		}
	});

	test('the ones that were removed on purpose say so', () => {
		expect(FORBIDDEN_FRONT_MATTER_KEYS['sourceDigest']).toMatch(/git committer dates/);
		expect(FORBIDDEN_FRONT_MATTER_KEYS['order']).toMatch(/nav\.json/);
		expect(FORBIDDEN_FRONT_MATTER_KEYS['noindex']).toMatch(/Derived/);
	});
});

describe('the banned character set', () => {
	test('the pattern is derived from the list, so names and matching cannot disagree', () => {
		expect(BANNED_CHARACTERS.length).toBeGreaterThan(10);
		for (const entry of BANNED_CHARACTERS) {
			const character = String.fromCodePoint(entry.codePoint);
			expect(BANNED_CHARS.test(character)).toBe(true);
			expect(bannedCharacterName(character)).toBe(entry.name);
		}
	});

	test('an ordinary character is not banned', () => {
		for (const character of ['a', '-', '.', ':', '(', 'あ']) {
			expect(BANNED_CHARS.test(character)).toBe(false);
		}
	});

	test('bannedCharacterName says nothing about a character that is allowed', () => {
		expect(bannedCharacterName('a')).toBeUndefined();
	});

	test('the em dash rule does not catch the katakana prolonged sound mark', () => {
		// Widening it would flag every ordinary Japanese word in the language least
		// likely to be proofread here, and the pressure would be to turn it off for ja.
		// Escaped, so this file carries no literal banned character for the house lint
		// to find. Same reason the rule itself is declared as code points.
		expect(EM_DASH_CHARS.test('\u2014')).toBe(true);
		expect(EM_DASH_CHARS.test('\u2015')).toBe(true);
		expect(EM_DASH_CHARS.test('\u30fc')).toBe(false);
		expect(EM_DASH_CHARS.test('\u30cf\u30fc\u30c9\u30a6\u30a7\u30a2')).toBe(false);
	});

	test('an en dash is allowed between digits and banned elsewhere', () => {
		expect(EN_DASH_IN_PROSE.test('2019\u20132024')).toBe(false);
		expect(EN_DASH_IN_PROSE.test('fast \u2013 simple')).toBe(true);
	});
});

describe('rule ids', () => {
	test('every id is kebab case with no doubled or trailing hyphen', () => {
		for (const id of [...LINT_RULE_IDS, ...CHECK_IDS]) expect(id).toMatch(RULE_ID_PATTERN);
	});

	test('the two id spaces do not overlap', () => {
		const checks = new Set<string>(CHECK_IDS);
		for (const id of LINT_RULE_IDS) expect(checks.has(id)).toBe(false);
	});

	test('every protected rule is a real lint rule', () => {
		const known = new Set<string>(LINT_RULE_IDS);
		for (const rule of PROTECTED_RULES) {
			expect(known.has(rule)).toBe(true);
			expect(isProtectedRule(rule)).toBe(true);
		}
		expect(isProtectedRule('no-triad')).toBe(false);
	});

	test('every house style rule is a real lint rule', () => {
		const known = new Set<string>(LINT_RULE_IDS);
		expect(houseStyleRules().length).toBeGreaterThan(5);
		for (const rule of houseStyleRules()) expect(known.has(rule)).toBe(true);
	});

	test('the wiring checks cover every edit the install makes', () => {
		const wiring = CHECK_IDS.filter((id) => id.startsWith('wiring-'));
		expect(wiring.length).toBeGreaterThanOrEqual(10);
		expect(wiring).toContain('wiring-deploy-hash-dirs');
		expect(wiring).toContain('wiring-allow-paths');
	});
});

describe('the suppression grammar', () => {
	test('requires a rule id and a reason', () => {
		expect(
			DISABLE_COMMENT_PATTERN.test(' hexdocs-disable-next-line no-em-dash: quoting a third party '),
		).toBe(true);
		expect(DISABLE_COMMENT_PATTERN.test(' hexdocs-disable-next-line no-em-dash ')).toBe(false);
		expect(DISABLE_COMMENT_PATTERN.test(' hexdocs-disable-next-line no-em-dash: ')).toBe(false);
	});

	test('captures both, so a reasonless suppression can be reported by rule', () => {
		const match = ' hexdocs-disable-next-line no-triad: three adjectives are the quotation '.match(
			DISABLE_COMMENT_PATTERN,
		);
		expect(match?.[1]).toBe('no-triad');
		expect(match?.[2]).toBe('three adjectives are the quotation');
	});
});

describe('the project config constants', () => {
	test('the plain code language exists, so "label every fence" and "box drawing" agree', () => {
		expect(PLAIN_CODE_LANGUAGE).toBe('text');
	});

	test('the forbidden source names are exactly what sync-public.sh prunes', () => {
		expect([...FORBIDDEN_SOURCE_NAMES]).toEqual(['CLAUDE.md', 'AGENTS.md', '.claude', '.agents']);
	});

	test('the description budget has a maximum and there is no minimum anywhere', () => {
		expect(DEFAULT_BUDGETS.descriptionMax).toBe(160);
		expect(Object.keys(DEFAULT_BUDGETS)).not.toContain('descriptionMin');
	});

	test('every budget is a positive integer', () => {
		for (const value of Object.values(DEFAULT_BUDGETS)) {
			expect(Number.isInteger(value)).toBe(true);
			expect(value).toBeGreaterThan(0);
		}
	});

	test('heading ids can be section numbers, which the legal documents need', () => {
		expect([...HEADING_ID_MODES]).toEqual(['slug', 'section-number']);
	});

	test('parity has a graceful mode, because hex-nfc ships English-only', () => {
		expect([...PARITY_MODES]).toEqual(['graceful', 'required']);
	});

	test('section kinds are the three the audience warning needs', () => {
		expect([...SECTION_KINDS]).toEqual(['manual', 'guide', 'reference']);
	});
});

describe('the identifier patterns', () => {
	test.each([
		[PROJECT_ID_PATTERN, 'hex-nfc', 'Hex_NFC'],
		[REPO_PATTERN, 'hexpro-dev/hex-nfc', 'hex-nfc'],
		[SHA256_PATTERN, 'a'.repeat(64), 'A'.repeat(64)],
		[COMMIT_SHA_PATTERN, '73b7be1ed9a1361bad35091207610e4f331493cf', '73b7be1'],
		[RELEASE_DATE_PATTERN, '2026-09-07', '07-09-2026'],
		[VERSION_LABEL_PATTERN, '1.0.0', 'a version'],
		[SEMVER_PATTERN, '1.0.0', 'v1.0.0'],
	])('%s accepts %s and rejects %s', (pattern, good, bad) => {
		expect(pattern.test(good)).toBe(true);
		expect(pattern.test(bad)).toBe(false);
	});
});

describe('the rule category map', () => {
	test('categorises every rule, so a new one cannot arrive ungrouped', () => {
		expect(Object.keys(RULE_CATEGORIES).sort()).toEqual([...LINT_RULE_IDS].sort());
	});

	test('every category it uses is a real finding category', () => {
		const known = new Set<string>(FINDING_CATEGORIES);
		for (const category of Object.values(RULE_CATEGORIES)) expect(known.has(category)).toBe(true);
	});

	test('houseStyleRules is derived from it, not a second hand-written list', () => {
		expect(houseStyleRules()).toEqual(
			LINT_RULE_IDS.filter((id) => RULE_CATEGORIES[id] === 'house-style'),
		);
		expect(houseStyleRules().length).toBeGreaterThan(5);
	});

	test('the asset rules include the SVG refusal, and it cannot be switched off', () => {
		// An SVG asset is a same-origin document on the consuming site when navigated to
		// directly, however safe it is inside an img element.
		expect(RULE_CATEGORIES['asset-svg-unsafe']).toBe('assets');
		expect(isProtectedRule('asset-svg-unsafe')).toBe(true);
	});
});

describe('competitor names do not live in the publishable tree', () => {
	// The list of things that must not ship lived in docs/site/docs.json, which
	// `hexdocs init` adds to sync-public.sh's ALLOW_PATHS: the list of things that must
	// not ship, shipped. It reads DenyList.strings now, at docs/docs.private.json,
	// outside the tree the publisher reads.
	//
	// The previous version of this block asserted `Object.keys({ extends, maxDisables })`
	// does not contain 'forbiddenTerms', which is true of an object literal whatever the
	// interface says, and `Object.keys({} as Required<LintConfig>)`, where the cast is
	// erased and the expression is `[].includes(...)`. Both were tautologies: re-adding
	// `forbiddenTerms?: string[]` to LintConfig left the whole runtime suite green. What
	// actually holds the line is the drift assertion in kit/src/contracts/drift.ts, and
	// what this reads is the source, so a failure here names the file to edit.
	const sources = [
		[
			'src/contracts/project.ts',
			readFileSync(new URL('../../src/contracts/project.ts', import.meta.url), 'utf8'),
		],
		[
			'kit/schema/docs-1.json',
			readFileSync(new URL('../../kit/schema/docs-1.json', import.meta.url), 'utf8'),
		],
	] as const;

	test.each(sources)('%s declares no forbiddenTerms field', (_where, text) => {
		// A file that moved reads as empty and would otherwise pass, which is the same
		// zero-things-examined failure this test was written to replace.
		expect(text.length).toBeGreaterThan(1000);
		// A declaration, not the word: the comment in project.ts names the old key on
		// purpose, because the reason it moved is the thing worth keeping. Matching the
		// word would force that comment out, and the comment is the guard here.
		expect(/^\s*"?forbiddenTerms"?\??\s*:/m.test(text)).toBe(false);
	});

	test('the deny list it moved to is declared outside docs/site, where the publisher cannot read it', () => {
		const project = sources[0][1];
		expect(project).toContain('docs/docs.private.json');
		expect(project).toContain('DenyList');
		// The path matters more than the type name: docs/site is the tree copied into
		// the public mirror, and a deny list inside it is the original bug.
		expect(project).not.toContain('docs/site/docs.private.json');
	});
});
