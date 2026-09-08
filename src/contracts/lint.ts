/**
 * Rule identities, and what a project may do to them.
 *
 * Two id spaces, one namespace. `LINT_RULE_IDS` are the rules a project can configure
 * in `docs.json`; `CHECK_IDS` are the structural, wiring and bundle checks that are
 * not configurable because there is no project for which they should be off. Both
 * appear in `Finding.rule`, so a report reads the same whichever produced it.
 *
 * A closed union rather than a free string. A `docs.json` naming a rule that does not
 * exist has to be a schema error: the alternative is a typo that leaves the rule at
 * its default severity and reads, in the diff, exactly like the override somebody
 * intended.
 */

import type { Locale } from './locales.js';
import type { FindingCategory, Severity } from './diagnostics.js';

/**
 * Rules a project can configure.
 *
 * Grouped by category, and the grouping is not decorative: `houseStyleRules()` below
 * is what the estate's own scripts import so `check-locales.mjs` and this package
 * cannot end up with two different ideas of what an em dash is.
 */
export const LINT_RULE_IDS = [
	// structure
	'no-h1-in-body',
	'heading-depth',
	'heading-order',
	'no-raw-html',
	'code-fence-language',
	'table-header-required',
	'page-size',
	// Source spelling this AST major cannot represent: the reserved `$$` math
	// delimiter, a directive name that is not in `CONTAINER_DIRECTIVE_NAMES`, a
	// container closed at the wrong colon width, an unreadable fence option. Added in
	// step 3 rather than step 1 because the parser is what discovers that a refusal
	// needs somewhere to be reported, and a refusal with no rule id ends up as a
	// thrown error with a file path and no line.
	'unsupported-syntax',

	// config
	'front-matter-invalid',
	'title-length',
	'description-length',
	'description-is-a-sentence',

	// links
	'link-resolves',
	'anchor-resolves',
	'snippet-resolves',

	// nav
	'orphan-page',
	'nav-duplicate',
	'nav-depth',
	'slug-reserved',

	// i18n
	'translation-missing',
	'translation-stale',
	'translation-is-source-text',
	'heading-set-matches-source',
	'glossary-term-translated',
	'bidi-balance',

	// house style
	'no-em-dash',
	'no-en-dash-prose',
	'no-decorative-unicode',
	'no-banned-phrase',
	'no-filler-verb-stack',
	'no-hedging-stack',
	'no-rhetorical-opener',
	'no-triad',
	'no-symmetric-pairs',
	'no-bolded-bullet-leadins',
	'australian-spelling',

	// brand
	'no-competitor-name',
	'internal-leak',

	// assets
	'alt-text-required',
	'asset-colour-space',
	'asset-size',
	'asset-svg-unsafe',
] as const;

export type LintRuleId = (typeof LINT_RULE_IDS)[number];

/**
 * Checks that are not rules. They have no severity to configure and no project may
 * turn them off, because each one reports a state in which the package cannot do its
 * job at all.
 */
export const CHECK_IDS = [
	// the consumer wiring, all of which `verify-install` asserts together
	'wiring-submodule',
	'wiring-workspace-exclusion',
	'wiring-tsconfig-path',
	'wiring-deploy-hash-dirs',
	'wiring-prebuild-hook',
	'wiring-routes',
	'wiring-localised-paths',
	'wiring-sitemap',
	'wiring-mcp',
	// the app repo's own wiring
	'wiring-allow-paths',
	'wiring-forbidden-agent-files',
	// The shape of the publishable tree: a symlink under it, a top-level directory that
	// is not part of a documentation tree, a file outside a locale directory, a
	// non-markdown file under content/. These were reported as `unsupported-syntax`,
	// whose declaration reads "source spelling this AST major cannot represent" and whose
	// protected status is justified by "a construct this AST major cannot carry is
	// dropped, not rendered". None of that is true of a PNG saved beside the page that
	// uses it, which is the most ordinary mistake there is: nothing is dropped from a
	// page, the file is simply not copied, and the operator was sent to look for a markdown
	// construct that does not exist.
	'source-layout',
	// bundles
	'bundle-ast-major',
	'bundle-missing-object',
	'bundle-digest-mismatch',
	'bundle-label-unknown-sha',
	'bundle-shallow-clone',
	// A file the git walk has no date for, while the tree it is in does have a history.
	// Added because the alternative was what the compiler used to do: write an empty
	// string into `sourceUpdated` and `updatedAt`, whose schemas require a timestamp, so
	// the page compiled to a payload the bundle's own schema rejects and the failure
	// arrived downstream as a digest mismatch naming nothing.
	'bundle-file-undated',
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export type RuleId = LintRuleId | CheckId;

/** Kebab case, no leading, trailing or doubled hyphen. */
export const RULE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Rules a project may raise but never lower, and never disable.
 *
 * The global house rules are stated as hard rules rather than preferences, so if a
 * project config could set `no-em-dash: off` the estate-wide guarantee would last
 * exactly until the first build it inconvenienced. `internal-leak` is here for a
 * different reason: it is the rule that stops export-compliance notes and a device
 * UDID reaching a public mirror, and it matches `sync-public.sh`'s own posture of
 * dying on any hit.
 *
 * `docsProjectConfigSchema` refuses a config that lowers one, so this is a parse error
 * rather than a convention in a comment. The generated JSON Schema cannot carry the
 * constraint, because it is a relationship between a key and a value that JSON Schema has
 * no way to state, so an editor will not flag it and the parse will.
 */
export const PROTECTED_RULES = [
	'no-em-dash',
	'no-en-dash-prose',
	// The three of these are one partition of one list. `BANNED_CHARACTERS` is thirteen
	// code points and `prose.ts` splits them across these three rules precisely so a
	// character added to the contract lands in a bucket with nobody editing anything.
	// Two of the three used to be protected and the third was not, with no reason stated,
	// which made ten of the thirteen a project preference: both arrows, the bullet and
	// every emoji. hex-web's `check-locales.mjs` fails hard on the same thirteen, so the
	// estate held a locale string to a standard it did not hold a documentation page to.
	'no-decorative-unicode',
	'no-banned-phrase',
	'no-competitor-name',
	'internal-leak',
	'no-raw-html',
	// A construct this AST major cannot carry is dropped, not rendered. A project that
	// switched this off would publish pages with a hole in them and nothing saying why.
	'unsupported-syntax',
	// An SVG asset is a same-origin document on the consuming site, not only an <img>
	// source. See ASSET_EXTENSIONS in manifest.ts for what that means.
	'asset-svg-unsafe',
] as const satisfies readonly LintRuleId[];

export type ProtectedRule = (typeof PROTECTED_RULES)[number];

/**
 * Characters this package may never emit, as code points with names.
 *
 * Scope matters. This governs strings **hex-docs itself produces**: finding messages,
 * remediation text, UI strings, skill bodies, scaffolded content. It is the same set
 * `check-locales.mjs` bans in hex-web, and one exported list is what keeps the two
 * from drifting into a subset relationship where one of them passes an en dash the
 * other rejects.
 *
 * It is not the rule applied to authored documentation. A tick in a support matrix is
 * data, not decoration: the compiler turns a recognised status glyph into a `status`
 * node before any prose rule runs, so `no-decorative-unicode` sees only the glyphs
 * that really are decoration.
 *
 * Code points rather than the characters themselves, for a practical reason: this
 * repository lints its own source with the pattern below, and a literal set would flag
 * the line that defines it. An exemption for "the file that declares the rule" is
 * exactly the kind of hole that later swallows a real hit. Deriving the pattern from
 * the list also means the names and the pattern cannot fall out of step.
 */
export const BANNED_CHARACTERS = [
	{ codePoint: 0x2013, name: 'en dash' },
	{ codePoint: 0x2014, name: 'em dash' },
	{ codePoint: 0x2015, name: 'horizontal bar' },
	{ codePoint: 0x2192, name: 'rightwards arrow' },
	{ codePoint: 0x21d2, name: 'rightwards double arrow' },
	{ codePoint: 0x2022, name: 'bullet' },
	{ codePoint: 0x2728, name: 'sparkles' },
	{ codePoint: 0x2705, name: 'white heavy check mark' },
	{ codePoint: 0x274c, name: 'cross mark' },
	{ codePoint: 0x1f680, name: 'rocket' },
	{ codePoint: 0x1f525, name: 'fire' },
	{ codePoint: 0x1f4a1, name: 'light bulb' },
	{ codePoint: 0x1f3af, name: 'direct hit' },
] as const;

function characterClass(codePoints: readonly number[]): string {
	return `[${codePoints.map((point) => `\\u{${point.toString(16)}}`).join('')}]`;
}

/** Derived, so the pattern and the names cannot disagree about what is banned. */
export const BANNED_CHARS = new RegExp(
	characterClass(BANNED_CHARACTERS.map((entry) => entry.codePoint)),
	'u',
);

/** The human name for a character the pattern matched. */
export function bannedCharacterName(character: string): string | undefined {
	const point = character.codePointAt(0);
	return BANNED_CHARACTERS.find((entry) => entry.codePoint === point)?.name;
}

/**
 * The em dash rule's code points: U+2014 EM DASH and U+2015 HORIZONTAL BAR.
 *
 * Deliberately not "any long horizontal bar". U+30FC, the katakana prolonged sound
 * mark, is a letter: widening the rule would flag every ordinary Japanese word in the
 * language least likely to be proofread here, and the pressure would be to disable the
 * rule for `ja` altogether.
 */
export const EM_DASH_CODE_POINTS = [0x2014, 0x2015] as const;

export const EM_DASH_CHARS = new RegExp(characterClass(EM_DASH_CODE_POINTS), 'u');

/**
 * U+2013 EN DASH as prose punctuation. Permitted between digits, because a numeric
 * range is the one place it is correct and rewriting a year range is not an
 * improvement.
 */
export const EN_DASH_IN_PROSE = /(?<![0-9])\u2013|\u2013(?![0-9])/u;

export interface RuleConfig {
	severity: Severity;
	/** Empty or absent means every locale. */
	locales?: Locale[];
}

export type RuleSetting = Severity | 'off' | RuleConfig;

/**
 * A banned phrase, in the serialisable form the kit exports.
 *
 * Exported as data rather than hidden behind the CLI, because the plan makes the rule
 * pack a kit export precisely so hex-web's own scripts can consume the same tested
 * tables instead of each re-deriving them from a CLAUDE.md. A pack reachable only
 * through a command is a pack that gets copied.
 */
export interface BannedPhrase {
	id: string;
	/** Source and flags separately, so the entry survives JSON. */
	pattern: string;
	flags: string;
	/** Why it is banned. Becomes the finding's `consequence`. */
	why: string;
	/** Concrete replacements, best first. Empty when the fix needs judgement. */
	suggest: string[];
}

/**
 * A rule, as the registry holds it.
 *
 * `test` is pure: no file reads, no config lookups, no clock. Config is applied to
 * the findings a rule returns, not inside it, which is what lets every rule be
 * golden-tested against a fixture page and lets the pack be exported for another
 * repository's scripts to run.
 */
export interface RuleDefinition {
	id: LintRuleId;
	category: FindingCategory;
	/** Severity when no project overrides it. */
	defaultSeverity: Severity;
	/** One line, imperative: "Do not use em dashes in prose." */
	title: string;
	/** What breaks if it is ignored. Copied onto every finding the rule produces. */
	consequence: string;
	/** At least one pair. The bad example must actually trip the rule; a test asserts it. */
	examples: { bad: string; good: string }[];
}

/**
 * A suppression comment.
 *
 * The reason is mandatory. A reasonless suppression is indistinguishable from an
 * agent silencing a rule it did not understand, and they accumulate into an opt-out
 * nobody decided on. `maxDisables` in the project config caps how many a project may
 * carry, so the count is visible rather than discovered.
 *
 * Suppressions are stripped before the AST is built, and a test asserts none ever
 * reaches a bundle: an authoring comment on a published page is a leak of the
 * process onto the product.
 */
export const DISABLE_COMMENT_PATTERN =
	/^\s*hexdocs-disable-next-line\s+([a-z0-9-]+)\s*:\s*(\S.*?)\s*$/;

/**
 * Which category each rule belongs to.
 *
 * The single source for the grouping. The comment headings in `LINT_RULE_IDS` above are
 * for a reader; this is what code reads, and `satisfies Record<LintRuleId, …>` means a
 * rule added to the list without a category fails the typecheck by name.
 *
 * `houseStyleRules()` used to be a second hand-written list that happened to match those
 * headings, with nothing checking that it still did.
 */
export const RULE_CATEGORIES = {
	'no-h1-in-body': 'structure',
	'heading-depth': 'structure',
	'heading-order': 'structure',
	'no-raw-html': 'structure',
	'code-fence-language': 'structure',
	'table-header-required': 'structure',
	'page-size': 'structure',
	'unsupported-syntax': 'structure',

	'front-matter-invalid': 'config',
	'title-length': 'config',
	'description-length': 'config',
	'description-is-a-sentence': 'config',

	'link-resolves': 'links',
	'anchor-resolves': 'links',
	'snippet-resolves': 'links',

	'orphan-page': 'nav',
	'nav-duplicate': 'nav',
	'nav-depth': 'nav',
	'slug-reserved': 'nav',

	'translation-missing': 'i18n',
	'translation-stale': 'i18n',
	'translation-is-source-text': 'i18n',
	'heading-set-matches-source': 'i18n',
	'glossary-term-translated': 'i18n',
	'bidi-balance': 'i18n',

	'no-em-dash': 'house-style',
	'no-en-dash-prose': 'house-style',
	'no-decorative-unicode': 'house-style',
	'no-banned-phrase': 'house-style',
	'no-filler-verb-stack': 'house-style',
	'no-hedging-stack': 'house-style',
	'no-rhetorical-opener': 'house-style',
	'no-triad': 'house-style',
	'no-symmetric-pairs': 'house-style',
	'no-bolded-bullet-leadins': 'house-style',
	'australian-spelling': 'house-style',

	'no-competitor-name': 'brand',
	'internal-leak': 'brand',

	'alt-text-required': 'assets',
	'asset-colour-space': 'assets',
	'asset-size': 'assets',
	'asset-svg-unsafe': 'assets',
} as const satisfies Record<LintRuleId, FindingCategory>;

/** House-style rules, for the estate scripts that import the pack directly. */
export function houseStyleRules(): readonly LintRuleId[] {
	return LINT_RULE_IDS.filter((id) => RULE_CATEGORIES[id] === 'house-style');
}

const PROTECTED_SET: ReadonlySet<string> = new Set<string>(PROTECTED_RULES);

export function isProtectedRule(id: string): id is ProtectedRule {
	return PROTECTED_SET.has(id);
}
