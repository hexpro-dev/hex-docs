import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { CONSUMER_ROOT } from '../../fixtures/index.js';
import { LOCALES } from '../../src/contracts/locales.js';
import { assetKey, rawKey, searchKey } from '../../src/contracts/manifest.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import { bundleUrl, docsHref, docsRawHref } from '../../src/site/address.js';

const SITE = JSON.parse(
	readFileSync(join(CONSUMER_ROOT, 'fixture-app.docs.json'), 'utf8'),
) as DocsSiteConfig;

const base = '/fixture-app/docs';

describe('the path a slug resolves to', () => {
	test('the docs home is the mount itself, with no trailing slash', () => {
		// hex-nfc's only page. Both consumers strip one trailing slash before they compare a
		// path, so the slashed spelling shipped this page with noindex and no alternates.
		expect(docsHref({ basePath: base, locale: 'en', slug: 'index' })).toBe('/fixture-app/docs');
	});

	test('a section root is spelled exactly like a leaf, with no trailing slash', () => {
		expect(docsHref({ basePath: base, locale: 'en', slug: 'guide/index' })).toBe(
			'/fixture-app/docs/guide',
		);
		expect(docsHref({ basePath: base, locale: 'en', slug: 'guide/first-tag' })).toBe(
			'/fixture-app/docs/guide/first-tag',
		);
	});

	test('English is unprefixed and every other language carries its code', () => {
		expect(docsHref({ basePath: base, locale: 'en', slug: 'reference/api' })).toBe(
			'/fixture-app/docs/reference/api',
		);
		expect(docsHref({ basePath: base, locale: 'ja', slug: 'reference/api' })).toBe(
			'/ja/fixture-app/docs/reference/api',
		);
	});

	test('pt-BR keeps its capitals, because it is a language tag and not a slug', () => {
		// `/pt-br/...` redirects to this spelling in both consumers. Lower-casing here
		// would emit the address that redirects, on every link, in one language.
		expect(docsHref({ basePath: base, locale: 'pt-BR', slug: 'index' })).toBe(
			'/pt-BR/fixture-app/docs',
		);
	});

	test('a pinned version sits immediately after the mount', () => {
		// `v` is a reserved slug root precisely so this segment cannot be ambiguous with
		// a page called `v`.
		expect(
			docsHref({ basePath: base, locale: 'en', version: '1.0.0', slug: 'guide/first-tag' }),
		).toBe('/fixture-app/docs/v/1.0.0/guide/first-tag');
		expect(docsHref({ basePath: base, locale: 'ar', version: '1.0.0', slug: 'index' })).toBe(
			'/ar/fixture-app/docs/v/1.0.0',
		);
	});

	test('an anchor goes last, straight after the path', () => {
		expect(
			docsHref({ basePath: base, locale: 'en', slug: 'guide/index', anchor: 'before-you-start' }),
		).toBe('/fixture-app/docs/guide#before-you-start');
		expect(docsHref({ basePath: base, locale: 'ja', slug: 'index', anchor: 'top' })).toBe(
			'/ja/fixture-app/docs#top',
		);
	});

	test('never emits a double slash or a trailing one, in any locale, for any page', () => {
		// The join is written without a collapse pass over the result, so this is what
		// says the join is right rather than tidied. A double slash is a different URL to a
		// crawler, and a trailing one is the spelling both consumers normalise away before
		// comparing, so neither can be the canonical address.
		let checked = 0;
		for (const locale of LOCALES) {
			for (const slug of SITE.pages) {
				const href = docsHref({ basePath: base, locale, slug });
				expect(href).not.toMatch(/\/\//);
				expect(href.endsWith('/'), href).toBe(false);
				expect(href.startsWith('/')).toBe(true);
				checked += 1;
			}
		}
		expect(checked).toBe(LOCALES.length * SITE.pages.length);
	});

	test('refuses a slug it cannot parse, rather than emitting a plausible address', () => {
		expect(() => docsHref({ basePath: base, locale: 'en', slug: 'Guide/First-Tag' })).toThrow(
			/docsHref/,
		);
		expect(() => docsHref({ basePath: base, locale: 'en', slug: '' })).toThrow();
	});
});

describe('the raw markdown address', () => {
	test('is the wire slug with .md, so the home is index.md and a section root keeps its index', () => {
		// The spelling llms.txt links with and the raw tree is keyed by. The address path
		// would make the home `/fixture-app/docs.md`.
		expect(docsRawHref({ basePath: base, locale: 'en', slug: 'index' })).toBe(
			'/fixture-app/docs/index.md',
		);
		expect(docsRawHref({ basePath: base, locale: 'en', slug: 'guide/index' })).toBe(
			'/fixture-app/docs/guide/index.md',
		);
		expect(docsRawHref({ basePath: base, locale: 'pt-BR', slug: 'guide/first-tag' })).toBe(
			'/pt-BR/fixture-app/docs/guide/first-tag.md',
		);
	});

	test('refuses a slug it cannot parse, like every other address builder', () => {
		expect(() => docsRawHref({ basePath: base, locale: 'en', slug: '../secret' })).toThrow(
			/docsRawHref/,
		);
	});
});

describe('bundle object URLs', () => {
	test('reuse the manifest key vocabulary and drop the gzip suffix', () => {
		// `prefetch` writes these decompressed into the site's own public directory: a
		// static server hands a .gz file over with no Content-Encoding and the browser
		// renders binary.
		expect(bundleUrl('/_docs/fixture-app/1.1.0', searchKey('ja'))).toBe(
			'/_docs/fixture-app/1.1.0/search/ja.idx.json',
		);
		expect(bundleUrl('/_docs/fixture-app/1.1.0', rawKey('en', 'guide/first-tag'))).toBe(
			'/_docs/fixture-app/1.1.0/raw/en/guide/first-tag.md',
		);
	});

	test('leave an asset key alone, because assets are not stored gzipped', () => {
		const key = assetKey('a'.repeat(64), 'png');
		expect(bundleUrl('/_docs/fixture-app/1.1.0', key)).toBe(
			`/_docs/fixture-app/1.1.0/assets/${'a'.repeat(64)}.png`,
		);
	});

	test('tolerate a base with a trailing slash without producing a double one', () => {
		expect(bundleUrl('/_docs/fixture-app/1.1.0/', 'assets/x.png')).toBe(
			'/_docs/fixture-app/1.1.0/assets/x.png',
		);
	});
});
