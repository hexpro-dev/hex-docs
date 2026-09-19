/**
 * The package's public surface, pinned by name.
 *
 * A consuming site imports from `@hex-pro/docs` and `@hex-pro/docs/render` through a
 * `tsconfig` paths entry, and the submodule it reads is whatever commit that repository has
 * checked out. So a name leaving either barrel is a break in a repository nobody here is
 * compiling, and it surfaces as a red build inside a submodule during a deploy rather than
 * as a failure in this suite.
 *
 * It happened. `contentAttrs` and `ContentAttrs` were the whole of `src/site/direction.ts`'s
 * public surface, `src/index.ts` re-exports that module wholesale, and the step-9 rewrite
 * replaced them with `contentMark`, `interfaceMark` and `LangMark`. Nothing in this
 * repository noticed, and nothing in either consumer did either, because neither called
 * them. The next removal will not be so lucky, and "no consumer happened to call it" is not
 * a property this repository can check.
 *
 * ## Three lists, because a runtime key is not a type and a removal is not an addition
 *
 * `RUNTIME` is compared against `Object.keys` of the real modules in both directions, which
 * catches a value that left and a value that arrived. Both directions, because the accidental
 * arrival is real too: every one of these names reaches the barrel through an `export *` over
 * a whole module, so widening one module's surface widens the package's.
 *
 * A type has no runtime key at all, so the type half is a set of `import type` bindings used
 * in type positions. A name removed from a barrel is then a typecheck failure naming the
 * import, which is the only mechanism TypeScript offers for this and is why the two halves
 * are spelled differently. It is deliberately not the whole type surface: it is the types a
 * consuming site's own modules annotate with, which is the set a removal actually breaks.
 *
 * `WITHDRAWN` is the record a removal has to leave. Adding a name to `RUNTIME` is one line
 * and is meant to be. Taking one out is the edit this file exists to make somebody think
 * about: it is a breaking change for every repository mounting the submodule, and the usual
 * answer is to export both spellings for a release rather than to edit the list.
 */

import { describe, expect, test } from 'vitest';

import * as barrel from '../src/index.js';
import * as renderer from '../src/render/index.js';

import type {
	// src/site/address.ts
	DocsAddress,
	// src/site/direction.ts
	Direction,
	DocsCrumb,
	DocsNavNode,
	DocsPageData,
	DocsPager,
	DocsSeo,
	LangAttrs,
	LangMark,
	LangOnlyMark,
	Locale,
} from '../src/index.js';
import type { DocsChrome, DocsLinkComponent, DocsPageProps, EmitFn } from '../src/render/index.js';

/**
 * Every value either entry point exports, sorted.
 *
 * Deliberately the whole list rather than a handful of names somebody thought were the
 * important ones. A barrel is a surface, and the half nobody remembers to assert is the half
 * that gets deleted.
 */
const RUNTIME = {
	barrel: [
		'ARABIC_FOLDS',
		'ASSET_EXTENSIONS',
		'AST_NODE_TYPES',
		'AST_VERSION',
		'AUDIENCES',
		'AUDIENCE_MASK',
		'BANNED_CHARACTERS',
		'BANNED_CHARS',
		'BLOCK_TYPES',
		'BUNDLE_TREE',
		'CALLOUT_ALERT_PATTERN',
		'CALLOUT_COLOUR',
		'CALLOUT_KINDS',
		'CALLOUT_LABELS',
		'CHECK_IDS',
		'CHECK_STATES',
		'CHILD_TYPES',
		'CODE_DIRECTION',
		'CODE_SCOPES',
		'COLOUR_PROBES',
		'COMMIT_SHA_PATTERN',
		'CONTAINER_DIRECTIVE_NAMES',
		'CONTAINER_DIRECTIVE_PATTERN',
		'DEFAULT_AUDIENCE',
		'DEFAULT_B',
		'DEFAULT_BUDGETS',
		'DEFAULT_FIELD_WEIGHTS',
		'DEFAULT_K1',
		'DEFAULT_PAGE_KIND',
		'DENY_LIST_RELATIVE',
		'DIFF_GUTTER',
		'DIRECTIVE_CLOSE_PATTERN',
		'DISABLE_COMMENT_PATTERN',
		'DOCS_CONFIG_VERSION',
		'DOCS_EVENT_NAMES',
		'DOCS_HANDLE',
		'DOCS_MACHINE_MODULE',
		'DOCS_PAGE_MODULE',
		'EM_DASH_CHARS',
		'EM_DASH_CODE_POINTS',
		'EN_DASH_IN_PROSE',
		'EXPLICIT_HEADING_ID_PATTERN',
		'FENCE_OPTIONS',
		'FENCE_OPTION_PATTERN',
		'FINDING_CATEGORIES',
		'FORBIDDEN_FRONT_MATTER_KEYS',
		'FORBIDDEN_SOURCE_NAMES',
		'GZIP_SETTINGS',
		'HEADING_ID_MODES',
		'HEADING_ID_SOURCES',
		'HX',
		'IDS',
		'INDEXED_TRANSLATION_STATES',
		'INDEX_NORMALISATION',
		'INDEX_SEGMENT',
		'INLINE_TYPES',
		'LANGUAGE_NAMES',
		'LEAF_DIRECTIVE_PATTERN',
		'LINT_RULE_IDS',
		'LOCALES',
		'MANIFEST_KEY',
		'MANIFEST_VERSION',
		'MATCH_MODES',
		'MAX_NAV_DEPTH',
		'MAX_SEGMENT_LENGTH',
		'MAX_SLUG_DEPTH',
		'NAV_GROUP_ID_PATTERN',
		'NAV_VERSION',
		'NORMALISATION_FORMS',
		'PAGE_KINDS',
		'PAGE_ROOT_ANCHOR',
		'PALETTE',
		'PALETTE_NAMES',
		'PARITY_MODES',
		'PLAIN_CODE_LANGUAGE',
		'PLURAL_CATEGORIES',
		'PLURAL_KEYS',
		'PLURAL_STRINGS',
		'PROJECT_ID_PATTERN',
		'PROTECTED_RULES',
		'PUBLIC_TREE',
		'RAW_ASSET_LINK',
		'RAW_HTML_PATTERN',
		'RAW_PAGE_LINK',
		'RELEASE_DATE_PATTERN',
		'REPO_PATTERN',
		'RESERVED_MATH_PATTERN',
		'RESERVED_SLUG_ROOTS',
		'RTL_LOCALES',
		'RULE_CATEGORIES',
		'RULE_ID_PATTERN',
		'SCOPE_COLOUR',
		'SEARCH_FIELDS',
		'SEARCH_INDEX_KIND',
		'SEARCH_INDEX_VERSION',
		'SECTION_KINDS',
		'SECTION_NUMBER_PATTERN',
		'SEMVER_PATTERN',
		'SEVERITIES',
		'SHA256_PATTERN',
		'SITE_CONFIG_VERSION',
		'SITE_ROOT_RELATIVE',
		'SLUG_SEGMENT_PATTERN',
		'SNIPPET_ID_PATTERN',
		'SNIPPET_INCLUDE_NAME',
		'SOURCE_LOCALE',
		'STATUS_COLOUR',
		'STATUS_GLYPHS',
		'STATUS_LABELS',
		'STATUS_SHAPE',
		'STATUS_SHAPES',
		'STATUS_VALUES',
		'THEME_TOKENS',
		'TOKENISER_VERSION',
		'TOKENLESS_PLURAL_FORMS',
		'TOKEN_PREFIX',
		'TRANSLATION_STATES',
		'UI_KEYS',
		'UI_STRINGS',
		'UTC_TIMESTAMP_PATTERN',
		'VECTOR_QUANTISATIONS',
		'VERSION_LABEL_PATTERN',
		'assertIndexCompatible',
		'assertNever',
		'assetKey',
		'bannedCharacterName',
		'blockText',
		'bundlePrefix',
		'bundleUrl',
		'calloutKindOf',
		'calloutLabel',
		'checkRow',
		'compareFindings',
		'compareSlugStrings',
		'compareSlugs',
		'contentMark',
		'countWords',
		'decodeTerms',
		'directionOf',
		'docsHref',
		'docsHrefFor',
		'docsRawHref',
		'docsRouteRows',
		'docsSeoFromMatches',
		'docsServer',
		'failedRow',
		'foldArabic',
		'foldTerm',
		'formatSlug',
		'headingId',
		'houseStyleRules',
		'inlineText',
		'interfaceLang',
		'interfaceMark',
		'interpolate',
		'isContainerDirective',
		'isGzipped',
		'isLocale',
		'isNavDoc',
		'isNavGroup',
		'isNavLink',
		'isProtectedRule',
		'isSectionRoot',
		'isValidSlug',
		'langAttrs',
		'languageName',
		'llmsKey',
		'matchLocale',
		'navDepth',
		'navDocs',
		'navGroupId',
		'navGroupIds',
		'normaliseLocale',
		'normaliseText',
		'notRunRow',
		'pageKey',
		'paletteValue',
		'parseFenceInfo',
		'parseHighlightLines',
		'parseSlug',
		'pluralCategory',
		'pluralForm',
		'rawKey',
		'requireLocale',
		'requireSlug',
		'resetUnhandledNodeWarnings',
		'scopeClass',
		'searchIndex',
		'searchKey',
		'searchOptionId',
		'sectionNumberAnchor',
		'seoFor',
		'skippedRow',
		'slugParent',
		'slugToPath',
		'sortLocales',
		'statusAt',
		'statusGlyphText',
		'statusLabel',
		'statusOf',
		'tokenName',
		'tokenValue',
		'tokenise',
		'tokeniseQuery',
		'translationNotice',
		'uiPlural',
		'uiString',
		'unhandledNode',
		'validateManifestShape',
		'validateSearchIndexShape',
	],
	renderer: [
		'CodeBlock',
		'DocsPage',
		'DocsSearch',
		'NO_EMIT',
		'PlainLink',
		'renderBlocks',
		'renderInline',
		'statusText',
		'useAliasScroll',
		'useDocsEvents',
		'useHeadingSpy',
		'useHydrated',
		'useNavigationAnnounce',
		'useReducedMotion',
	],
};

/**
 * Names this package used to export and deliberately does not any more.
 *
 * The record the removal that prompted this file did not leave. A third consumer mounting an
 * older revision of the submodule reads it here rather than from a red build, and a name that
 * came back by accident under its old meaning fails the assertion below rather than quietly
 * reviving a spelling somebody decided against.
 */
const WITHDRAWN: { name: string; why: string }[] = [
	{
		name: 'contentAttrs',
		why: 'Replaced by `contentMark` and `interfaceMark`, which take two locales and answer nothing when the two agree, because an element repeating the language it already inherits makes a screen reader announce a change into the language it is reading.',
	},
	{
		name: 'ContentAttrs',
		why: '`contentAttrs` returned a pair that was always present; the pair a caller now spreads may be empty, so the type it returns is `LangMark` and the old name would describe a shape nothing produces.',
	},
];

/** The names above, as a set, so the comparison below is order-free and duplicate-free. */
const sorted = (names: readonly string[]): string[] => [...names].sort();

describe('the public surface', () => {
	test('both entry points export what they are declared to export, in both directions', () => {
		// Both directions. A one-sided check passes over a name that arrived by accident
		// through a `export *` somebody widened, which is how the stylesheet nearly reached
		// the node-importable half once already.
		const found = {
			barrel: sorted(Object.keys(barrel)),
			renderer: sorted(Object.keys(renderer)),
		};
		expect({
			barrelOnlyInModule: found.barrel.filter((name) => !RUNTIME.barrel.includes(name)),
			barrelOnlyInList: sorted(RUNTIME.barrel).filter((name) => !found.barrel.includes(name)),
			rendererOnlyInModule: found.renderer.filter((name) => !RUNTIME.renderer.includes(name)),
			rendererOnlyInList: sorted(RUNTIME.renderer).filter((name) => !found.renderer.includes(name)),
		}).toEqual({
			barrelOnlyInModule: [],
			barrelOnlyInList: [],
			rendererOnlyInModule: [],
			rendererOnlyInList: [],
		});
	});

	test('the lists are not empty, so the comparison above means something', () => {
		// Two empty lists satisfy every assertion above, which is what a module that failed to
		// load or a barrel that exports nothing at runtime would produce.
		expect(RUNTIME.barrel.length).toBeGreaterThan(5);
		expect(Object.keys(renderer).length).toBe(RUNTIME.renderer.length);
	});

	test('a withdrawn name stays withdrawn, and says why it went', () => {
		// The other direction of the same list. Neither half is worth much alone: without this,
		// a name could come back under a different meaning with the list unread, and without the
		// reasons the list is a set of strings nobody can act on.
		const live = new Set([...Object.keys(barrel), ...Object.keys(renderer)]);
		expect(WITHDRAWN.filter((entry) => live.has(entry.name)).map((entry) => entry.name)).toEqual(
			[],
		);
		expect(WITHDRAWN.length).toBeGreaterThan(0);
		for (const entry of WITHDRAWN) expect(entry.why.length).toBeGreaterThan(60);
	});

	test('every declared type is still a type this package exports', () => {
		// The runtime half cannot see a type at all. These bindings are the check: each is
		// used in a type position below, so a name removed from a barrel fails the typecheck
		// row naming the import rather than passing silently here.
		const marks: (LangMark | LangOnlyMark | LangAttrs)[] = [{}, { lang: 'en' }];
		const locale: Locale = 'en';
		const direction: Direction = 'ltr';
		const address: DocsAddress = { basePath: '/docs', locale };
		const crumb: DocsCrumb = { label: 'Guide', labelLocale: locale, href: '/docs/guide' };
		const pager: DocsPager = { title: 'Guide', labelLocale: locale, href: '/docs/guide' };
		const node: DocsNavNode = {
			kind: 'doc',
			slug: 'guide/index',
			label: 'Guide',
			labelLocale: locale,
			href: '/docs/guide',
			current: false,
		};
		const seo: DocsSeo = { indexable: true, languages: [locale] };
		const emit: EmitFn = () => undefined;
		const link: DocsLinkComponent = (props) => props.children;
		const chrome: DocsChrome = {};
		const props: Pick<DocsPageProps, 'themeClass'> = {};
		const data: Pick<DocsPageData, 'locale'> = { locale };
		expect([
			marks.length,
			direction,
			address.locale,
			crumb.labelLocale,
			pager.labelLocale,
			node.kind,
			seo.indexable,
			typeof emit,
			typeof link,
			Object.keys(chrome).length,
			Object.keys(props).length,
			data.locale,
		]).toEqual([2, 'ltr', 'en', 'en', 'en', 'doc', true, 'function', 'function', 0, 0, 'en']);
	});
});
