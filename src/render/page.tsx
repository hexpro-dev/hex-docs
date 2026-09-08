/**
 * The shell: everything on a documentation page that is not the document.
 *
 * ## What it deliberately does not render
 *
 * There is no `<main>`. Both consumers' `root.tsx` already renders one, and two `main`
 * elements is an authoring error a screen reader reports as such. That is a contract point
 * for the install rather than a detail, and `test/render/landmarks.test.ts` asserts the
 * absence with a planted positive control, because "there is no main" is satisfied by a
 * broken matcher and by a component that rendered nothing at all.
 *
 * The shell owns the only `h1`, which is why `HeadingDepth` starts at 2 and why a source
 * file that keeps its own `# Title` is a compile error. The consuming route must not render
 * a heading above the docs outlet; there is no `headingOffset` and there should not be one,
 * because two competing titles is a content problem rather than a rendering one.
 *
 * ## Four navigation landmarks, four names
 *
 * The tree, the table of contents, the breadcrumb and the pager are all `nav`. Without
 * distinct accessible names a screen reader's landmark list reads "navigation, navigation,
 * navigation, navigation" alongside whatever the surrounding site already has. All four
 * names come from the string table, so they are translated rather than English on six
 * pages out of seven.
 *
 * ## The table of contents comes from `page.headings`, and the anchors come from the body
 *
 * These are not the same list and neither substitutes for the other. The compiler filters
 * `headings` to the depths a table of contents should show: `en/guide/troubleshooting` has
 * seven headings in its body and six in `headings`, and the missing one is a depth-4
 * heading that is still a real anchor somebody can link to. Building the table of contents
 * from the body shows what the compiler deliberately filtered; building the anchors from
 * `headings` leaves that heading unlinkable.
 */

import { useMemo, useRef, type ReactElement, type ReactNode } from 'react';

import type { Locale } from '../contracts/locales.js';
import { directionOf } from '../contracts/locales.js';
import type { PageHeading } from '../contracts/page.js';
import type { DocsTranslationNotice } from '../contracts/site.js';
import { docsHref } from '../site/address.js';
import { contentAttrs } from '../site/direction.js';
import { IDS } from '../site/ids.js';
import type { DocsNavNode, DocsPageData } from '../site/route.js';
import { languageName, uiPlural, uiString } from '../ui/strings.js';
import {
	useAliasScroll,
	useDocsEvents,
	useHeadingSpy,
	useNavigationAnnounce,
	useReducedMotion,
} from './client.js';
import type { DocsLinkComponent } from './context.js';
import { PlainLink, renderBlocks } from './nodes.js';
import { DocsSearch } from './search.js';

/**
 * Slots a consumer fills, all optional.
 *
 * `<DocsPage {...data} />` with none of them renders a complete, accessible, correctly
 * themed page. `backdrop` is the one that earns its place rather than being symmetry: it
 * is how a consumer puts its own shader behind the article without this package importing
 * anything from it, and the geometry that makes it work is in the stylesheet.
 */
export interface DocsChrome {
	header?: ReactNode;
	footer?: ReactNode;
	treeTop?: ReactNode;
	treeBottom?: ReactNode;
	pageFooter?: ReactNode;
	/** Rendered behind everything, sticky, with no pointer events. */
	backdrop?: ReactNode;
}

export interface DocsPageProps extends DocsPageData {
	/** The consumer's router link. A plain anchor when absent, which is a working site. */
	Link?: DocsLinkComponent;
	/** A class the consuming site already defines, for its own per-app accent. */
	themeClass?: string;
	chrome?: DocsChrome;
	/**
	 * How a date is written.
	 *
	 * The default is the ISO date the bundle already stores, and that is deliberate rather
	 * than lazy. `Intl.DateTimeFormat` answers from whatever ICU the runtime was built
	 * with, so a server on one Node and a browser on another can produce different text
	 * for the same date, which is a hydration mismatch on a string the reader sees. A
	 * consumer that already has a date formatter its site agrees with passes it here.
	 */
	formatDate?: (iso: string) => string;
}

const isoDate = (iso: string): string => iso.slice(0, 10);

export function DocsPage(props: DocsPageProps): ReactElement {
	const Link = props.Link ?? PlainLink;
	const formatDate = props.formatDate ?? isoDate;
	const root = useRef<HTMLDivElement | null>(null);
	const article = useRef<HTMLElement | null>(null);
	const live = useRef<HTMLParagraphElement | null>(null);
	const emit = useDocsEvents(root);
	const reduced = useReducedMotion();

	const page = props.page;
	const content = contentAttrs(page, props.locale);
	const context = useMemo(
		() => ({
			locale: props.locale,
			contentLocale: page.locale,
			address: props.address,
			bundleBase: props.bundleBase,
			Link,
			emit,
		}),
		[props.locale, page.locale, props.address, props.bundleBase, Link, emit],
	);

	const active = useHeadingSpy(page.headings, emit, reduced);
	useAliasScroll(props.aliases, reduced);
	useNavigationAnnounce(
		page.slug,
		page.title,
		uiString(props.locale, 'pageLoaded', { title: page.title }),
		emit,
		reduced,
		article,
		live,
	);

	return (
		<div
			id={IDS.root}
			ref={root}
			className={props.themeClass === undefined ? 'hx-root' : `hx-root ${props.themeClass}`}
			data-hx-project={page.project}
			// Read by a consumer's own effects so they can make the same decision without
			// asking again. No rule in this package's stylesheet may select on it: it is
			// false for the whole first paint, and the real gate is the media query.
			data-reduced={reduced ? 'true' : 'false'}
			dir={directionOf(props.locale)}
		>
			<a className="hx-skip" href={`#${IDS.content}`}>
				{uiString(props.locale, 'skipToContent')}
			</a>
			{props.chrome?.backdrop}
			{props.chrome?.header}
			<div className="hx-layout">
				<nav id={IDS.tree} className="hx-tree" aria-label={props.navLabel}>
					{props.chrome?.treeTop}
					<DocsSearch
						locale={props.locale}
						searchLocale={props.searchLocale}
						address={props.address}
						bundleBase={props.bundleBase}
						Link={Link}
						emit={emit}
					/>
					<NavList nodes={props.nav} Link={Link} />
					{props.chrome?.treeBottom}
				</nav>

				<article
					id={IDS.content}
					ref={article}
					className="hx-article"
					tabIndex={-1}
					aria-labelledby={IDS.title}
					// The article carries the locale it is actually in. Labelling an English
					// fallback `lang="ja"` tells a screen reader to read English words with
					// Japanese phonetics and a translation tool that the job is done.
					{...(content.differs ? { lang: content.lang, dir: content.dir } : {})}
				>
					{props.breadcrumb.length === 0 ? null : (
						<nav
							id={IDS.breadcrumb}
							className="hx-breadcrumb"
							aria-label={uiString(props.locale, 'breadcrumbLabel')}
						>
							<ol>
								{props.breadcrumb.map((crumb) => (
									<li key={crumb.href}>
										<Link to={crumb.href}>{crumb.label}</Link>
									</li>
								))}
							</ol>
						</nav>
					)}

					<VersionBanner
						locale={props.locale}
						version={props.version}
						address={props.address}
						slug={page.slug}
						Link={Link}
					/>
					<TranslationNotice
						locale={props.locale}
						sourceLocale={props.sourceLocale}
						notice={props.notice}
						address={props.address}
						slug={page.slug}
						formatDate={formatDate}
					/>

					<h1 id={IDS.title} className="hx-title">
						{page.title}
					</h1>
					<p className="hx-meta">
						<span>{uiPlural(props.locale, 'readingTime', page.reading.minutes)}</span>
						{props.editUrl === undefined ? null : (
							<a className="hx-edit" href={props.editUrl}>
								{uiString(props.locale, 'editPage')}
							</a>
						)}
					</p>

					<div className="hx-prose">{renderBlocks(page.body, context)}</div>

					{props.chrome?.pageFooter}

					{props.previous === undefined && props.next === undefined ? null : (
						<nav
							id={IDS.pager}
							className="hx-pager"
							aria-label={uiString(props.locale, 'pagerLabel')}
						>
							{props.previous === undefined ? null : (
								<Link to={props.previous.href} className="hx-prev">
									<span className="hx-pager-kind">{uiString(props.locale, 'previous')}</span>
									<span className="hx-pager-title">{props.previous.title}</span>
								</Link>
							)}
							{props.next === undefined ? null : (
								<Link to={props.next.href} className="hx-next">
									<span className="hx-pager-kind">{uiString(props.locale, 'next')}</span>
									<span className="hx-pager-title">{props.next.title}</span>
								</Link>
							)}
						</nav>
					)}
				</article>

				{page.toc && page.headings.length > 0 ? (
					<nav id={IDS.toc} className="hx-toc" aria-labelledby={IDS.tocHeading}>
						<p id={IDS.tocHeading} className="hx-toc-heading">
							{uiString(props.locale, 'tocLabel')}
						</p>
						<ol>
							{page.headings.map((heading) => (
								<TocEntry key={heading.id} heading={heading} active={active} />
							))}
						</ol>
					</nav>
				) : null}
			</div>
			{props.chrome?.footer}
			{/*
			 * The announcement region. `role="status"` is polite, so it never interrupts,
			 * and it is emptied a second after it speaks so an unrelated later update to
			 * the same node does not read the old sentence again.
			 */}
			<p id={IDS.live} ref={live} className="hx-sr" role="status" aria-live="polite" />
		</div>
	);
}

function TocEntry({
	heading,
	active,
}: {
	heading: PageHeading;
	active: string | undefined;
}): ReactElement {
	return (
		<li className="hx-toc-item" data-depth={heading.depth}>
			<a
				href={`#${heading.id}`}
				className="hx-toc-link"
				// `aria-current="true"`, not `"location"`. The location token is for a step in
				// a process; a heading the reader is inside is the current item of this list.
				{...(heading.id === active ? { 'aria-current': true as const } : {})}
			>
				{heading.text}
			</a>
		</li>
	);
}

function NavList({ nodes, Link }: { nodes: DocsNavNode[]; Link: DocsLinkComponent }): ReactElement {
	return (
		<ol className="hx-tree-list">
			{nodes.map((node) => (
				<li key={node.slug} className="hx-tree-item">
					<Link
						to={node.href}
						className={node.kind === 'section' ? 'hx-tree-section' : 'hx-tree-link'}
						{...(node.current ? { 'aria-current': 'page' as const } : {})}
					>
						{node.label}
					</Link>
					{node.kind === 'section' && node.items.length > 0 ? (
						<NavList nodes={node.items} Link={Link} />
					) : null}
				</li>
			))}
		</ol>
	);
}

function VersionBanner({
	locale,
	version,
	address,
	slug,
	Link,
}: {
	locale: Locale;
	version: DocsPageData['version'];
	address: DocsPageData['address'];
	slug: string;
	Link: DocsLinkComponent;
}): ReactElement | null {
	if (!version.pinned) return null;
	// The same page at the default version, not the docs home. A reader who pinned 1.0.0
	// and clicked through to the current version wants the page they were reading; sending
	// them to the index makes them find it again, which is why the slug is threaded here.
	const latest = docsHref({ ...address, version: undefined, slug });
	return (
		<aside className="hx-banner" data-banner="version">
			<p>{uiString(locale, 'versionPinned', { version: version.label })}</p>
			<Link to={latest}>{uiString(locale, 'versionLatest', { version: version.latest })}</Link>
		</aside>
	);
}

function TranslationNotice({
	locale,
	sourceLocale,
	notice,
	address,
	slug,
	formatDate,
}: {
	locale: Locale;
	sourceLocale: Locale;
	notice: DocsTranslationNotice;
	address: DocsPageData['address'];
	slug: string;
	formatDate: (iso: string) => string;
}): ReactElement | null {
	if (notice.state === 'current') return null;
	// A plain anchor rather than the consumer's router link, and deliberately so: this is
	// the one link on the page that changes the reader's language, which means it changes
	// the document's `lang` and `dir`, and a client-side navigation that swapped the
	// article without the document around it would leave an Arabic shell around English
	// text. A full load is the honest way to change language.
	const sourceHref = docsHref({ ...address, locale: sourceLocale, slug });
	return (
		<aside className="hx-banner" data-banner={notice.state}>
			<p>
				{notice.state === 'stale'
					? uiString(locale, 'noticeStale', { date: formatDate(notice.sourceUpdated) })
					: uiString(locale, 'noticeFallback', {
							language: languageName(locale, notice.requested),
						})}
			</p>
			<a href={sourceHref}>{uiString(locale, 'noticeReadEnglish')}</a>
		</aside>
	);
}
