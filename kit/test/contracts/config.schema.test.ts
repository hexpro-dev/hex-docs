import { describe, expect, test } from 'vitest';

import { LOCALES } from '../../../src/contracts/locales.js';
import {
	DEFAULT_BUDGETS,
	FORBIDDEN_SOURCE_NAMES,
	PLAIN_CODE_LANGUAGE,
} from '../../../src/contracts/project.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';
import type { DocsSiteConfig } from '../../../src/contracts/site.js';
import { PROTECTED_RULES } from '../../../src/contracts/lint.js';
import { FORBIDDEN_FRONT_MATTER_KEYS } from '../../../src/contracts/frontmatter.js';
import {
	versionTableProblems,
	denyListSchema,
	describeForbiddenKey,
	docsProjectConfigSchema,
	docsSiteConfigSchema,
	frontMatterSchema,
	navTreeSchema,
	protectedRuleViolations,
	snippetFrontMatterSchema,
} from '../../src/contracts/config.schema.js';

const label = Object.fromEntries(LOCALES.map((l) => [l, `Docs ${l}`]));

const PROJECT = {
	$schema: '../../hex-docs/kit/schema/docs-1.json',
	docs: 1,
	project: 'hex-nfc',
	productName: 'Hex NFC',
	repo: 'hexpro-dev/hex-nfc',
	defaultAudience: 'both',
	headingIds: 'slug',
	sections: [{ id: 'guide', kind: 'guide' }],
	i18n: { locales: ['en'], sourceLocale: 'en', parity: 'graceful' },
	budgets: DEFAULT_BUDGETS,
	code: { languages: [PLAIN_CODE_LANGUAGE, 'swift', 'bash'] },
	toc: { enabled: true, maxDepth: 3, minHeadings: 3 },
	lint: { extends: 'house', maxDisables: 0 },
} as const;

const SITE = {
	site: 1,
	project: 'hex-nfc',
	basePath: '/hex-nfc/docs',
	themeClass: 'app-hex-nfc',
	navLabel: label,
	versions: [
		{
			label: '1.0.0',
			commit: '73b7be1ed9a1361bad35091207610e4f331493cf',
			released: '2026-09-07',
			default: true,
		},
	],
	pages: ['index', 'guide/first-tag'],
} as const;

describe('front matter', () => {
	test('the smallest valid page is a title and a description', () => {
		expect(
			frontMatterSchema.safeParse({
				title: 'Scanning a tag',
				description: 'How to read an NDEF tag.',
			}).success,
		).toBe(true);
	});

	test('audience and pageKind are optional, so a scaffolded page is not a validation error', () => {
		const parsed = frontMatterSchema.parse({ title: 'A page', description: 'x' });
		expect(parsed.audience).toBeUndefined();
		expect(parsed.pageKind).toBeUndefined();
	});

	test('description has a maximum enforced per project and no minimum here', () => {
		// A global floor of fifty characters rejects correct Japanese, where character
		// density is roughly double English.
		expect(
			frontMatterSchema.safeParse({ title: 'タグの読み取り', description: 'NDEFタグを読む方法。' })
				.success,
		).toBe(true);
	});

	test('a typo is a failure, not a silent no-op', () => {
		expect(
			frontMatterSchema.safeParse({ title: 'A page', description: 'x', discription: 'y' }).success,
		).toBe(false);
	});

	test.each(Object.keys(FORBIDDEN_FRONT_MATTER_KEYS))(
		'%s is refused and the reason names the real owner',
		(key) => {
			expect(
				frontMatterSchema.safeParse({ title: 'A page', description: 'x', [key]: 'anything' })
					.success,
			).toBe(false);
			expect(describeForbiddenKey(key)?.length ?? 0).toBeGreaterThan(20);
		},
	);

	test('sourceDigest is refused, because the mechanism it belonged to was removed', () => {
		expect(describeForbiddenKey('sourceDigest')).toMatch(/git committer dates/);
	});

	test('describeForbiddenKey says nothing about a key that is merely unknown', () => {
		expect(describeForbiddenKey('bananas')).toBeUndefined();
	});

	test('toc can only be suppressed, never enabled, so it cannot disagree with the project default', () => {
		expect(
			frontMatterSchema.safeParse({ title: 'A page', description: 'x', toc: false }).success,
		).toBe(true);
		expect(
			frontMatterSchema.safeParse({ title: 'A page', description: 'x', toc: true }).success,
		).toBe(false);
	});

	test('translated can only be false, because it marks a scaffold rather than a state', () => {
		expect(
			frontMatterSchema.safeParse({ title: 'A page', description: 'x', translated: false }).success,
		).toBe(true);
		expect(
			frontMatterSchema.safeParse({ title: 'A page', description: 'x', translated: true }).success,
		).toBe(false);
	});

	test('since must be three numeric parts with no v prefix', () => {
		expect(
			frontMatterSchema.safeParse({ title: 'A page', description: 'x', since: '1.0.0' }).success,
		).toBe(true);
		for (const bad of ['v1.0.0', '1.0', '1.0.0-beta', '01.0.0']) {
			expect(
				frontMatterSchema.safeParse({ title: 'A page', description: 'x', since: bad }).success,
			).toBe(false);
		}
	});

	test('a snippet uses its own schema, because it has no slug, address or audience', () => {
		expect(snippetFrontMatterSchema.safeParse({ title: 'Compatibility note' }).success).toBe(true);
		expect(snippetFrontMatterSchema.safeParse({ title: 'x', description: 'y' }).success).toBe(
			false,
		);
		expect(frontMatterSchema.safeParse({ title: 'Compatibility note' }).success).toBe(false);
	});
});

describe('nav.json', () => {
	test('a nav label must exist in all seven languages', () => {
		const partial = { en: 'Guide', ja: 'ガイド' };
		expect(
			navTreeSchema.safeParse({
				nav: 1,
				items: [{ group: 'g', label: partial, items: [{ doc: 'index' }] }],
			}).success,
		).toBe(false);
		expect(
			navTreeSchema.safeParse({ nav: 1, items: [{ group: 'g', label, items: [{ doc: 'index' }] }] })
				.success,
		).toBe(true);
	});

	test('an empty group is refused: it is a heading with nothing under it', () => {
		expect(
			navTreeSchema.safeParse({ nav: 1, items: [{ group: 'g', label, items: [] }] }).success,
		).toBe(false);
	});

	test('hiding a page requires a written reason', () => {
		expect(
			navTreeSchema.safeParse({ nav: 1, items: [{ doc: 'index', hidden: true }] }).success,
		).toBe(false);
		expect(
			navTreeSchema.safeParse({ nav: 1, items: [{ doc: 'index', hidden: 'x' }] }).success,
		).toBe(false);
		expect(
			navTreeSchema.safeParse({
				nav: 1,
				items: [{ doc: 'index', hidden: 'Linked from support replies only.' }],
			}).success,
		).toBe(true);
	});

	test('an external link must be https', () => {
		expect(
			navTreeSchema.safeParse({ nav: 1, items: [{ link: 'http://x.dev', label, external: true }] })
				.success,
		).toBe(false);
		expect(
			navTreeSchema.safeParse({ nav: 1, items: [{ link: 'https://x.dev', label, external: true }] })
				.success,
		).toBe(true);
	});

	test('$schema is accepted and ignored, so the tool does not reject the files it generates', () => {
		expect(
			navTreeSchema.safeParse({ $schema: '../x.json', nav: 1, items: [{ doc: 'index' }] }).success,
		).toBe(true);
	});

	test('nesting is recursive', () => {
		const nested = {
			nav: 1,
			items: [{ group: 'a', label, items: [{ group: 'b', label, items: [{ doc: 'index' }] }] }],
		};
		expect(navTreeSchema.safeParse(nested).success).toBe(true);
	});
});

describe('docs.json, the source project config', () => {
	test('the worked hex-nfc config validates', () => {
		const parsed = docsProjectConfigSchema.safeParse(PROJECT);
		expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
	});

	test('an English-only project is a supported state, because hex-nfc is one', () => {
		expect(
			docsProjectConfigSchema.safeParse({
				...PROJECT,
				i18n: { locales: ['en'], sourceLocale: 'en', parity: 'graceful' },
			}).success,
		).toBe(true);
	});

	test('the source locale is always English', () => {
		expect(
			docsProjectConfigSchema.safeParse({
				...PROJECT,
				i18n: { locales: ['ja'], sourceLocale: 'ja', parity: 'graceful' },
			}).success,
		).toBe(false);
	});

	test('locale aliases are not a project key: normalisation is a package decision', () => {
		expect(
			docsProjectConfigSchema.safeParse({
				...PROJECT,
				i18n: { ...PROJECT.i18n, aliases: { 'zh-CN': 'zh' } },
			}).success,
		).toBe(false);
	});

	test('a project id is slug-shaped, because it is an S3 prefix and a URL segment', () => {
		for (const bad of ['Hex_NFC', 'hex nfc', 'hex/nfc', '-hex']) {
			expect(docsProjectConfigSchema.safeParse({ ...PROJECT, project: bad }).success).toBe(false);
		}
	});

	test('a repo is owner/name', () => {
		expect(docsProjectConfigSchema.safeParse({ ...PROJECT, repo: 'hex-nfc' }).success).toBe(false);
	});

	test('an unknown rule id is a schema error, not a silently ignored key', () => {
		expect(
			docsProjectConfigSchema.safeParse({
				...PROJECT,
				lint: { ...PROJECT.lint, rules: { 'no-emm-dash': 'off' } },
			}).success,
		).toBe(false);
		expect(
			docsProjectConfigSchema.safeParse({
				...PROJECT,
				lint: { ...PROJECT.lint, rules: { 'no-em-dash': 'error' } },
			}).success,
		).toBe(true);
	});

	test.each(PROTECTED_RULES)('%s cannot be lowered below error', (rule) => {
		// The parse itself refuses now, which is what `PROTECTED_RULES` always claimed. This
		// test used to parse the lowered config successfully and then call the exported
		// check by hand, and that was the whole of the enforcement: `loadProject` never
		// called it, so a config setting `internal-leak: off` parsed clean, validated clean
		// against the generated JSON Schema and was committed as correct.
		const result = docsProjectConfigSchema.safeParse({
			...PROJECT,
			lint: { ...PROJECT.lint, rules: { [rule]: 'warning' } },
		});
		expect(result.success, `${rule} was accepted at warning`).toBe(false);
		const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
		expect(messages.join(' ')).toContain(rule);
		expect(messages.join(' ')).toContain('not a per-project preference');

		// And the exported function still answers the same question, because the consumer
		// sweep calls it on configs it did not parse with this schema.
		expect(
			protectedRuleViolations({
				...PROJECT,
				lint: { ...PROJECT.lint, rules: { [rule]: 'warning' } },
			} as unknown as DocsProjectConfig).length,
		).toBe(1);
	});

	test.each(PROTECTED_RULES)('%s at error is fine, and so is leaving it alone', (rule) => {
		const raised = docsProjectConfigSchema.parse({
			...PROJECT,
			lint: { ...PROJECT.lint, rules: { [rule]: 'error' } },
		});
		expect(protectedRuleViolations(raised as DocsProjectConfig)).toEqual([]);
		expect(
			protectedRuleViolations(docsProjectConfigSchema.parse(PROJECT) as DocsProjectConfig),
		).toEqual([]);
	});

	test('a protected rule set to off through the object form is caught too', () => {
		expect(
			docsProjectConfigSchema.safeParse({
				...PROJECT,
				lint: { ...PROJECT.lint, rules: { 'no-em-dash': { severity: 'info' } } },
			}).success,
		).toBe(false);
	});

	test('the glossary is a list of tagged entries, so a term cannot be half-declared', () => {
		const translations = Object.fromEntries(LOCALES.map((l) => [l, `tag-${l}`]));
		expect(
			docsProjectConfigSchema.safeParse({
				...PROJECT,
				glossary: [{ kind: 'do-not-translate', term: 'NDEF' }],
			}).success,
		).toBe(true);
		expect(
			docsProjectConfigSchema.safeParse({
				...PROJECT,
				glossary: [{ kind: 'translate', term: 'tag', translations }],
			}).success,
		).toBe(true);
		expect(
			docsProjectConfigSchema.safeParse({
				...PROJECT,
				glossary: [{ kind: 'translate', term: 'tag', translations: { en: 'tag' } }],
			}).success,
		).toBe(false);
		expect(
			docsProjectConfigSchema.safeParse({ ...PROJECT, glossary: [{ term: 'NDEF' }] }).success,
		).toBe(false);
	});

	test('the plain code language exists, so "say what this is" and "box drawing" do not contradict', () => {
		expect(PROJECT.code.languages).toContain(PLAIN_CODE_LANGUAGE);
	});

	test('the forbidden source names are the four sync-public.sh prunes', () => {
		expect([...FORBIDDEN_SOURCE_NAMES]).toEqual(['CLAUDE.md', 'AGENTS.md', '.claude', '.agents']);
	});
});

describe('docs.private.json, the deny list', () => {
	test('a minimal deny list validates', () => {
		expect(denyListSchema.safeParse({ private: 1, strings: [], patterns: [] }).success).toBe(true);
	});

	test('a pattern must say why, because the list is read by people who did not write it', () => {
		expect(
			denyListSchema.safeParse({
				private: 1,
				strings: [],
				patterns: [{ id: 'udid', pattern: '[0-9a-f]{40}', flags: 'i' }],
			}).success,
		).toBe(false);
	});
});

describe('<project>.docs.json, the consumer config', () => {
	test('the worked hex-nfc mount validates', () => {
		const parsed = docsSiteConfigSchema.safeParse(SITE);
		expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
	});

	test('the resurrected runtime-fetch keys are refused', () => {
		// Every one of these was in an earlier design and is now wrong. A permissive
		// schema is how one comes back during a late-night cache debug.
		for (const key of ['origin', 'cdnUrl', 'cacheControl', 'diskCache', 'mode', 'timeoutMs']) {
			expect(docsSiteConfigSchema.safeParse({ ...SITE, [key]: 'anything' }).success).toBe(false);
		}
	});

	test('basePath carries no trailing slash and no locale', () => {
		expect(docsSiteConfigSchema.safeParse({ ...SITE, basePath: '/hex-nfc/docs/' }).success).toBe(
			false,
		);
		expect(docsSiteConfigSchema.safeParse({ ...SITE, basePath: 'hex-nfc/docs' }).success).toBe(
			false,
		);
		expect(docsSiteConfigSchema.safeParse({ ...SITE, basePath: '/hex-nfc/docs' }).success).toBe(
			true,
		);
	});

	test('a commit must be the full forty characters, because abbreviations collide', () => {
		expect(
			docsSiteConfigSchema.safeParse({
				...SITE,
				versions: [{ ...SITE.versions[0], commit: '73b7be1' }],
			}).success,
		).toBe(false);
		expect(
			docsSiteConfigSchema.safeParse({
				...SITE,
				versions: [{ ...SITE.versions[0], commit: '73B7BE1ED9A1361BAD35091207610E4F331493CF' }],
			}).success,
		).toBe(false);
	});

	test('exactly one version is the default', () => {
		expect(versionTableProblems(SITE as unknown as DocsSiteConfig)).toEqual([]);

		const none = { ...SITE, versions: [{ ...SITE.versions[0], default: undefined }] };
		expect(versionTableProblems(none as unknown as DocsSiteConfig)[0]).toContain(
			'No version is marked',
		);

		const two = {
			...SITE,
			versions: [
				SITE.versions[0],
				{ label: '1.1.0', commit: 'b'.repeat(40), released: '2026-10-01', default: true },
			],
		};
		expect(versionTableProblems(two as unknown as DocsSiteConfig)[0]).toContain(
			'2 versions are marked default',
		);
		expect(versionTableProblems(two as unknown as DocsSiteConfig)[0]).toContain('1.0.0, 1.1.0');
	});

	test('two versions cannot share a label: it is a URL segment', () => {
		const clash = {
			...SITE,
			versions: [
				SITE.versions[0],
				{ label: '1.0.0', commit: 'b'.repeat(40), released: '2026-10-01' },
			],
		};
		const problems = versionTableProblems(clash as unknown as DocsSiteConfig);
		expect(problems.some((p) => p.includes('Two versions are labelled "1.0.0"'))).toBe(true);
	});

	test('two labels on one commit are named, because it is nearly always a copy-paste', () => {
		const clash = {
			...SITE,
			versions: [
				SITE.versions[0],
				{ label: '1.0.1', commit: SITE.versions[0]?.commit, released: '2026-10-01' },
			],
		};
		const problems = versionTableProblems(clash as unknown as DocsSiteConfig);
		expect(problems.some((p) => p.includes('both point at 73b7be1e'))).toBe(true);
	});

	test('at least one version, because a config with none serves nothing', () => {
		expect(docsSiteConfigSchema.safeParse({ ...SITE, versions: [] }).success).toBe(false);
	});

	test('a manifest digest is optional and, when present, a full sha256', () => {
		expect(
			docsSiteConfigSchema.safeParse({
				...SITE,
				versions: [{ ...SITE.versions[0], digest: 'f'.repeat(64) }],
			}).success,
		).toBe(true);
		expect(
			docsSiteConfigSchema.safeParse({
				...SITE,
				versions: [{ ...SITE.versions[0], digest: 'short' }],
			}).success,
		).toBe(false);
	});

	test('pages is a slug list, so a bad entry fails here rather than at route derivation', () => {
		expect(
			docsSiteConfigSchema.safeParse({ ...SITE, pages: ['index', 'Guide/First'] }).success,
		).toBe(false);
	});
});
