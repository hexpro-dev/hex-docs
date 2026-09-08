/**
 * Everything a docs route decides before anything renders.
 *
 * The consuming site's loader calls this and hands the result straight to `DocsPage`, so
 * every decision that depends on the manifest, the site config or the requested address is
 * made once, here, in a pure async function with one injected reader. The renderer then
 * branches on data rather than deriving anything, which is what makes the whole shell
 * testable by constructing this object.
 *
 * ## What it refuses, and why refusing is better than rendering
 *
 * An AST major this runtime does not know is a refusal rather than a page of skipped
 * nodes. `ast.ts` calls `unhandledNode` a last resort and says the real guard is upstream;
 * this is upstream. A bundle compiled at `ast-2` and read by an `ast-1` renderer would
 * render most of a page and silently drop the rest, which is the failure that looks
 * exactly like a working page.
 *
 * A payload that is not shaped like a compiled page is also a refusal. The renderer is
 * handed JSON fetched from the consuming site's own origin, and a truncated or half-written
 * file otherwise becomes an exception inside a React render, which on both consumers means
 * a hydration error that client-renders the entire site shell. Zod lives in `kit/` and this
 * half may import only `react`, so the check is hand-written and deliberately shallow: it
 * covers the fields the renderer branches on and leaves the rest to `unhandledNode`.
 */

import { AST_VERSION, type Block, type Heading } from '../contracts/ast.js';
import { isLocale, type Locale } from '../contracts/locales.js';
import type { BundleManifest, PageLocaleRecord } from '../contracts/manifest.js';
import type { CompiledPage } from '../contracts/page.js';
import type {
	DocsRouteVersion,
	DocsSeo,
	DocsSiteConfig,
	DocsTranslationNotice,
} from '../contracts/site.js';
import { isSectionRoot, requireSlug, slugParent, type ParsedSlug } from '../contracts/slug.js';
import { docsHref, docsHrefFor, type DocsAddress } from './address.js';
import { seoFor, translationNotice } from './notice.js';

export interface DocsRouteInput {
	manifest: BundleManifest;
	site: DocsSiteConfig;
	/** The locale from the URL. */
	locale: Locale;
	/** The slug from the URL, in wire form. */
	slug: string;
	/** The version label from a `/v/<label>/` address, if the reader pinned one. */
	pinned?: string;
	/** Where the prefetched bundle's objects are served from. */
	bundleBase: string;
	/** For the edit link. Absent means no link. */
	edit?: { repo: string; branch: string; root: string };
	/** Reads one compiled page payload. The consumer supplies it, usually a lazy glob. */
	load: (locale: Locale, slug: string) => Promise<unknown>;
}

export type DocsNavNode =
	| { kind: 'doc'; slug: string; label: string; href: string; current: boolean }
	| {
			kind: 'section';
			slug: string;
			label: string;
			href: string;
			current: boolean;
			items: DocsNavNode[];
	  };

export interface DocsCrumb {
	label: string;
	href: string;
}

export interface DocsPager {
	title: string;
	href: string;
}

/** Everything `DocsPage` needs, and nothing it has to derive. Plain JSON throughout. */
export interface DocsPageData {
	page: CompiledPage;
	/** The locale from the URL, which is the interface language. */
	locale: Locale;
	/**
	 * The bundle's own source locale.
	 *
	 * The translation notice links to it, in both of its states: a fallback sends the
	 * reader to the address that matches the words they are already reading, and a stale
	 * translation sends them to the page that is up to date. Hard-coding English here
	 * would be a second declaration of something the manifest already states.
	 */
	sourceLocale: Locale;
	address: DocsAddress;
	bundleBase: string;
	version: DocsRouteVersion;
	notice: DocsTranslationNotice;
	/** The label for the docs mount itself, from the site config, in the reader's language. */
	navLabel: string;
	nav: DocsNavNode[];
	breadcrumb: DocsCrumb[];
	previous?: DocsPager;
	next?: DocsPager;
	/** Heading alias to heading id, for a deep link written against another language. */
	aliases: Record<string, string>;
	/** The locale whose search index this page should query. */
	searchLocale: Locale;
	editUrl?: string;
}

export type DocsRouteResult =
	| { ok: true; seo: DocsSeo; data: DocsPageData }
	| { ok: false; reason: 'redirect'; to: string }
	| { ok: false; reason: 'no-such-page' | 'no-such-version' | 'unsupported-ast' | 'bad-payload' };

/**
 * A shallow structural check over a payload this half did not produce.
 *
 * Deliberately not a schema. It covers what the renderer branches on and what the shell
 * prints, which is the set whose absence produces an exception rather than a gap; anything
 * deeper is `unhandledNode`'s job, and duplicating the compiler's schema here would be a
 * second definition of the page format with nothing keeping the two in step.
 */
export function looksLikePage(value: unknown): value is CompiledPage {
	if (typeof value !== 'object' || value === null) return false;
	const page = value as Partial<CompiledPage>;
	return (
		typeof page.slug === 'string' &&
		typeof page.title === 'string' &&
		typeof page.description === 'string' &&
		typeof page.locale === 'string' &&
		isLocale(page.locale) &&
		Array.isArray(page.body) &&
		Array.isArray(page.headings) &&
		typeof page.toc === 'boolean' &&
		typeof page.reading === 'object' &&
		page.reading !== null &&
		typeof page.translation === 'object' &&
		page.translation !== null
	);
}

/**
 * Slugs the bundle carries that the site config does not list, and the reverse.
 *
 * Not called by the route: it is for the consumer's build-time guard, and it exists
 * because the failure is invisible at runtime. `site.pages` is written by `hexdocs sync`
 * at one commit and is the sole input to `LOCALISED_PATHS`, while the manifest is the
 * authority on what the bundle contains. A bundle carrying a slug the config predates
 * renders, links from the sidebar and appears in prev/next, while the host's
 * `isLocalisedPath` returns false for it, so the page ships with no canonical, no
 * alternates and no `noindex`.
 */
export function pageSkew(
	manifest: BundleManifest,
	site: DocsSiteConfig,
): { inBundleOnly: string[]; inConfigOnly: string[] } {
	const bundle = new Set(Object.keys(manifest.pages));
	const config = new Set(site.pages);
	return {
		inBundleOnly: [...bundle].filter((slug) => !config.has(slug)).sort(),
		inConfigOnly: [...config].filter((slug) => !bundle.has(slug)).sort(),
	};
}

/** Every heading in a body, depth first, so aliases can be collected without a second walk. */
function headings(blocks: readonly Block[]): Heading[] {
	const found: Heading[] = [];
	const walk = (nodes: readonly Block[]): void => {
		for (const node of nodes) {
			if (node.type === 'heading') found.push(node);
			else if (node.type === 'blockquote' || node.type === 'callout') walk(node.children);
			else if (node.type === 'list') for (const item of node.children) walk(item.children);
			else if (node.type === 'steps') for (const step of node.children) walk(step.children);
		}
	};
	walk(blocks);
	return found;
}

/**
 * Alias to heading id.
 *
 * A translated page carries the source locale's slug here, so a deep link written against
 * the English page still lands on the right section of the Japanese one, and a renamed
 * heading carries its former slug so a link from a support reply written last year still
 * works. The renderer emits `id` and leaves the rest to a scroll handler, which is what
 * this map is for.
 */
export function aliasMap(page: CompiledPage): Record<string, string> {
	const map: Record<string, string> = {};
	for (const heading of headings(page.body)) {
		for (const alias of heading.aliases ?? []) map[alias] = heading.id;
	}
	return map;
}

function labelOf(
	record: PageLocaleRecord | undefined,
	fallback: PageLocaleRecord | undefined,
): string {
	const chosen = record ?? fallback;
	// `navTitle` first, because that is the field's entire purpose and the sidebar is the
	// only place it is read. The title is the fallback, and the slug never appears: a page
	// with no record in any locale is not in the nav at all.
	return chosen?.navTitle ?? chosen?.title ?? '';
}

/**
 * The sidebar, derived from the manifest's flat nav order and the slug hierarchy.
 *
 * The bundle carries no `nav.json`, so a group that is not a page has no label to render
 * and the compiler flattens it away. That leaves exactly one kind of grouping, and it is
 * the better one: a section root is a real page with a real translated title, so a Japanese
 * reader gets a Japanese heading over their Japanese pages rather than a label somebody
 * had to remember to translate in a seventh place.
 */
export function buildNav(input: {
	manifest: BundleManifest;
	site: DocsSiteConfig;
	locale: Locale;
	current: string;
	address: DocsAddress;
}): DocsNavNode[] {
	const source = input.manifest.sourceLocale;
	const visible = input.manifest.nav.filter((node) => node.hidden !== true);

	const nodeFor = (slug: string, parsed: ParsedSlug): DocsNavNode => {
		const record = input.manifest.pages[slug];
		const label = labelOf(record?.locales[input.locale], record?.locales[source]);
		const href = docsHrefFor(parsed, input.address);
		const current = slug === input.current;
		return isSectionRoot(parsed)
			? { kind: 'section', slug, label, href, current, items: [] }
			: { kind: 'doc', slug, label, href, current };
	};

	const roots: DocsNavNode[] = [];
	const sections = new Map<string, DocsNavNode & { kind: 'section' }>();

	for (const entry of visible) {
		const parsed = requireSlug(entry.slug, 'buildNav');
		const node = nodeFor(entry.slug, parsed);
		const key = parsed.section.join('/');
		if (node.kind === 'section') {
			// A section root nests under its own parent, so `guide/index` sits at the root
			// and a deeper `guide/setup/index` sits inside `guide`.
			const parentKey = parsed.section.slice(0, -1).join('/');
			const parent = parsed.section.length === 0 ? undefined : sections.get(parentKey);
			sections.set(key, node);
			if (parent === undefined) roots.push(node);
			else parent.items.push(node);
			continue;
		}
		const parent = sections.get(key);
		if (parent === undefined) roots.push(node);
		else parent.items.push(node);
	}

	return roots;
}

/** Previous and next in reading order, hidden pages skipped. */
export function pagerFor(
	manifest: BundleManifest,
	locale: Locale,
	current: string,
	address: DocsAddress,
): { previous?: DocsPager; next?: DocsPager } {
	const order = manifest.nav.filter((node) => node.hidden !== true).map((node) => node.slug);
	const at = order.indexOf(current);
	// A hidden page has no place in the order, so it gets neither neighbour rather than
	// the two that would have surrounded it. `nav.ts` says a hidden page stays out of
	// prev/next, and half of prev/next is not out of it.
	if (at < 0) return {};
	const source = manifest.sourceLocale;
	const entry = (slug: string | undefined): DocsPager | undefined => {
		if (slug === undefined) return undefined;
		const record = manifest.pages[slug];
		const title = labelOf(record?.locales[locale], record?.locales[source]);
		return { title, href: docsHref({ ...address, slug }) };
	};
	const previous = entry(order[at - 1]);
	const next = entry(order[at + 1]);
	return {
		...(previous === undefined ? {} : { previous }),
		...(next === undefined ? {} : { next }),
	};
}

/** The trail from the docs home down to this page's parent. */
export function breadcrumbFor(
	manifest: BundleManifest,
	locale: Locale,
	slug: ParsedSlug,
	address: DocsAddress,
): DocsCrumb[] {
	const source = manifest.sourceLocale;
	const crumbs: DocsCrumb[] = [];
	let parent = slugParent(slug);
	while (parent !== undefined) {
		const wire = [...parent.section, 'index'].join('/');
		const record = manifest.pages[wire];
		if (record !== undefined) {
			crumbs.unshift({
				label: labelOf(record.locales[locale], record.locales[source]),
				href: docsHrefFor(parent, address),
			});
		}
		parent = slugParent(parent);
	}
	return crumbs;
}

export async function docsRoute(input: DocsRouteInput): Promise<DocsRouteResult> {
	if (input.manifest.ast !== AST_VERSION) return { ok: false, reason: 'unsupported-ast' };

	const latest = input.site.versions.find((entry) => entry.default === true);
	if (latest === undefined) return { ok: false, reason: 'no-such-version' };
	if (input.pinned !== undefined && !input.site.versions.some((v) => v.label === input.pinned)) {
		return { ok: false, reason: 'no-such-version' };
	}

	const address: DocsAddress = {
		basePath: input.site.basePath,
		locale: input.locale,
		...(input.pinned === undefined ? {} : { version: input.pinned }),
	};

	const redirect = input.manifest.redirects[input.slug];
	if (redirect !== undefined) {
		return { ok: false, reason: 'redirect', to: docsHref({ ...address, slug: redirect }) };
	}

	const record = input.manifest.pages[input.slug];
	// Refused when the bundle has it and the site config does not, because the consuming
	// site's `isLocalisedPath` would return false and the page would ship with no
	// canonical, no alternates and no `noindex`. `pageSkew` is what names the state at
	// build time; here it is simply not a page this mount serves.
	if (record === undefined || !input.site.pages.includes(input.slug)) {
		return { ok: false, reason: 'no-such-page' };
	}

	const source = input.manifest.sourceLocale;
	const served = record.locales[input.locale] !== undefined ? input.locale : source;
	if (record.locales[served] === undefined) return { ok: false, reason: 'no-such-page' };

	const payload = await input.load(served, input.slug);
	if (!looksLikePage(payload)) return { ok: false, reason: 'bad-payload' };
	if (payload.ast !== AST_VERSION) return { ok: false, reason: 'unsupported-ast' };

	const parsed = requireSlug(input.slug, 'docsRoute');
	const notice = translationNotice(payload, input.locale);
	const pinned = input.pinned !== undefined && input.pinned !== latest.label;

	const data: DocsPageData = {
		page: payload,
		locale: input.locale,
		sourceLocale: source,
		address,
		bundleBase: input.bundleBase,
		version: { label: input.pinned ?? latest.label, pinned, latest: latest.label },
		notice,
		navLabel: input.site.navLabel[input.locale],
		nav: buildNav({
			manifest: input.manifest,
			site: input.site,
			locale: input.locale,
			current: input.slug,
			address,
		}),
		breadcrumb: breadcrumbFor(input.manifest, input.locale, parsed, address),
		...pagerFor(input.manifest, input.locale, input.slug, address),
		aliases: aliasMap(payload),
		// The reader's own index when the bundle has one, and the source locale's
		// otherwise. A search box that returned nothing because the index for this language
		// was never built is the silent failure the header comparison exists to make loud,
		// one level up.
		searchLocale: input.manifest.search[input.locale] !== undefined ? input.locale : source,
		...(input.edit === undefined
			? {}
			: {
					editUrl: `${input.edit.repo}/edit/${input.edit.branch}/${input.edit.root}/${payload.sourceFile}`,
				}),
	};

	return { ok: true, seo: seoFor(notice, pinned), data };
}
