/**
 * Page front matter: everything about a page that is not the page.
 *
 * The governing rule is that nothing here may restate something the file system, the
 * nav or git already knows. A page cannot declare its own slug, its own position or
 * its own last-modified date, because each of those already has an owner and two
 * owners for one fact is how a page ends up routable and unpublished.
 */

import type { Locale } from './locales.js';

/**
 * Who a page is written for.
 *
 * The third member is `developer`. It is spelled that way in the plan and in the
 * source config, and one design document spelled it `technical` in the manifest it
 * emitted. Two spellings of one enum across the compiler/manifest boundary is a
 * filter that quietly matches nothing, so the constant is declared once, here, and
 * both sides import it.
 */
export const AUDIENCES = ['user', 'developer', 'both'] as const;

export type Audience = (typeof AUDIENCES)[number];

export const DEFAULT_AUDIENCE: Audience = 'both';

/**
 * What kind of document this is, for structured data.
 *
 * The plan commits to emitting `HowTo` where a page is a procedure and `FAQPage`
 * where it is one. Nothing else can tell them apart: a `manual/` section holds both
 * procedures and prose, so deriving the kind from the section would emit structured
 * data claiming steps a page does not have, which is the kind of thing that gets a
 * site's rich results turned off rather than corrected.
 */
export const PAGE_KINDS = ['article', 'howto', 'faq'] as const;

export type PageKind = (typeof PAGE_KINDS)[number];

export const DEFAULT_PAGE_KIND: PageKind = 'article';

/**
 * A page's state in one locale.
 *
 * `source` is the English original. `current` and `stale` are decided by comparing
 * git committer dates, English against the translation. `missing` is a locale with
 * no file.
 *
 * `scaffolded` exists because timestamps have the same hole the abandoned
 * `sourceDigest` had: `scaffold_page` writes six locale files with English bodies,
 * every one of them committed after the English source, so every one reads `current`
 * forever and the translation notice never appears on a page that has never been
 * translated. Two independent things set it, so forgetting either still catches it:
 * the scaffolder writes `translated: false` into the file, and a lint rule fires when
 * a non-source page's text is almost identical to the source locale's.
 */
export const TRANSLATION_STATES = ['source', 'current', 'stale', 'scaffolded', 'missing'] as const;

export type TranslationState = (typeof TRANSLATION_STATES)[number];

/** Semantic version, exactly three numeric parts. No `v` prefix, no pre-release. */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface DocFrontMatter {
	/**
	 * The page title, and the only place it is written. Every file in the corpus
	 * currently carries its title as an `# h1` on line one; the migration lifts it here
	 * and deletes the heading, because a body `h1` would give the page two competing
	 * titles in the TOC, the search index and the tab.
	 *
	 * Bounded above by `budgets.titleMax` and below only by being non-empty. The schema
	 * once required three characters, and the Chinese fixture page titled 指南 is what
	 * disproved it: a floor measured in characters is a floor on Latin. This is the same
	 * reasoning `description` carries, discovered a second time on a different field.
	 */
	title: string;

	/**
	 * One sentence, for the meta description, the search snippet and `llms.txt`.
	 *
	 * There is a maximum and no minimum. A single global floor of fifty characters
	 * rejects correct Japanese, where character density is roughly double English: the
	 * worked Japanese page in the design pass is 44 characters and fails the same
	 * document's own lint config.
	 */
	description: string;

	/** Defaults to `both`. */
	audience?: Audience;

	/** Defaults to `article`. */
	pageKind?: PageKind;

	/**
	 * A shorter label for the sidebar, where the full title does not fit.
	 *
	 * It lives here rather than in `nav.json` because it is prose and has to be
	 * translated, and `nav.json` is language-neutral by design.
	 */
	navTitle?: string;

	/**
	 * Ids from the project's `taxonomy.tags` vocabulary. A closed list, because free
	 * tags rot and cannot be translated.
	 *
	 * Not rendered as a facet in this version. They feed search weighting and the
	 * grouping in `llms.txt`, which is enough to earn the field without also owing
	 * seven locales of label for every tag.
	 */
	tags?: string[];

	/** The product version this page first described. Drives the "new in" badge. */
	since?: string;

	/**
	 * Slugs this page used to live at. `hexdocs mv` writes them, and the compiler turns
	 * them into redirects.
	 *
	 * Three hex-nfc documents already have public addresses through the read-only
	 * mirror, and step 9 moves them. Without this they 404 the day the migration lands.
	 */
	redirectFrom?: string[];

	/**
	 * Excluded from the bundle unless the build asks for drafts.
	 *
	 * Read from the source locale's file only. Draft is a property of the page, not of
	 * a translation: a missing translation has no front matter to agree with, and
	 * asking six files to agree about a flag only one of them can meaningfully set is a
	 * rule with no correct answer.
	 */
	draft?: boolean;

	/**
	 * Suppress the table of contents on this page. Suppression only: the positive case
	 * comes from the project config, so a page cannot silently agree with a default
	 * that later changes.
	 */
	toc?: false;

	/**
	 * Written by `scaffold_page` into a locale file whose body is still English, and
	 * removed by whoever actually translates it.
	 *
	 * Only valid on a non-source locale. `hexdocs i18n mark` is the supported way to
	 * remove it and it refuses while the body is still byte-identical to English, so
	 * clearing the flag takes an edit rather than a command.
	 */
	translated?: false;
}

/**
 * Keys a page may not declare, each with the reason.
 *
 * Every one of these names a second source of truth for something already derived. A
 * typo like `discription:` is caught by the schema being strict; these are caught by
 * name so the error can say where the real owner is instead of "unknown key".
 */
export const FORBIDDEN_FRONT_MATTER_KEYS: Readonly<Record<string, string>> = {
	slug: 'The slug is the filename. A page that could disagree with its own address would be linked at one and reachable at the other.',
	category: 'Structure is nav.json.',
	section: 'The section is the first path segment.',
	order:
		'Ordering is nav.json, which is language-neutral. An order field would be seven numbers that have to agree.',
	weight: 'Ordering is nav.json.',
	sidebar_position: 'Ordering is nav.json.',
	sidebar: 'Structure is nav.json.',
	lang: 'The locale is the content/<locale>/ directory.',
	locale: 'The locale is the content/<locale>/ directory.',
	date: 'Dates come from git. An authored one goes stale the first time somebody edits the page without touching it.',
	updated:
		'Dates come from git, which is the only record that stays true when somebody edits the page.',
	lastmod: 'Dates come from git. See `updated`.',
	author: 'Authorship comes from git.',
	layout: 'There is one layout. Per-page layout selection is not a thing this package has.',
	template: 'There is one layout, and per-page selection is not a thing this package has.',
	hide_toc: 'Spelled `toc: false`.',
	sourceDigest:
		'Removed on purpose. It was a hash an agent could refresh with one command, so six digests would match and not one word would have been translated. Staleness comes from git committer dates now.',
	noindex:
		'Derived, not authored: a page is noindex when its translation is missing or its version is not the default. A page nobody should find should not be published.',
	summary: 'Removed. `llms.txt` and the MCP listing use the first paragraph.',
	related: 'Removed. Nothing rendered it.',
	until: 'Removed. Only `since` survived.',
};

/**
 * Front matter for a snippet.
 *
 * A separate schema, not a partial of the page one. A snippet has no slug, no
 * address, no nav position, no audience and no translation state of its own, so
 * reusing the page schema would either reject every snippet or loosen the page
 * schema to the point where a real page could omit its description.
 */
export interface SnippetFrontMatter {
	/** For the diagnostic when a snippet fails to resolve, and for nothing else. */
	title: string;
}

/**
 * The freshness of one page in one locale, as recorded in the manifest.
 *
 * `sourceUpdated` is always present; `translationUpdated` is absent for the source
 * locale and for a missing translation.
 *
 * Both come from `git log -1 --format=%cI`, normalised to `Z`. `%cI` emits a local
 * offset, so two runners in two timezones would write different bytes for the same
 * commit; `UTC_TIMESTAMP_PATTERN` in `manifest.ts` is what refuses one that was not
 * normalised.
 *
 * There is a second failure mode worth naming:
 * `actions/checkout` defaults to `fetch-depth: 1`, and in a shallow clone every file
 * carries the same commit date, so English is never newer than anything and the whole
 * corpus reads `current`. The compiler refuses to run in a shallow clone rather than
 * recording that, because the wrong answer here is the one that looks fine.
 */
export interface TranslationRecord {
	/**
	 * The **effective** state: the worst of this page and everything it transcludes.
	 *
	 * This is what the reader's notice shows, and it is deliberately not the same number
	 * the manifest counts. `PageLocaleRecord.state` is the page's own state, because that
	 * is what a translator needs: a page whose snippet is stale needs the snippet
	 * retranslated, not the page. A current page full of stale snippets is not current to
	 * a reader, and it is not a page to retranslate.
	 *
	 * The consequence is worth stating rather than discovering: a page can be `stale` here
	 * with a `translationUpdated` later than its `sourceUpdated`, because the two
	 * timestamps are the page's own and the state is not. The fixture corpus carries
	 * exactly that pair, and `kit/test/compile/corpus.test.ts` pins it.
	 */
	state: TranslationState;
	/** ISO 8601, UTC, second precision, from the source locale's file. */
	sourceUpdated: string;
	/** ISO 8601, UTC, second precision. Absent for `source` and `missing`. */
	translationUpdated?: string;
}

/** Locale-keyed, with every locale present. Used for nav labels and project chrome. */
export type LocalisedLabel = Record<Locale, string>;
