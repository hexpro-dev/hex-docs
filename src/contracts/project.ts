/**
 * `docs/site/docs.json`: the source project's own configuration.
 *
 * This is not the same file as `<project>.docs.json` in the consuming website, and
 * confusing the two is the mistake worth designing against, so the types are named
 * `DocsProjectConfig` and `DocsSiteConfig` and neither is a partial of the other.
 * This one lives in the app repository beside the content it governs. That one lives
 * in the web repository and says where the content is mounted and which commits are
 * labelled.
 *
 * Everything here is a compile input. Nothing in this file is uploaded: the bundle
 * layout publishes a manifest, pages, raw markdown, search indexes, assets and
 * `llms.txt`, and no config object at all. That matters because the deny list this
 * config points at names things that must not be published.
 */

import type { Audience } from './frontmatter.js';
import type { Locale } from './locales.js';
import type { LintRuleId, RuleSetting } from './lint.js';

/** The `docs.json` format version. Independent of the AST major and of `nav.json`. */
export const DOCS_CONFIG_VERSION = 1;

/**
 * The publishable root, relative to the app repository, with forward slashes.
 *
 * One constant with two readers, and the pairing is the whole reason it exists rather
 * than being a pair of string literals at each site. `loadProject` resolves the tree it
 * compiles against this, and `hexdocs init` writes exactly this string into
 * `scripts/sync-public.sh`'s `ALLOW_PATHS` in an app repository whose public mirror is
 * protected by absence and nothing else.
 *
 * So the dangerous edit is not expressible on its own. Widening the allowlist entry to a
 * bare `docs` means changing this line, and changing this line points the compiler at
 * `docs/` instead of `docs/site/`, which every project test in `kit/test/compile/` fails
 * on before anything reaches a mirror. A separate literal in the editor could have been
 * widened with the compiler none the wiser, and that edit pushes `docs/internal/`, which
 * in hex-nfc holds export-compliance material and a device UDID, to a public GitHub
 * repository where `prune_internal_files()` matches four basenames and reports nothing
 * to prune.
 *
 * Forward slashes, never `path.join`: it is a manifest path, a finding's `file`, and a
 * line in a bash array, none of which is a filesystem path on the machine reading it.
 */
export const SITE_ROOT_RELATIVE = 'docs/site';

/**
 * The deny list, relative to the app repository.
 *
 * Deliberately a sibling of `SITE_ROOT_RELATIVE` and not under it, and declared here
 * beside it so the two are read together. It names the things that must not ship, so
 * keeping it inside the tree the publisher reads would be the same mistake in miniature.
 */
export const DENY_LIST_RELATIVE = 'docs/docs.private.json';

/** Project ids are slug-shaped: they are an S3 key prefix and a URL segment. */
export const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `owner/name`, as GitHub spells it. */
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The language id for a fence that is deliberately not code.
 *
 * `code-fence-language` is an error, because an unlabelled fence renders unhighlighted
 * and nothing says whether that was intended. But the corpus has a box-drawing module
 * graph and a column-aligned directory tree, and neither is a language. Without a
 * named plain member the two requirements contradict each other, and the rule that
 * loses is the one that would have caught a real mistake.
 */
export const PLAIN_CODE_LANGUAGE = 'text';

export const SECTION_KINDS = ['manual', 'guide', 'reference'] as const;

export type SectionKind = (typeof SECTION_KINDS)[number];

export interface SectionConfig {
	/** Matches the first path segment of every slug in the section. */
	id: string;
	/**
	 * Drives one thing: the warning when a page's audience does not match its
	 * section's usual one. Labels are not here. They are on the `nav.json` group, and
	 * duplicating twenty-eight localised strings across two files with nothing linting
	 * that they agree is exactly the failure this package exists to prevent.
	 */
	kind: SectionKind;
}

export const PARITY_MODES = ['graceful', 'required'] as const;

/**
 * What a missing translation means.
 *
 * `graceful` publishes what exists and marks the rest; `required` makes a missing
 * translation a publish-blocking error. hex-nfc ships `graceful`, because its three
 * documents are English-only and a rule that assumes seven locales would block its
 * first bundle. It flips to `required` once a manual is fully translated and staying
 * that way is the property worth enforcing.
 */
export type ParityMode = (typeof PARITY_MODES)[number];

export interface I18nConfig {
	/**
	 * The locales this project publishes. Must contain the source locale, and is
	 * stored in canonical order: a publish re-run on the same commit has to write
	 * identical bytes, and `readdir` order is not stable across filesystems.
	 */
	locales: Locale[];
	/** Always `en`. Documentation is authored in English and translated outward. */
	sourceLocale: 'en';
	parity: ParityMode;
}

/**
 * How heading anchors are derived, project-wide.
 *
 * `slug` from the heading text is the default and what the engineering documents
 * already rely on. `section-number` derives the anchor from a leading number, which
 * is what the legal documents need: `#section-4` addresses the same clause in all
 * seven languages, and slugified headings would give each language its own anchors
 * and break every inbound link without anything reporting it.
 *
 * An explicit `{#id}` always wins over either.
 */
export const HEADING_ID_MODES = ['slug', 'section-number'] as const;

export type HeadingIdMode = (typeof HEADING_ID_MODES)[number];

/**
 * Hard limits. Each is a publish error naming the limit and the file, not a warning.
 *
 * The bundle is consumed at build time by the consuming site's SSR build, so an
 * unbounded page does not make a slow page, it makes a build that times out on a
 * self-hosted box at deploy time.
 */
export interface BudgetConfig {
	/** Default 70. Longer than this is truncated in a search result anyway. */
	titleMax: number;
	/**
	 * Default 160. A maximum and no minimum: a floor of fifty characters rejects
	 * correct Japanese, where character density is roughly double English.
	 */
	descriptionMax: number;
	/** Uncompressed page JSON. Default 512 KiB. */
	pageBytesMax: number;
	/** A single fence. Default 200 KiB. */
	codeFenceBytesMax: number;
	/** Rows in one table. Default 500. */
	tableRowsMax: number;
	/** Block nesting depth. Default 32. */
	nestingDepthMax: number;
	/** One asset. Default 2 MiB. */
	assetBytesMax: number;
	/** Every object in the bundle, uncompressed. Default 64 MiB. */
	bundleBytesMax: number;
}

export const DEFAULT_BUDGETS: BudgetConfig = {
	titleMax: 70,
	descriptionMax: 160,
	pageBytesMax: 512 * 1024,
	codeFenceBytesMax: 200 * 1024,
	tableRowsMax: 500,
	nestingDepthMax: 32,
	assetBytesMax: 2 * 1024 * 1024,
	bundleBytesMax: 64 * 1024 * 1024,
};

export interface CodeConfig {
	/**
	 * Fence languages this project allows. Must contain `text`.
	 *
	 * An allowlist rather than "whatever the highlighter knows", so a typo like
	 * ```swfit produces an error instead of an unhighlighted block nobody notices.
	 */
	languages: string[];
}

export interface TocConfig {
	enabled: boolean;
	/** Deepest heading level in the table of contents. */
	maxDepth: 2 | 3 | 4;
	/** Below this many headings, no table of contents. Default 3. */
	minHeadings: number;
}

export interface LintConfig {
	/** The only preset. Named so a second one is a schema change rather than a string. */
	extends: 'house';
	/**
	 * How many `hexdocs-disable-next-line` comments the project may carry before the
	 * build fails. Suppressions with reasons are legitimate; a growing pile of them is
	 * an opt-out nobody decided on, and counting is the only way that stays visible.
	 */
	maxDisables: number;
	/**
	 * Per-rule overrides.
	 *
	 * Additive only, and the schema enforces it rather than a comment: a project may
	 * raise a severity and may not lower a protected rule below `error`. The estate's
	 * house rules are stated as hard rules, and a config that could switch one off
	 * would switch it off on the first build it inconvenienced.
	 */
	rules?: Partial<Record<LintRuleId, RuleSetting>>;
	/** Added to the house table. A project cannot remove a house phrase. */
	bannedPhrases?: { phrase: string; replacement: string | null; why: string }[];
	/** Words the spelling rule should leave alone: `NDEF`, `APDU`, `NTAG424`. */
	technicalTerms?: string[];
}

export type GlossaryEntry =
	| {
			kind: 'do-not-translate';
			term: string;
			note?: string;
	  }
	| {
			kind: 'translate';
			term: string;
			/** Every locale, so a translator agent cannot pick one of two spellings. */
			translations: Record<Locale, string>;
			note?: string;
	  };

export interface DocsProjectConfig {
	/**
	 * Accepted and ignored. A relative path works in an editor with nothing hosted:
	 * `"../../hex-docs/kit/schema/docs-1.json"` from an app repository that mounts the
	 * submodule at its root. Declared explicitly because every schema here is strict,
	 * and a tool that rejects the files it generates itself is worse than one with no
	 * completion at all.
	 */
	$schema?: string;
	docs: typeof DOCS_CONFIG_VERSION;

	/**
	 * The S3 key prefix, and the join key to `<project>.docs.json` in the web
	 * repository. A mismatch publishes into a prefix nothing reads, and nothing fails.
	 */
	project: string;
	/** How the product is named in prose. The one project-level string the UI reads. */
	productName: string;
	/** `owner/name`. The "edit this page" target and the source of commit timestamps. */
	repo: string;

	/**
	 * The audience the server renders before the client knows better.
	 *
	 * The audience filter is a CSS class rather than a render-time branch, because SSR
	 * that depends on client state stops being cacheable and hydrates differently from
	 * what it sent.
	 */
	defaultAudience: Audience;

	headingIds: HeadingIdMode;
	sections: SectionConfig[];
	i18n: I18nConfig;
	budgets: BudgetConfig;
	code: CodeConfig;
	toc: TocConfig;
	lint: LintConfig;

	/**
	 * The closed tag vocabulary. Free tags rot, and they cannot be translated.
	 *
	 * Not rendered as a facet in this version: eight ids would owe fifty-six localised
	 * labels for a surface nothing has asked for yet. They feed search weighting and
	 * the grouping in `llms.txt`, which is enough to earn the field.
	 */
	taxonomy?: { tags: string[] };

	/**
	 * Terms a translator must not localise, and terms that must be localised exactly
	 * one way.
	 *
	 * Seven languages, a technical corpus and one page written across several sessions
	 * is how `tag`, `scan` and `record` end up rendered three ways in the same Japanese
	 * manual, and how a chip part number ends up translated.
	 */
	glossary?: GlossaryEntry[];
}

/**
 * `docs/docs.private.json`: strings that must never appear in anything published.
 *
 * Deliberately **outside** `docs/site/`. It names the things that must not ship, so
 * keeping it inside the tree the publisher reads would be the same mistake in
 * miniature.
 *
 * An absent file is a warning that names the path and says what it would have scanned
 * for. Never a silent pass: a deny scan that examined nothing has not cleared
 * anything, and this is the check whose failure mode is a competitor name or a device
 * identifier on a public page.
 */
export interface DenyList {
	$schema?: string;
	private: 1;
	/**
	 * Matched case-insensitively against two inputs, and the pair is the contract.
	 *
	 * Every source line of every page and snippet, front matter included, so a fence body,
	 * an inline code run, a link or image target and a link title are all covered: those
	 * are published in the page payload and in the raw markdown, and a sample command in a
	 * fence is the likeliest place a device identifier is typed. And the extracted prose,
	 * which adds the one thing a line-by-line scan cannot see, a name folded across a soft
	 * wrap. This sentence used to claim the first half and deliver neither, which is worse
	 * than a gap: it is how the rule between a UDID and a public mirror got trusted.
	 *
	 * Not the emitted bundle bytes. Those are the same characters after compilation, and
	 * scanning the source is what lets a finding carry the line an author can fix.
	 *
	 * This is also what `no-competitor-name` reads. The rule used to take its terms from
	 * a `forbiddenTerms` key in `docs/site/docs.json`, which put the competitor names
	 * inside the tree `hexdocs init` adds to `sync-public.sh`'s `ALLOW_PATHS`: the list
	 * of things that must not ship, shipped. One list, outside the publishable root,
	 * with the reason written where somebody moving it will read it.
	 */
	strings: string[];
	patterns: { id: string; pattern: string; flags: string; why: string }[];
}

/**
 * File and directory names refused anywhere under `docs/site/`.
 *
 * `sync-public.sh` copies `docs/site` into the public mirror and its
 * `prune_internal_files()` deletes exactly these four names afterwards. An agent
 * handed a documentation tree will reasonably drop authoring guidance beside the
 * content, and the tagged public release then dies in the prune step with an error
 * about a file nobody put there on purpose. Refusing at compile time puts the message
 * where somebody is looking.
 *
 * The agent guide belongs at `docs/CLAUDE.md`, one level up and outside the root.
 */
export const FORBIDDEN_SOURCE_NAMES = ['CLAUDE.md', 'AGENTS.md', '.claude', '.agents'] as const;
