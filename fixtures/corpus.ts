/**
 * What the fixture corpus contains, declared rather than discovered.
 *
 * The tree under `app/` is the input to the compiler and to `hexdocs lint`. This file
 * is the statement of what that tree is supposed to be, and the two suites check the
 * one against the other. A corpus that only existed on disk would drift the first time
 * somebody added a page: the tests would keep passing, because they would be reading
 * whatever was there.
 *
 * Every entry carries the reason it is in the corpus. A fixture page with no stated
 * purpose is the first one deleted when it gets in the way, and the rule it was the
 * only coverage for goes with it.
 */

import type { Locale } from '../src/contracts/locales.js';
import type { TranslationState } from '../src/contracts/frontmatter.js';

/** Matches `app/docs/site/docs.json` and `site/fixture-app.docs.json`. */
export const FIXTURE_PROJECT = 'fixture-app';

/** Where a page's file lives, relative to `app/docs/site/`. */
export function contentPath(locale: Locale, slug: string): string {
	return `content/${locale}/${slug}.md`;
}

/** Where a snippet's file lives, relative to `app/docs/site/`. */
export function snippetPath(locale: Locale, id: string): string {
	return `snippets/${locale}/${id}.md`;
}

/**
 * One page, and the translation state each locale must end up in.
 *
 * A locale absent from `locales` has no file, and `missing` is what the compiler must
 * report for it. That is the same convention `PageRecord.locales` uses in the
 * manifest, and using it here rather than spelling `missing` out keeps the fixture
 * from teaching a shape the wire format does not have.
 *
 * The states are not free choices. `source`, `current`, `stale` and `scaffolded` all
 * have to appear somewhere in the corpus, because each one produces a different notice
 * on a published page and a different column in the coverage table.
 */
export interface FixturePage {
	slug: string;
	locales: Partial<Record<Locale, TranslationState>>;
	why: string;
	/** Excluded from a bundle, still read by the linter. */
	draft?: true;
	/** Old slugs that must redirect here. */
	redirectFrom?: readonly string[];
	/** Snippet ids this page transcludes. */
	includes?: readonly string[];
	/** True when the page is in `nav.json`. A draft is deliberately not. */
	inNav: boolean;
}

const ALL_CURRENT: Partial<Record<Locale, TranslationState>> = {
	en: 'source',
	zh: 'current',
	ar: 'current',
	es: 'current',
	ja: 'current',
	fr: 'current',
	'pt-BR': 'current',
};

export const FIXTURE_PAGES: readonly FixturePage[] = [
	{
		slug: 'index',
		locales: ALL_CURRENT,
		inNav: true,
		includes: ['safety-note'],
		why: 'The docs home, and the only page whose six translations are current by their own dates while carrying a snippet whose translations are stale. That pair is the whole test for effective freshness: a current page full of stale snippets is not current.',
	},
	{
		slug: 'guide/index',
		locales: ALL_CURRENT,
		inNav: true,
		why: 'A section root. `guide/index.md` serves the trailing-slash address, which is an explicit case in ParsedSlug rather than an empty string.',
	},
	{
		slug: 'guide/first-tag',
		locales: {
			en: 'source',
			zh: 'stale',
			ar: 'stale',
			es: 'stale',
			ja: 'stale',
			fr: 'stale',
			'pt-BR': 'stale',
		},
		inNav: true,
		includes: ['safety-note'],
		redirectFrom: ['first-tag'],
		why: 'The deliberately stale page. Its English file is revised in a later commit than every translation, so staleness comes out of git rather than out of a field an agent can refresh.',
	},
	{
		slug: 'guide/troubleshooting',
		locales: { en: 'source', ar: 'current', ja: 'current' },
		inNav: true,
		why: 'The deliberately partial page. Four locales have no file at all, which is what `graceful` parity has to publish and what the fallback-implies-noindex rule has to see.',
	},
	{
		slug: 'reference/index',
		locales: ALL_CURRENT,
		inNav: true,
		why: 'The second section root, so the compiler is exercised on more than one.',
	},
	{
		slug: 'reference/chip-support',
		locales: { en: 'source', zh: 'current', ar: 'current', es: 'scaffolded', ja: 'current' },
		inNav: true,
		includes: ['legend'],
		why: 'The support matrix: status glyphs as data, an alignment row, and a table in CJK and in RTL. Its Spanish file is the scaffolded one, committed after the English source so that timestamps alone call it current. That is the exact hole `translated: false` exists to close.',
	},
	{
		slug: 'reference/api',
		locales: { en: 'source' },
		inNav: true,
		why: 'English only, and the only page carrying every code fence option. It also carries two planted style violations and the only suppression comment in the corpus, which is why nothing translates it.',
	},
	{
		slug: 'developer/architecture',
		locales: { en: 'source' },
		inNav: true,
		why: 'English only. An explicit heading anchor, a box-drawing fence, and four planted violations including the two brand rules, which is why nothing translates it.',
	},
	{
		slug: 'notes/scratch',
		locales: { en: 'source' },
		inNav: false,
		draft: true,
		why: 'A draft, and deliberately absent from nav.json. It proves the two rules do not contradict each other: a published page missing from the nav is an orphan error, and a draft missing from the nav is not, because a draft is not published.',
	},
];

/**
 * One snippet, and where it exists.
 *
 * A snippet's locale coverage must be at least the coverage of every page that
 * includes it, or the include cannot resolve. That is checked rather than trusted:
 * `snippet-resolves` is the rule, and a fixture that broke the invariant would make
 * the rule untestable rather than tested.
 */
export interface FixtureSnippet {
	id: string;
	locales: Partial<Record<Locale, TranslationState>>;
	why: string;
}

export const FIXTURE_SNIPPETS: readonly FixtureSnippet[] = [
	{
		id: 'safety-note',
		locales: {
			en: 'source',
			zh: 'stale',
			ar: 'stale',
			es: 'stale',
			ja: 'stale',
			fr: 'stale',
			'pt-BR': 'stale',
		},
		why: 'Included by two pages, and revised in English after every translation. It is the only stale thing inside an otherwise current page.',
	},
	{
		id: 'legend',
		locales: { en: 'source', zh: 'current', ar: 'current', es: 'current', ja: 'current' },
		why: 'The status glyph legend, in exactly the locales the chip matrix exists in. Its Spanish file is current even though the page including it is scaffolded, which is the state that makes the worst-of rule worth having.',
	},
];

/**
 * Assets the corpus publishes, and what each is for.
 *
 * The unpublishable ones are in `rejected/`, outside `app/`, because a tree the
 * compiler is asked to build must build. An asset that must be refused belongs beside
 * the declaration of why, not inside the corpus that has to succeed.
 */
export const FIXTURE_ASSETS: readonly { path: string; why: string }[] = [
	{
		path: 'assets/scan-screen.png',
		why: 'A raster screenshot with no colour tag, which is sRGB by convention. The figure and the bare standalone image both point at it.',
	},
	{
		path: 'assets/nfc-glyph.svg',
		why: 'A vector asset with no script, no foreignObject, no external reference and no event handler, so `asset-svg-unsafe` has a passing case as well as a failing one. It is the inline image, mid sentence.',
	},
];

export const REJECTED_ASSETS: readonly { path: string; rule: string; why: string }[] = [
	{
		path: 'display-p3.png',
		rule: 'asset-colour-space',
		why: 'A PNG carrying a cICP chunk that declares SMPTE 432 primaries. `ffprobe -show_entries stream=color_primaries` reads it as smpte432 while the published one reads unknown. ImageMagick reports sRGB for both and would pass it, which is why the probe is named in the asset record.',
	},
	{
		path: 'unsafe-diagram.svg',
		rule: 'asset-svg-unsafe',
		why: 'Carries all five of the things `asset-svg-unsafe` names: a script element, a foreignObject wrapping XHTML, an anchor with an href, an external image reference and an onload handler. Inside an img element none of it runs; navigated to directly on the consuming site, which is what the prefetch produces, all of it does.',
	},
];

/*
 * There is no oversized asset. `budgets.assetBytesMax` defaults to 2 MiB, and
 * committing two megabytes of noise to prove that a comparison works is a bad trade
 * against a test that lowers the budget over one of the assets above. Stated here
 * because the absence otherwise reads as an oversight.
 */

/**
 * The commit sequence the corpus is materialised with.
 *
 * Translation staleness is `git log -1 --format=%cI` on the English file against the
 * same on the translation, so a corpus committed all at once has no stale page in it
 * and no way to grow one. That is the shallow-clone failure mode in miniature: every
 * file carries the same date, nothing is ever newer than anything, and the whole
 * corpus reads `current`.
 *
 * `touches` is a predicate over the path relative to `app/`, so the history and the
 * page table cannot disagree about which files a commit covers.
 */
export interface FixtureCommit {
	/** ISO 8601, UTC, second precision. Fed to GIT_COMMITTER_DATE and GIT_AUTHOR_DATE. */
	at: string;
	message: string;
	touches: (path: string) => boolean;
	why: string;
}

const isTranslation = (path: string): boolean =>
	/^docs\/site\/(content|snippets)\//.test(path) &&
	!/^docs\/site\/(content|snippets)\/en\//.test(path);

export const FIXTURE_HISTORY: readonly FixtureCommit[] = [
	{
		at: '2026-01-05T09:00:00Z',
		message: 'Import the documentation tree',
		touches: (path) => !isTranslation(path),
		why: 'The English tree, the configs and the assets. Not the translations: a commit that introduces a file and a later commit that re-adds the same bytes are not two commits, because the second has no diff and `git log -1` never moves for that path. The materialiser refuses an empty commit for exactly that reason, which is how this was caught rather than assumed.',
	},
	{
		at: '2026-02-10T11:30:00Z',
		message: 'Translate the guide and the reference into six languages',
		touches: isTranslation,
		why: 'Every non-English file, first appearance, the scaffolded one included. Including it is the point: its committer date is later than the English source, so timestamps alone call it current, and only `translated: false` says otherwise.',
	},
	{
		at: '2026-03-15T08:15:00Z',
		message: 'Revise the first scan procedure',
		touches: (path) => path === 'docs/site/content/en/guide/first-tag.md',
		why: 'The English page moves ahead of its six translations, which is what makes them stale.',
	},
	{
		at: '2026-04-02T10:45:00Z',
		message: 'Rewrite the tag handling note',
		touches: (path) => path === 'docs/site/snippets/en/safety-note.md',
		why: 'A snippet moves ahead of its translations while the pages including it stay current, which is the only way to test that a page is no fresher than what it transcludes.',
	},
];

/**
 * Files the history revises rather than introduces, and therefore the files that need
 * an earlier version for the revising commit to be a real change.
 *
 * `git log -1` reports the last commit that changed a path, so re-committing identical
 * bytes produces no commit for that path at all and the date never moves. The
 * materialiser writes a placeholder for these in the first commit and the real content
 * in the commit that revises them, which is what makes the dates real rather than
 * asserted. It then checks the finished tree byte for byte against the corpus on disk,
 * so the placeholder cannot leak into what the compiler reads.
 */
export const REVISED_PATHS: readonly string[] = [
	'docs/site/content/en/guide/first-tag.md',
	'docs/site/snippets/en/safety-note.md',
];
