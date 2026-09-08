/**
 * What a relative markdown href becomes, and what it is refused for.
 *
 * Two things here are worth knowing before changing anything.
 *
 * The targets are built from the corpus rather than written out, so a page added to
 * `fixtures/app` moves this suite with it. A hand-written slug set would keep passing
 * against a project that no longer contains the page being linked, which is the failure
 * the corpus exists to make impossible.
 *
 * And the source-locale property is proved against every translated page in the corpus,
 * not against one example. `links.ts` says a link resolves against the source locale,
 * and the only way that claim can be wrong without any test noticing is if the one page
 * checked by name happens to link nothing that is missing a translation. The sweep
 * compares the slugs every locale of a page resolves to against the slugs its English
 * source resolves to, and asserts how many pairs it compared.
 */

import { describe, expect, test } from 'vitest';

import type { LinkKind } from '../../../src/contracts/ast.js';
import {
	createImageResolver,
	createLinkResolver,
	type LinkTargets,
} from '../../src/compile/links.js';
import { loadProject, type SourceDocument } from '../../src/compile/project.js';
import type { ImageResolution, LinkResolution, ResolvedLink } from '../../src/compile/types.js';
import { APP_ROOT, FIXTURE_ASSETS, FIXTURE_PAGES } from '../../../fixtures/index.js';

// ---------------------------------------------------------------------------
// The corpus, as a set of link targets
// ---------------------------------------------------------------------------

const project = loadProject(APP_ROOT);

/**
 * The redirect table the corpus declares.
 *
 * Taken from `FIXTURE_PAGES` rather than from front matter, because `corpus.ts` is
 * where the redirect is stated as a fact about the fixture and the compiler reading
 * the same value out of the page is the thing under test elsewhere.
 */
const redirects = new Map<string, string>();
for (const page of FIXTURE_PAGES) {
	for (const from of page.redirectFrom ?? []) redirects.set(from, page.slug);
}

/**
 * One distinct bundle name and size per asset, so a resolver that returned the wrong
 * asset's record still fails. Identical stand-ins would make the wrong answer equal to
 * the right one.
 */
const assetTargets = new Map(
	[...project.assets.keys()]
		.sort()
		.map((path, index) => [
			path,
			{ src: `assets/${String(index).repeat(64)}.png`, width: 320 + index, height: 640 + index },
		]),
);

const targets: LinkTargets = {
	slugs: new Set(project.pages.keys()),
	redirects,
	assets: assetTargets,
};

const HOME = 'content/en/index.md';
const SECTION_INDEX = 'content/en/guide/index.md';
const PAGE = 'content/en/guide/first-tag.md';

function link(file: string, href: string, title?: string): LinkResolution {
	return createLinkResolver(file, targets)(href, title);
}

function image(file: string, src: string): ImageResolution {
	return createImageResolver(file, targets)(src);
}

/** Narrows to the resolved half, failing with the refusal's own message when it is not. */
function resolved(result: LinkResolution): ResolvedLink {
	if (!result.ok) throw new Error(`expected a link, got a refusal: ${result.message}`);
	return result.link;
}

function refused(result: LinkResolution | ImageResolution): {
	message: string;
	fix: string | null;
} {
	if (result.ok) throw new Error('expected a refusal, got a resolved reference');
	return { message: result.message, fix: result.remediation };
}

/** The slug of an internal link, failing by name when the link is some other kind. */
function slugOf(result: LinkResolution): string {
	const value = resolved(result);
	if (value.kind !== 'internal') throw new Error(`expected an internal link, got "${value.kind}"`);
	return value.slug;
}

// ---------------------------------------------------------------------------
// The three things that are not paths
// ---------------------------------------------------------------------------

describe('an href that never touches the filesystem', () => {
	test('an anchor carries the fragment and no page', () => {
		expect(resolved(link(PAGE, '#station-data'))).toEqual({
			type: 'link',
			kind: 'anchor',
			anchor: 'station-data',
		});
	});

	test('a bare "#" is refused, and the message says it points at nothing', () => {
		// A renderer given an empty anchor emits a control that moves the reader nowhere,
		// and the page looks correct while one link in it is dead.
		const { message, fix } = refused(link(PAGE, '#'));
		expect(message).toBe('A link to "#" points at nothing.');
		expect(fix).toContain('heading id');
	});

	test('an empty href is refused as a link with no destination', () => {
		// `[text]()` is the unfinished link, and it is the only href that reaches this
		// refusal: anything starting with `#` was answered by the anchor branch. The
		// message used to say the link had a fragment, which named the one case that
		// cannot get here.
		const { message, fix } = refused(link(PAGE, ''));
		expect(message).toBe('A link with no destination.');
		expect(fix).toContain('ordinary text');
	});

	test('a mailto keeps the address and drops the scheme', () => {
		expect(resolved(link(PAGE, 'mailto:support@example.com'))).toEqual({
			type: 'link',
			kind: 'mailto',
			address: 'support@example.com',
		});
	});

	test('a mailto with no address is refused, and the message quotes what was written', () => {
		const { message } = refused(link(PAGE, 'mailto:support'));
		expect(message).toBe('"mailto:support" is not an email address.');
	});

	test('https is external and the href survives whole', () => {
		expect(resolved(link(PAGE, 'https://example.com/a?b=1#c'))).toEqual({
			type: 'link',
			kind: 'external',
			href: 'https://example.com/a?b=1#c',
		});
	});

	test('a title is carried when there is one and the key is absent when there is not', () => {
		// `title` is optional-and-omitted in the wire format, so writing `title: undefined`
		// would serialise to a key the AST schema refuses and the whole page would fail to
		// validate rather than one link losing a tooltip.
		expect(resolved(link(PAGE, 'https://example.com/a', 'The example'))).toEqual({
			type: 'link',
			kind: 'external',
			href: 'https://example.com/a',
			title: 'The example',
		});
		expect('title' in resolved(link(PAGE, 'https://example.com/a'))).toBe(false);
	});
});

describe('the schemes that do not reach the renderer', () => {
	test('plain http is refused by name rather than upgraded', () => {
		// Rewriting it to https would be a guess about somebody else's server. The refusal
		// names the scheme so the author fixes the link rather than the compiler inventing
		// a destination.
		const { message, fix } = refused(link(PAGE, 'http://example.com/a'));
		expect(message).toBe('"http://example.com/a" is plain http.');
		expect(fix).toContain('https');
	});

	test('javascript: is refused, and the message names the scheme', () => {
		const { message } = refused(link(PAGE, 'javascript:alert(1)'));
		expect(message).toBe('"javascript:" is not a scheme this package links to.');
	});

	test('a scheme nobody thought about is refused the same way', () => {
		// The list is what is allowed, not what is banned. A refusal keyed on a list of bad
		// schemes is one new scheme away from being wrong.
		const { message, fix } = refused(link(PAGE, 'ftp://example.com/a.txt'));
		expect(message).toBe('"ftp:" is not a scheme this package links to.');
		expect(fix).toContain('mailto');
	});
});

// ---------------------------------------------------------------------------
// A relative path becomes a slug
// ---------------------------------------------------------------------------

describe('a relative path becomes a slug', () => {
	test('a sibling page from inside a section', () => {
		expect(slugOf(link(SECTION_INDEX, 'troubleshooting.md'))).toBe('guide/troubleshooting');
	});

	test('a page in a section, from the docs home', () => {
		expect(slugOf(link(HOME, 'guide/troubleshooting.md'))).toBe('guide/troubleshooting');
	});

	test('a section index climbing one level, from a page inside it', () => {
		expect(slugOf(link(PAGE, '../index.md'))).toBe('index');
		expect(slugOf(link(PAGE, 'index.md'))).toBe('guide/index');
	});

	test('a fragment is split off the path and kept beside the slug', () => {
		// The anchor has to survive as its own field. Left on the path it would produce the
		// slug "guide/troubleshooting.md#tag-not-found", which no page has, and the whole
		// link would be reported as broken.
		expect(resolved(link(SECTION_INDEX, 'troubleshooting.md#tag-not-found'))).toEqual({
			type: 'link',
			kind: 'internal',
			slug: 'guide/troubleshooting',
			anchor: 'tag-not-found',
		});
	});

	test('an old slug resolves through the redirect the corpus declares', () => {
		// Derived from `FIXTURE_PAGES` so the corpus and the test cannot disagree about
		// which page moved. Without the redirect table this href is a link to a page that
		// does not exist, which is what every inbound link becomes the day a page is renamed.
		const moved = FIXTURE_PAGES.find((page) => (page.redirectFrom ?? []).length > 0);
		expect(moved).toBeDefined();
		const old = (moved as (typeof FIXTURE_PAGES)[number]).redirectFrom?.[0] as string;
		expect(targets.slugs.has(old)).toBe(false);
		expect(slugOf(link(HOME, `${old}.md`))).toBe((moved as (typeof FIXTURE_PAGES)[number]).slug);
	});
});

describe('what a relative path is refused for', () => {
	test('climbing out of the publishable root', () => {
		// The one thing a relative path can express that a slug cannot. A bundle built from
		// a tree that reaches outside `docs/site/` publishes whatever the author happened
		// to have beside the repository.
		const { message, fix } = refused(link(PAGE, '../../../../../secrets/notes.md'));
		expect(message).toBe('"../../../../../secrets/notes.md" climbs out of the publishable root.');
		expect(fix).toContain('docs/site/');
	});

	test('pointing at something that is not markdown', () => {
		const { message, fix } = refused(link(PAGE, '../../../assets/scan-screen.png'));
		expect(message).toBe('"../../../assets/scan-screen.png" does not point at a markdown page.');
		expect(fix).toContain('image syntax');
	});

	test('reaching into another locale tree, and the message names the locale root', () => {
		// A link into `content/ar/` would pin one reader's language into every other
		// reader's page. The slug is the address and the site chooses the language.
		const { message } = refused(link(PAGE, '../../ar/guide/troubleshooting.md'));
		expect(message).toBe('"../../ar/guide/troubleshooting.md" points outside "content/en/".');
	});

	test('a slug no page has, and the message names the slug rather than the href', () => {
		// The href is what was typed and the slug is what it meant. An author who wrote
		// "../guide/setup.md" needs to be told the project has no "guide/setup".
		const { message, fix } = refused(link(SECTION_INDEX, 'setup.md'));
		expect(message).toBe(
			'"setup.md" resolves to the slug "guide/setup", which no page in this project has.',
		);
		expect(fix).toContain('hexdocs mv');
	});
});

// ---------------------------------------------------------------------------
// The source locale, which is the property the module exists to state
// ---------------------------------------------------------------------------

describe('a link resolves against the source locale', () => {
	const REFERENCE_INDEX = 'reference/index';
	const API = 'reference/api';

	test('the corpus really does contain the case this depends on', () => {
		// If Arabic ever gains a translation of the API page, the assertion below stops
		// proving anything and this row is what says so.
		const api = FIXTURE_PAGES.find((page) => page.slug === API);
		expect(api).toBeDefined();
		expect(Object.keys((api as (typeof FIXTURE_PAGES)[number]).locales)).toEqual(['en']);
		expect(project.pages.get(API)?.has('ar')).toBe(false);
		expect(project.pages.get(REFERENCE_INDEX)?.has('ar')).toBe(true);
	});

	test('the Arabic reference index links a page nobody has translated, and that link is good', () => {
		// The line and the column are the corpus's, and they are pinned because a link that
		// silently moved to a different paragraph would still resolve while no longer being
		// the sentence the fixture was written to carry. Same line in both languages, a
		// different column, because the Arabic sentence reaches it later.
		const arabic = project.pages.get(REFERENCE_INDEX)?.get('ar') as SourceDocument;
		const english = project.pages.get(REFERENCE_INDEX)?.get('en') as SourceDocument;
		expect(positionOf(arabic.text, '](api.md)')).toEqual({ line: 19, column: 27 });
		expect(positionOf(english.text, '](api.md)')).toEqual({ line: 19, column: 17 });

		expect(slugOf(link(arabic.file, 'api.md'))).toBe(API);
		expect(slugOf(link(english.file, 'api.md'))).toBe(API);
	});

	test('every translated page resolves to the same slugs its English source does', () => {
		const failures: string[] = [];
		let compared = 0;
		let slugs = 0;
		for (const [slug, byLocale] of project.pages) {
			const source = byLocale.get('en');
			if (source === undefined) continue;
			const expected = internalSlugs(source);
			for (const [locale, document] of byLocale) {
				if (locale === 'en') continue;
				compared += 1;
				slugs += expected.length;
				const got = internalSlugs(document);
				if (got.join(',') !== expected.join(',')) {
					failures.push(`${slug} in ${locale}: ${got.join(' ')} against ${expected.join(' ')}`);
				}
			}
		}
		expect(failures).toEqual([]);

		// Derived from the corpus declaration: every page locale other than the source.
		const declared = FIXTURE_PAGES.reduce(
			(total, page) => total + Object.keys(page.locales).length - 1,
			0,
		);
		expect(compared).toBe(declared);
		expect(compared).toBe(30);
		// Two empty lists compare equal, so the pairs are worth nothing without this: a
		// resolver that refused every internal link would agree with itself on all 30.
		expect(slugs).toBe(68);
	});

	test('a quarter of the corpus links point at a page the linking locale has no file for', () => {
		// The number that says the property is load-bearing rather than incidental. A
		// resolver that checked the linking page's locale would report every one of these
		// as broken, and every one of them is correct: the page is in the bundle, and the
		// site serves the source-locale fallback with a notice and `noindex`. That is
		// `graceful` parity's normal state, not an error.
		let total = 0;
		let fallback = 0;
		for (const [, byLocale] of project.pages) {
			for (const [locale, document] of byLocale) {
				for (const slug of internalSlugs(document)) {
					total += 1;
					if (project.pages.get(slug)?.has(locale) !== true) fallback += 1;
				}
			}
		}
		expect(total).toBe(87);
		expect(fallback).toBe(22);
	});
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

describe('an image path becomes a bundle asset', () => {
	const asset = FIXTURE_ASSETS[0]?.path as string;
	const record = assetTargets.get(asset) as { src: string; width: number; height: number };

	test('the same asset is reached from three different depths', () => {
		// The number of `..` segments is the only thing that differs, and it is the only
		// part of the path the author gets wrong. A resolver that joined against the site
		// root rather than against the file would be correct for exactly one of these.
		expect(image(HOME, `../../${asset}`)).toEqual({ ok: true, ...record });
		expect(image(PAGE, `../../../${asset}`)).toEqual({ ok: true, ...record });
		expect(image('content/en/guide/deep/note.md', `../../../../${asset}`)).toEqual({
			ok: true,
			...record,
		});
	});

	test('the record carried back is the one belonging to that asset', () => {
		// Two assets with the same stand-in numbers would make a resolver that returned the
		// first entry indistinguishable from one that looked the path up.
		expect(assetTargets.size).toBe(FIXTURE_ASSETS.length);
		const other = FIXTURE_ASSETS[1]?.path as string;
		expect(image(PAGE, `../../../${other}`)).toEqual({ ok: true, ...assetTargets.get(other) });
		expect(assetTargets.get(other)?.src).not.toBe(record.src);
	});

	test('an external image is refused whatever it is spelled with', () => {
		// All three are the same failure: a browser fetch to somewhere that is not the
		// consuming site's own origin, which `connect-src 'self'` and `img-src 'self'` are
		// there to stop and which the build-time prefetch exists to make unnecessary.
		for (const src of [
			'https://example.com/shot.png',
			'//example.com/shot.png',
			'data:image/png;base64,iVBORw0KGgo=',
		]) {
			const { message, fix } = refused(image(PAGE, src));
			expect(message).toBe(`"${src}" is an external image.`);
			expect(fix).toContain('docs/site/assets/');
		}
	});

	test('an image path that climbs out is refused', () => {
		const { message, fix } = refused(image(PAGE, '../../../../marketing/hero.png'));
		expect(message).toBe('"../../../../marketing/hero.png" climbs out of the publishable root.');
		expect(fix).toBe('Assets live under docs/site/assets/.');
	});

	test('an image the project does not carry is refused, naming both spellings', () => {
		// The resolved path is in the message as well as the written one, because "which
		// file did that actually mean" is the whole question when a relative path is wrong.
		const { message, fix } = refused(image(PAGE, '../../../assets/missing.png'));
		expect(message).toBe(
			'"../../../assets/missing.png" resolves to "assets/missing.png", which is not an asset in this project.',
		);
		expect(fix).toContain('colour space');
	});
});

// ---------------------------------------------------------------------------
// The whole corpus, swept
// ---------------------------------------------------------------------------

describe('every reference the corpus contains', () => {
	test('resolves, and the counts say how many of each kind were examined', () => {
		const failures: string[] = [];
		const kinds: Record<LinkKind, number> = { internal: 0, anchor: 0, external: 0, mailto: 0 };
		let images = 0;

		const documents = corpusDocuments();
		for (const document of documents) {
			for (const reference of references(document.text)) {
				const at = `${document.file}:${reference.line}:${reference.column}`;
				if (reference.isImage) {
					images += 1;
					const result = image(document.file, reference.href);
					if (!result.ok) failures.push(`${at} ${result.message}`);
					continue;
				}
				const result = link(document.file, reference.href, undefined);
				if (!result.ok) failures.push(`${at} ${result.message}`);
				else kinds[result.link.kind] += 1;
			}
		}

		expect(failures).toEqual([]);

		// Derived: one document per declared page locale and per declared snippet locale.
		expect(documents.length).toBe(51);
		// Every kind appears, so the sweep is not one kind repeated. The counts are the
		// corpus's own and a page added to it moves them on purpose.
		expect(kinds).toEqual({ internal: 87, anchor: 8, external: 17, mailto: 15 });
		expect(images).toBe(17);
	});
});

// ---------------------------------------------------------------------------
// Reading the corpus source
// ---------------------------------------------------------------------------

/** Every page file and snippet file the project loaded, in one list. */
function corpusDocuments(): SourceDocument[] {
	return [...project.pages.values(), ...project.snippets.values()].flatMap((byLocale) => [
		...byLocale.values(),
	]);
}

interface Reference {
	isImage: boolean;
	href: string;
	line: number;
	column: number;
}

/**
 * Every inline link and image in a markdown source, with where it is.
 *
 * A deliberately crude scan rather than the parser. Its job is to prove that every href
 * an author actually typed into the corpus resolves, and running it through the parser
 * would mean a parser bug could hide a resolver bug by never handing it the link.
 */
function references(text: string): Reference[] {
	const found: Reference[] = [];
	const pattern = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	for (const match of text.matchAll(pattern)) {
		const index = match.index + match[0].indexOf('](') + 2;
		found.push({
			isImage: match[1] === '!',
			href: match[2] as string,
			...lineAndColumn(text, index),
		});
	}
	return found;
}

/** 1-based line and column of an offset, as every editor counts them. */
function lineAndColumn(text: string, index: number): { line: number; column: number } {
	const before = text.slice(0, index);
	const start = before.lastIndexOf('\n') + 1;
	return { line: before.split('\n').length, column: index - start + 1 };
}

/** 1-based position of a substring, for the one case that is pinned by position. */
function positionOf(text: string, needle: string): { line: number; column: number } {
	const index = text.indexOf(needle);
	if (index === -1) throw new Error(`"${needle}" is no longer in this fixture page`);
	return lineAndColumn(text, index);
}

/** The internal slugs one document links to, sorted, for the source-locale sweep. */
function internalSlugs(document: SourceDocument): string[] {
	const slugs: string[] = [];
	for (const reference of references(document.text)) {
		if (reference.isImage) continue;
		const result = link(document.file, reference.href, undefined);
		if (result.ok && result.link.kind === 'internal') slugs.push(result.link.slug);
	}
	return slugs.sort();
}
