/**
 * The drift check.
 *
 * Every contract in this package is written twice: as a TypeScript type in
 * `src/contracts/`, which the runtime half reads with no dependencies, and as a Zod
 * schema here, which validates the same shape at publish time. This file asserts they
 * are the same, invariantly, in both directions.
 *
 * Invariance is the point. A one-way `extends` check passes while a field quietly
 * disappears from the schema that validates the bundle, because a narrower object is
 * assignable to a wider one. `AssertExact` uses the deferred-generic trick, which also
 * catches a required field becoming optional, which is the drift that actually
 * happens: a `.optional()` added during debugging and never removed.
 *
 * There is no runtime code here at all. It runs as part of `tsc --noEmit`, which the
 * `typecheck` script runs across all three configurations, so a schema that stopped
 * matching its type fails the same command that catches a syntax error.
 *
 * ## What this does and does not prove
 *
 * It proves that each schema's *inferred output type* equals its hand-written twin,
 * field for field, including optionality.
 *
 * It does not prove that a schema validates as strictly as its type suggests. Nothing
 * here would notice `z.string()` where the type says `string` but a regex was intended,
 * because both infer `string`.
 *
 * That gap is real and it is only partly covered, by two things that do not overlap
 * neatly. `constraint-sweep.test.ts` asserts the constraints whose loss would ship
 * something wrong: the bundle, AST and diagnostics identifier patterns, the path and
 * href grammars, the anchor and slug grammars, and the numeric bounds a renderer
 * divides by. The committed JSON Schema snapshots hold the config-side patterns, but
 * only for the six schemas `emit-json-schemas.ts` lists. Some patterns are in both and
 * at least one, the nav group id, is in neither: it is held by the round-trip cases in
 * `config.schema.test.ts` alone.
 *
 * Neither net covers every `.min(1)` in the package. Dropping one of the uncovered ones
 * leaves the whole gate green, so a schema constraint added here without a case in that
 * sweep is a constraint nothing is holding.
 *
 * ## The recursion seam, and what does and does not close it
 *
 * At the recursion points, `AssertExact` is satisfied by construction: a container's
 * children are typed by the `z.ZodType<Inline[]>` annotation on `inlineArray()` rather
 * than inferred from what it returns. So nothing here can tell `z.array(inlineSchema)`
 * from `z.any()`, and `z.array(z.custom<Inline>())` is exactly the edit somebody makes
 * to break a circular-reference error at three in the afternoon.
 *
 * The registry assertions in `ast.schema.ts` do **not** close that. They close
 * completeness: which node types are in the union. They never reference `inlineArray`
 * or `blockArray`, so they say nothing about what a paragraph's children are validated
 * against.
 *
 * What closes it is `kit/test/contracts/ast.schema.test.ts`, in two ways that fail
 * independently: a seam-identity assertion that every container's array element is
 * the shared union schema by reference, and negative tests that a container rejects a
 * child the AST has no node type for. Do not delete either believing the type system
 * has this.
 */

import type { z } from 'zod';

import type { AssertExact, AssertExactUnion, Expect } from '../../../src/contracts/exact.js';
import type {
	Block,
	BreakNode,
	Code,
	CodeLine,
	CodeToken,
	Emphasis,
	Figure,
	Heading,
	ImageNode,
	Inline,
	InlineCode,
	ListItem,
	ListNode,
	Paragraph,
	StatusNode,
	Step,
	Steps,
	Strikethrough,
	Strong,
	Table,
	TableCell,
	TextNode,
	ThematicBreak,
	Blockquote,
	Callout,
} from '../../../src/contracts/ast.js';
import type {
	CheckRow,
	DiagnosticEnvelope,
	DiagnosticSummary,
	Finding,
	FindingLocation,
	NextAction,
	VerifyInstallReport,
} from '../../../src/contracts/diagnostics.js';
import type {
	DocFrontMatter,
	LocalisedLabel,
	SnippetFrontMatter,
	TranslationRecord,
} from '../../../src/contracts/frontmatter.js';
import type { RuleConfig, RuleSetting } from '../../../src/contracts/lint.js';
import type {
	AssetRecord,
	BundleCounts,
	BundleManifest,
	HeadingRecord,
	LocaleCoverage,
	ManifestNavNode,
	ObjectRecord,
	PageLocaleRecord,
	PageRecord,
	SearchIndexRecord,
} from '../../../src/contracts/manifest.js';
import type { NavDocItem, NavGroupItem, NavLinkItem, NavTree } from '../../../src/contracts/nav.js';
import type { CompiledPage, PageHeading, ReadingEstimate } from '../../../src/contracts/page.js';
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
import type { SearchDoc, SearchIndex, SearchPostings } from '../../../src/contracts/search.js';
import type { DocsSiteConfig, VersionEntry } from '../../../src/contracts/site.js';

import * as ast from './ast.schema.js';
import * as bundle from './bundle.schema.js';
import * as config from './config.schema.js';
import * as diagnostics from './diagnostics.schema.js';

type Of<S> = S extends z.ZodType ? z.infer<S> : never;

// ---------------------------------------------------------------------------
// AST: inline
// ---------------------------------------------------------------------------

type _text = Expect<AssertExact<Of<typeof ast.textSchema>, TextNode>>;
type _emphasis = Expect<AssertExact<Of<typeof ast.emphasisSchema>, Emphasis>>;
type _strong = Expect<AssertExact<Of<typeof ast.strongSchema>, Strong>>;
type _strikethrough = Expect<AssertExact<Of<typeof ast.strikethroughSchema>, Strikethrough>>;
type _inlineCode = Expect<AssertExact<Of<typeof ast.inlineCodeSchema>, InlineCode>>;
type _image = Expect<AssertExact<Of<typeof ast.imageSchema>, ImageNode>>;
type _break = Expect<AssertExact<Of<typeof ast.breakSchema>, BreakNode>>;
type _status = Expect<AssertExact<Of<typeof ast.statusSchema>, StatusNode>>;

/* Every union contract below uses `AssertExactUnion`, which compares whole members.
 * `AssertExact` compares keys, and `keyof` a union is the *intersection* of its
 * members' keys, so two unions differing in a member can produce three empty key
 * unions and an assertion that proves nothing. `AssertExact` now falls back to a
 * literal rather than to `never` in that case, and the union form fails on any
 * member-level difference.
 *
 * What the union form names is narrower than it looks, and it is worth knowing before
 * reading one of its errors. A member added or removed outright is printed whole. A
 * member that only gains or loses an *optional* field is still assignable in both
 * directions, so `Exclude` drops it and the error reads
 * `{ onlyInFirst: never; onlyInSecond: never }`, naming nothing. Measured against
 * this compiler by adding `order?: number` to `navGroupSchema`. The per-member object
 * assertions elsewhere in this file are what name `order`, which is why both forms are
 * here rather than one. */
type _inlineUnion = Expect<AssertExactUnion<Of<typeof ast.inlineSchema>, Inline>>;

// ---------------------------------------------------------------------------
// AST: code
// ---------------------------------------------------------------------------

type _codeToken = Expect<AssertExact<Of<typeof ast.codeTokenSchema>, CodeToken>>;
type _codeLine = Expect<AssertExact<Of<typeof ast.codeLineSchema>, CodeLine>>;

// ---------------------------------------------------------------------------
// AST: block
// ---------------------------------------------------------------------------

type _paragraph = Expect<AssertExact<Of<typeof ast.paragraphSchema>, Paragraph>>;
type _heading = Expect<AssertExact<Of<typeof ast.headingSchema>, Heading>>;
type _listItem = Expect<AssertExact<Of<typeof ast.listItemSchema>, ListItem>>;
type _list = Expect<AssertExact<Of<typeof ast.listSchema>, ListNode>>;
type _code = Expect<AssertExact<Of<typeof ast.codeSchema>, Code>>;
type _blockquote = Expect<AssertExact<Of<typeof ast.blockquoteSchema>, Blockquote>>;
type _callout = Expect<AssertExact<Of<typeof ast.calloutSchema>, Callout>>;
type _tableCell = Expect<AssertExact<Of<typeof ast.tableCellSchema>, TableCell>>;
type _table = Expect<AssertExact<Of<typeof ast.tableSchema>, Table>>;
type _figure = Expect<AssertExact<Of<typeof ast.figureSchema>, Figure>>;
type _thematicBreak = Expect<AssertExact<Of<typeof ast.thematicBreakSchema>, ThematicBreak>>;
type _step = Expect<AssertExact<Of<typeof ast.stepSchema>, Step>>;
type _steps = Expect<AssertExact<Of<typeof ast.stepsSchema>, Steps>>;
type _blockUnion = Expect<AssertExactUnion<Of<typeof ast.blockSchema>, Block>>;

// ---------------------------------------------------------------------------
// Authored files
// ---------------------------------------------------------------------------

type _frontMatter = Expect<AssertExact<Of<typeof config.frontMatterSchema>, DocFrontMatter>>;
type _snippetFrontMatter = Expect<
	AssertExact<Of<typeof config.snippetFrontMatterSchema>, SnippetFrontMatter>
>;
type _translationRecord = Expect<
	AssertExact<Of<typeof config.translationRecordSchema>, TranslationRecord>
>;
type _localisedLabel = Expect<AssertExact<Of<typeof config.localisedLabelSchema>, LocalisedLabel>>;
type _navTree = Expect<AssertExact<Of<typeof config.navTreeSchema>, NavTree>>;
type _navDoc = Expect<AssertExact<Of<typeof config.navDocSchema>, NavDocItem>>;
type _navGroup = Expect<AssertExact<Of<typeof config.navGroupSchema>, NavGroupItem>>;
type _navLink = Expect<AssertExact<Of<typeof config.navLinkSchema>, NavLinkItem>>;

type _sectionConfig = Expect<AssertExact<Of<typeof config.sectionConfigSchema>, SectionConfig>>;
type _i18nConfig = Expect<AssertExact<Of<typeof config.i18nConfigSchema>, I18nConfig>>;
type _budgetConfig = Expect<AssertExact<Of<typeof config.budgetConfigSchema>, BudgetConfig>>;
type _codeConfig = Expect<AssertExact<Of<typeof config.codeConfigSchema>, CodeConfig>>;
type _tocConfig = Expect<AssertExact<Of<typeof config.tocConfigSchema>, TocConfig>>;
type _ruleConfig = Expect<AssertExact<Of<typeof config.ruleConfigSchema>, RuleConfig>>;
type _ruleSetting = Expect<AssertExactUnion<Of<typeof config.ruleSettingSchema>, RuleSetting>>;
type _lintConfig = Expect<AssertExact<Of<typeof config.lintConfigSchema>, LintConfig>>;
type _glossaryEntry = Expect<
	AssertExactUnion<Of<typeof config.glossaryEntrySchema>, GlossaryEntry>
>;
type _projectConfig = Expect<
	AssertExact<Of<typeof config.docsProjectConfigSchema>, DocsProjectConfig>
>;
type _denyList = Expect<AssertExact<Of<typeof config.denyListSchema>, DenyList>>;

type _versionEntry = Expect<AssertExact<Of<typeof config.versionEntrySchema>, VersionEntry>>;
type _siteConfig = Expect<AssertExact<Of<typeof config.docsSiteConfigSchema>, DocsSiteConfig>>;

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

type _pageHeading = Expect<AssertExact<Of<typeof bundle.pageHeadingSchema>, PageHeading>>;
type _reading = Expect<AssertExact<Of<typeof bundle.readingEstimateSchema>, ReadingEstimate>>;
type _compiledPage = Expect<AssertExact<Of<typeof bundle.compiledPageSchema>, CompiledPage>>;

type _assetRecord = Expect<AssertExact<Of<typeof bundle.assetRecordSchema>, AssetRecord>>;
type _headingRecord = Expect<AssertExact<Of<typeof bundle.headingRecordSchema>, HeadingRecord>>;
type _pageLocaleRecord = Expect<
	AssertExact<Of<typeof bundle.pageLocaleRecordSchema>, PageLocaleRecord>
>;
type _pageRecord = Expect<AssertExact<Of<typeof bundle.pageRecordSchema>, PageRecord>>;
type _navNode = Expect<AssertExact<Of<typeof bundle.manifestNavNodeSchema>, ManifestNavNode>>;
type _searchIndexRecord = Expect<
	AssertExact<Of<typeof bundle.searchIndexRecordSchema>, SearchIndexRecord>
>;
type _objectRecord = Expect<AssertExact<Of<typeof bundle.objectRecordSchema>, ObjectRecord>>;
type _bundleCounts = Expect<AssertExact<Of<typeof bundle.bundleCountsSchema>, BundleCounts>>;
type _localeCoverage = Expect<AssertExact<Of<typeof bundle.localeCoverageSchema>, LocaleCoverage>>;
type _manifest = Expect<AssertExact<Of<typeof bundle.bundleManifestSchema>, BundleManifest>>;

type _searchDoc = Expect<AssertExact<Of<typeof bundle.searchDocSchema>, SearchDoc>>;
type _searchPostings = Expect<AssertExact<Of<typeof bundle.searchPostingsSchema>, SearchPostings>>;
type _searchIndex = Expect<AssertExact<Of<typeof bundle.searchIndexSchema>, SearchIndex>>;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

type _findingLocation = Expect<
	AssertExactUnion<Of<typeof diagnostics.findingLocationSchema>, FindingLocation>
>;
type _finding = Expect<AssertExact<Of<typeof diagnostics.findingSchema>, Finding>>;
type _nextAction = Expect<AssertExactUnion<Of<typeof diagnostics.nextActionSchema>, NextAction>>;
type _summary = Expect<
	AssertExact<Of<typeof diagnostics.diagnosticSummarySchema>, DiagnosticSummary>
>;
type _envelope = Expect<
	AssertExact<Of<typeof diagnostics.diagnosticEnvelopeSchema>, DiagnosticEnvelope>
>;
type _checkRow = Expect<AssertExact<Of<typeof diagnostics.checkRowSchema>, CheckRow>>;
type _verifyReport = Expect<
	AssertExact<Of<typeof diagnostics.verifyInstallReportSchema>, VerifyInstallReport>
>;
