/**
 * Zod mirrors of the four files a human or an agent writes: page front matter,
 * `nav.json`, `docs/site/docs.json` and `<project>.docs.json`, plus the deny list.
 *
 * Every object here is strict. That is the single most load-bearing property in this
 * file: a typo'd `discription:` has to fail rather than silently do nothing, and an
 * earlier design of the site config carried an origin URL, a CDN host and a cache TTL,
 * all of which are now wrong. A permissive schema is how one of them gets added back
 * by somebody debugging a cache miss.
 */

import { z } from 'zod';

import { matchLocale } from '../../../src/contracts/locales.js';

import type { AssertExactUnion, Expect } from '../../../src/contracts/exact.js';

import {
	AUDIENCES,
	FORBIDDEN_FRONT_MATTER_KEYS,
	PAGE_KINDS,
	TRANSLATION_STATES,
	type DocFrontMatter,
	type LocalisedLabel,
	type SnippetFrontMatter,
	type TranslationRecord,
} from '../../../src/contracts/frontmatter.js';
import {
	DOCS_CONFIG_VERSION,
	HEADING_ID_MODES,
	PARITY_MODES,
	SECTION_KINDS,
} from '../../../src/contracts/project.js';
import type {
	BudgetConfig,
	CodeConfig,
	DenyList,
	DocsProjectConfig,
	GlossaryEntry,
	I18nConfig,
	LintConfig,
	SectionConfig,
	TocConfig,
} from '../../../src/contracts/project.js';
import { LINT_RULE_IDS, PROTECTED_RULES } from '../../../src/contracts/lint.js';
import type { RuleConfig, RuleSetting } from '../../../src/contracts/lint.js';
import { SEVERITIES } from '../../../src/contracts/diagnostics.js';
import { MAX_NAV_DEPTH, NAV_GROUP_ID_PATTERN, NAV_VERSION } from '../../../src/contracts/nav.js';
import type { NavItem, NavTree } from '../../../src/contracts/nav.js';
import { SITE_CONFIG_VERSION } from '../../../src/contracts/site.js';
import type { DocsSiteConfig, VersionEntry } from '../../../src/contracts/site.js';
import {
	commitShaSchema,
	countSchema,
	httpsUrlSchema,
	localeSchema,
	projectIdSchema,
	releaseDateSchema,
	repoSchema,
	semverSchema,
	sha256Schema,
	slugSchema,
	utcTimestampSchema,
	versionLabelSchema,
} from './primitives.js';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Every locale required. A partially translated nav label is not a state worth
 * supporting: the failure is an English word under an Arabic heading in a
 * right-to-left column, which reads as a bug to every reader who sees it and to none
 * of the people able to fix it.
 */
export const localisedLabelSchema: z.ZodType<LocalisedLabel> = z.record(
	localeSchema,
	z.string().min(1).max(40),
);

/**
 * Accepted and ignored on every root object.
 *
 * Editors resolve a relative `$schema` against the file, so a path into the mounted
 * submodule gives completion with nothing hosted anywhere. It has to be declared
 * because these schemas are strict, and a tool that rejects the files it generates
 * itself is worse than one with no completion at all.
 */
const schemaRefSchema = z.string().optional();

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

export const frontMatterSchema = z.strictObject({
	// Non-empty, and nothing more. This was `min(3)` until the fixture corpus was
	// translated and the Chinese guide came back titled 指南, which is two characters and
	// entirely correct. It is the same density argument the description already carried,
	// applied to the field nobody had thought to apply it to: a floor measured in
	// characters is a floor on Latin, and it rejects correct CJK.
	title: z.string().min(1),
	// Maximum only. The project's `budgets.titleMax` and `budgets.descriptionMax` are
	// applied by the linter, which knows them; the schema enforces only what is true
	// for every project. A floor on description would reject correct Japanese.
	description: z.string().min(1),
	audience: z.enum(AUDIENCES).optional(),
	pageKind: z.enum(PAGE_KINDS).optional(),
	navTitle: z.string().min(2).max(30).optional(),
	tags: z.array(z.string().min(1)).max(8).optional(),
	since: semverSchema.optional(),
	redirectFrom: z.array(slugSchema).max(10).optional(),
	draft: z.boolean().optional(),
	toc: z.literal(false).optional(),
	translated: z.literal(false).optional(),
});

/**
 * The explanation for a key a page may not declare.
 *
 * Kept out of the schema itself so that `frontMatterSchema` stays a plain strict
 * object and the drift check against `DocFrontMatter` stays exact. The loader turns
 * Zod's generic unrecognised-key issue into a finding that names the real owner of
 * the fact, which is the difference between "unknown key: order" and "ordering is
 * nav.json".
 */
export function describeForbiddenKey(key: string): string | undefined {
	return FORBIDDEN_FRONT_MATTER_KEYS[key];
}

export const snippetFrontMatterSchema = z.strictObject({
	title: z.string().min(1),
});

export const translationRecordSchema = z.strictObject({
	state: z.enum(TRANSLATION_STATES),
	sourceUpdated: utcTimestampSchema,
	translationUpdated: utcTimestampSchema.optional(),
});

// ---------------------------------------------------------------------------
// nav.json
// ---------------------------------------------------------------------------

export const navDocSchema = z.strictObject({
	doc: slugSchema,
	// The value is the reason. A page that vanishes from every listing is exactly the
	// state somebody needs to be able to explain a year later.
	hidden: z.string().min(8).optional(),
});

export const navLinkSchema = z.strictObject({
	link: httpsUrlSchema,
	label: localisedLabelSchema,
	external: z.literal(true),
});

export const navGroupSchema = z.strictObject({
	group: z.string().regex(NAV_GROUP_ID_PATTERN),
	label: localisedLabelSchema,
	collapsed: z.boolean().optional(),
	get items() {
		return z.array(navItemSchema).min(1);
	},
});

/**
 * The three item shapes, keyed by the field that identifies each.
 *
 * A registry rather than an inline array, for the same reason the AST node schemas are
 * one. `z.ZodType<NavItem>` is an *annotation*, and an annotation only asks that the
 * schema's output be assignable to the type, which is the one-way check the drift file
 * exists to replace. Adding `order: z.int().optional()` to the group schema typechecked,
 * passed every test, and shipped a `nav.json` key `NavItem` does not have. The
 * assertions below make the comparison invariant in both directions.
 *
 * `z.union` rather than `z.discriminatedUnion`: the three share no discriminant field
 * and are told apart by which key is present.
 *
 * Depth is not expressible here. A Zod schema cannot say "at most three levels" without
 * threading a counter, so `navDepth` checks it where the error can name the group.
 */
export const NAV_ITEM_SCHEMAS = {
	doc: navDocSchema,
	group: navGroupSchema,
	link: navLinkSchema,
} as const satisfies Record<'doc' | 'group' | 'link', z.ZodType>;

export const navItemSchema = z.union(
	Object.values(NAV_ITEM_SCHEMAS) as unknown as [z.ZodType, z.ZodType],
) as unknown as z.ZodType<NavItem>;

type NavItemFromRegistry = z.infer<(typeof NAV_ITEM_SCHEMAS)[keyof typeof NAV_ITEM_SCHEMAS]>;
type _navItemRegistryExact = Expect<AssertExactUnion<NavItemFromRegistry, NavItem>>;

/*
 * The union form reports whole members, and an added *optional* key is invisible to it
 * in both directions: the widened member is still assignable to `NavItem`, so `Exclude`
 * drops it and the error reads `{ onlyInFirst: never; onlyInSecond: never }`, naming
 * nothing. Measured with exactly that mutation, `order: z.int().optional()` on
 * `navGroupSchema`. Each member is compared key by key in `drift.ts`, alongside every
 * other per-object assertion, and that is where a stray `order` is named directly.
 */

export const navTreeSchema = z.strictObject({
	$schema: schemaRefSchema,
	nav: z.literal(NAV_VERSION),
	items: z.array(navItemSchema),
});

/** Checked outside the schema, where the message can name the offending group. */
export const NAV_DEPTH_LIMIT = MAX_NAV_DEPTH;

// ---------------------------------------------------------------------------
// docs/site/docs.json
// ---------------------------------------------------------------------------

export const sectionConfigSchema = z.strictObject({
	id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	kind: z.enum(SECTION_KINDS),
});

export const i18nConfigSchema = z.strictObject({
	locales: z.array(localeSchema).min(1),
	sourceLocale: z.literal('en'),
	parity: z.enum(PARITY_MODES),
});

export const budgetConfigSchema = z.strictObject({
	titleMax: z.int().min(10),
	descriptionMax: z.int().min(40),
	pageBytesMax: z.int().min(1024),
	codeFenceBytesMax: z.int().min(1024),
	tableRowsMax: z.int().min(1),
	nestingDepthMax: z.int().min(4),
	assetBytesMax: z.int().min(1024),
	bundleBytesMax: z.int().min(1024),
});

export const codeConfigSchema = z.strictObject({
	languages: z.array(z.string().min(1)).min(1),
});

export const tocConfigSchema = z.strictObject({
	enabled: z.boolean(),
	maxDepth: z.union([z.literal(2), z.literal(3), z.literal(4)]),
	minHeadings: z.int().min(0),
});

export const ruleConfigSchema = z.strictObject({
	severity: z.enum(SEVERITIES),
	locales: z.array(localeSchema).optional(),
});

export const ruleSettingSchema = z.union([
	z.enum(['error', 'warning', 'info', 'off'] as const),
	ruleConfigSchema,
]);

export const lintConfigSchema = z.strictObject({
	extends: z.literal('house'),
	maxDisables: z.int().min(0),
	rules: z.partialRecord(z.enum(LINT_RULE_IDS), ruleSettingSchema).optional(),
	bannedPhrases: z
		.array(
			z.strictObject({
				phrase: z.string().min(1),
				replacement: z.string().min(1).nullable(),
				why: z.string().min(1),
			}),
		)
		.optional(),
	technicalTerms: z.array(z.string().min(1)).optional(),
});

export const glossaryEntrySchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('do-not-translate'),
		term: z.string().min(1),
		note: z.string().optional(),
	}),
	z.strictObject({
		kind: z.literal('translate'),
		term: z.string().min(1),
		translations: z.record(localeSchema, z.string().min(1)),
		note: z.string().optional(),
	}),
]);

export const docsProjectConfigSchema = z
	.strictObject({
		$schema: schemaRefSchema,
		docs: z.literal(DOCS_CONFIG_VERSION),
		project: projectIdSchema,
		productName: z.string().min(1),
		repo: repoSchema,
		defaultAudience: z.enum(AUDIENCES),
		headingIds: z.enum(HEADING_ID_MODES),
		sections: z.array(sectionConfigSchema),
		i18n: i18nConfigSchema,
		budgets: budgetConfigSchema,
		code: codeConfigSchema,
		toc: tocConfigSchema,
		lint: lintConfigSchema,
		taxonomy: z.strictObject({ tags: z.array(z.string().min(1)) }).optional(),
		glossary: z.array(glossaryEntrySchema).optional(),
	})
	.superRefine((config, context) => {
		// `PROTECTED_RULES` says "the schema enforces this, not a convention in a comment",
		// and until this refinement existed that was false: the check lived in the exported
		// function below, whose only callers were two test files. `loadProject` never called
		// it, so no compile and no publish path did, and a config setting `internal-leak: off`
		// parsed clean, validated clean against the generated JSON Schema, and was committed
		// and reviewed as correct. Nothing leaked, because `resolveSeverity` clamps at runtime,
		// but a runtime clamp is not a guarantee a reader of the config can see.
		//
		// Here rather than in `lintConfigSchema` because the message should name the file the
		// author edits, and here rather than only in the loader because a parse that succeeds
		// is what every other reader of a config trusts.
		for (const problem of protectedRuleViolations(config as DocsProjectConfig)) {
			context.addIssue({ code: 'custom', path: ['lint', 'rules'], message: problem });
		}
	});

/**
 * A project may raise a severity and may not lower a protected rule.
 *
 * Enforced rather than documented, because the estate's house rules are stated as
 * hard rules and a config that could switch one off would switch it off on the first
 * build it inconvenienced. Kept as a separate check so the base schema's inferred type
 * stays exactly `DocsProjectConfig`.
 */
export function protectedRuleViolations(config: DocsProjectConfig): string[] {
	const problems: string[] = [];
	const rules = config.lint.rules ?? {};
	for (const rule of PROTECTED_RULES) {
		const setting = rules[rule];
		if (setting === undefined) continue;
		const severity = typeof setting === 'string' ? setting : setting.severity;
		if (severity !== 'error') {
			problems.push(
				`lint.rules.${rule} is set to "${severity}". It is a protected rule and may only be "error": ` +
					`the estate-wide guarantee it carries is not a per-project preference.`,
			);
		}
	}
	return problems;
}

export const denyListSchema = z.strictObject({
	$schema: schemaRefSchema,
	private: z.literal(1),
	strings: z.array(z.string().min(1)),
	patterns: z.array(
		z.strictObject({
			id: z.string().min(1),
			pattern: z.string().min(1),
			flags: z.string(),
			why: z.string().min(1),
		}),
	),
});

// ---------------------------------------------------------------------------
// <project>.docs.json
// ---------------------------------------------------------------------------

export const versionEntrySchema = z.strictObject({
	label: versionLabelSchema,
	commit: commitShaSchema,
	released: releaseDateSchema,
	default: z.literal(true).optional(),
	digest: sha256Schema.optional(),
});

export const docsSiteConfigSchema = z.strictObject({
	$schema: schemaRefSchema,
	site: z.literal(SITE_CONFIG_VERSION),
	project: projectIdSchema,
	// Leading slash, no trailing slash, no locale segment. A basePath carrying a locale
	// would have to exist seven times.
	basePath: z
		.string()
		// Segment form, so `/hex-nfc//docs` is refused rather than quietly collapsed. A
		// validator that rewrites a copy-paste hides the copy-paste.
		.regex(
			/^\/[a-z0-9]+(?:[-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-][a-z0-9]+)*)*$/,
			'Expected /project/docs: leading slash, no trailing slash, no empty segment.',
		)
		// The locale is added by the address builder, because English is unprefixed and
		// the other six are not. A basePath carrying one would have to exist seven times,
		// and the way it gets in is somebody pasting a docs URL out of their browser
		// while reading the Japanese page. Derived from `matchLocale` so this stays true
		// for an eighth language, and so it already covers `pt-br` and `zh-hans`.
		.refine((value) => {
			const first = value.split('/')[1] ?? '';
			return !matchLocale(first).ok;
		}, 'basePath must not start with a locale segment: the locale is added per request.'),
	themeClass: z
		.string()
		.regex(/^[a-z][a-z0-9-]*$/)
		.optional(),
	navLabel: localisedLabelSchema,
	versions: z.array(versionEntrySchema).min(1),
	pages: z.array(slugSchema),
});

/**
 * The version table's invariants: exactly one default, no repeated label, no repeated
 * commit. Checked here rather than in the schema so each message can name the entries
 * that collided.
 */
export function versionTableProblems(config: DocsSiteConfig): string[] {
	const problems: string[] = [];

	const defaults = config.versions.filter((entry) => entry.default === true);
	if (defaults.length === 0) {
		problems.push(
			'No version is marked `"default": true`. Nothing would be served at the unprefixed address.',
		);
	} else if (defaults.length > 1) {
		problems.push(
			`${defaults.length} versions are marked default (${defaults.map((entry) => entry.label).join(', ')}). ` +
				`Exactly one is served at the unprefixed address, listed in the sitemap and indexable.`,
		);
	}

	// A label is a URL segment under /v/<label>/, so two entries sharing one means two
	// bundles at one address and whichever the lookup finds first wins.
	const seenLabels = new Set<string>();
	for (const entry of config.versions) {
		if (seenLabels.has(entry.label)) {
			problems.push(
				`Two versions are labelled "${entry.label}". A label is a URL segment and must be unique.`,
			);
		}
		seenLabels.add(entry.label);
	}

	// Two labels on one commit is legal in principle and almost always a copy-paste, so
	// it is worth naming rather than refusing.
	const byCommit = new Map<string, string[]>();
	for (const entry of config.versions) {
		byCommit.set(entry.commit, [...(byCommit.get(entry.commit) ?? []), entry.label]);
	}
	for (const [commit, labels] of byCommit) {
		if (labels.length > 1) {
			problems.push(
				`Versions ${labels.join(' and ')} both point at ${commit.slice(0, 8)}. They would serve identical bytes at two addresses.`,
			);
		}
	}

	return problems;
}

// ---------------------------------------------------------------------------
// Unused-import anchors for the drift file
// ---------------------------------------------------------------------------

export type {
	BudgetConfig,
	CodeConfig,
	DenyList,
	DocFrontMatter,
	DocsProjectConfig,
	DocsSiteConfig,
	GlossaryEntry,
	I18nConfig,
	LintConfig,
	NavTree,
	RuleConfig,
	RuleSetting,
	SectionConfig,
	SnippetFrontMatter,
	TocConfig,
	TranslationRecord,
	VersionEntry,
};

export { countSchema };
