import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { AST_NODE_TYPES } from '../src/contracts/ast.js';
import { INDEX_NORMALISATION } from '../src/contracts/search.js';
import { LOCALES, SOURCE_LOCALE, matchLocale, sortLocales } from '../src/contracts/locales.js';
import {
	MAX_NAV_DEPTH,
	NAV_GROUP_ID_PATTERN,
	navDepth,
	navDocs,
	navGroupIds,
} from '../src/contracts/nav.js';
import { DISABLE_COMMENT_PATTERN } from '../src/contracts/lint.js';
import { parseSlug } from '../src/contracts/slug.js';
import type { Locale } from '../src/contracts/locales.js';
import type { NavTree } from '../src/contracts/nav.js';
import type { TranslationState } from '../src/contracts/frontmatter.js';

import type { MaterialisedCorpus } from '../fixtures/index.js';
import {
	APP_ROOT,
	CONSUMER_ROOT,
	FIXTURE_ASSETS,
	FIXTURE_HISTORY,
	FIXTURE_PAGES,
	FIXTURE_PROJECT,
	FIXTURE_SNIPPETS,
	FOLDING_CASES,
	INCLUDE_CLAIMS,
	NODE_CLAIMS,
	REQUIRED_VARIANTS,
	PLANTED_PROSE,
	PLANTED_SUPPRESSIONS,
	PRESERVED_INVISIBLES,
	REJECTED_ASSETS,
	REJECTED_ROOT,
	SITE_ROOT,
	TOKENISER_INPUTS,
	appFileExists,
	appFiles,
	committerDate,
	contentPath,
	materialiseCorpus,
	parseFixtureFrontMatter,
	plantedCharacters,
	decodeCodePoint,
	readAppFile,
	snippetPath,
} from '../fixtures/index.js';

const site = (path: string): string => readFileSync(join(SITE_ROOT, path), 'utf8');
const nav = JSON.parse(site('nav.json')) as NavTree;
const consumer = JSON.parse(
	readFileSync(join(CONSUMER_ROOT, `${FIXTURE_PROJECT}.docs.json`), 'utf8'),
) as { project: string; pages: string[]; versions: { label: string; default?: true }[] };

/** Every markdown file the corpus declares, page and snippet alike. */
function declaredFiles(): string[] {
	const found: string[] = [];
	for (const page of FIXTURE_PAGES) {
		for (const locale of Object.keys(page.locales) as Locale[]) {
			found.push(contentPath(locale, page.slug));
		}
	}
	for (const snippet of FIXTURE_SNIPPETS) {
		for (const locale of Object.keys(snippet.locales) as Locale[]) {
			found.push(snippetPath(locale, snippet.id));
		}
	}
	return found.sort();
}

describe('the corpus is what it says it is', () => {
	test('every declared file exists', () => {
		const missing = declaredFiles().filter((path) => !appFileExists(join('docs', 'site', path)));
		expect(missing).toEqual([]);
	});

	test('every markdown file on disk is declared', () => {
		// The other direction, and the one that matters more. A page added to the tree
		// and not to the table is a page nothing states the purpose of, and it is the
		// first thing deleted when it gets in the way.
		const onDisk = appFiles()
			.filter((path) => /^docs\/site\/(content|snippets)\/.*\.md$/.test(path))
			.map((path) => path.replace('docs/site/', ''));
		expect(onDisk).toEqual(declaredFiles());
	});

	test('every asset the corpus declares exists, and so does every one it must refuse', () => {
		for (const asset of FIXTURE_ASSETS) {
			expect(appFileExists(join('docs', 'site', asset.path)), asset.path).toBe(true);
		}
		for (const asset of REJECTED_ASSETS) {
			expect(readFileSync(join(REJECTED_ROOT, asset.path)).byteLength).toBeGreaterThan(0);
		}
	});

	test('the rejected assets are outside the tree the compiler has to build', () => {
		// `hexdocs build fixtures/app` must succeed. An asset that has to be refused
		// inside it would make the corpus fail its own build, and the two requirements
		// would have to be resolved by weakening one of them.
		expect(REJECTED_ROOT.startsWith(APP_ROOT)).toBe(false);
		expect(appFiles().some((path) => path.includes('unsafe-diagram'))).toBe(false);
	});

	test('the vector asset that must be refused carries every clause the rule names', () => {
		// All five, not four. `ASSET_EXTENSIONS` in manifest.ts states the refusal as
		// script, foreignObject, <a href>, external references and every on* attribute.
		// The fixture carried four of them, so a publish-time check that implemented four
		// clauses would accept the safe glyph, reject this diagram, and ship the hole.
		// foreignObject is the one that was missing, and it is the classic bypass: it
		// embeds arbitrary XHTML inside an SVG.
		const svg = readFileSync(join(REJECTED_ROOT, 'unsafe-diagram.svg'), 'utf8');
		expect(svg).toContain('<script');
		expect(svg).toContain('<foreignObject');
		expect(svg).toContain('onload=');
		expect(svg).toMatch(/<a href=/);
		expect(svg).toMatch(/<image href="https:/);
		// And the published one carries none of it, so the rule has a passing case too.
		// The namespace declaration is the one `http` an SVG must keep: it is a name, not
		// a fetch, and a rule that refused it would refuse every valid SVG ever written.
		const safe = readAppFile('docs/site/assets/nfc-glyph.svg');
		expect(safe).not.toContain('<script');
		expect(safe).not.toContain('<foreignObject');
		expect(safe).not.toMatch(/\son[a-z]+=/);
		expect(safe).not.toMatch(/(?:href|src|xlink:href)=/);
		expect(safe.match(/http[^"]*/g)).toEqual(['http://www.w3.org/2000/svg']);
	});

	test('the deny list is outside the publishable root', () => {
		// `hexdocs init` adds `docs/site` to the public mirror's allowlist. A file naming
		// the strings that must never ship, kept inside that tree, is the same mistake in
		// miniature.
		expect(appFileExists('docs/docs.private.json')).toBe(true);
		expect(appFileExists('docs/site/docs.private.json')).toBe(false);
	});

	test('no forbidden agent file sits under the publishable root', () => {
		// `sync-public.sh` deletes these four names after copying, so one under docs/site
		// kills a tagged public release with an error about a file nobody put there.
		const forbidden = appFiles().filter((path) =>
			/^docs\/site\/.*(CLAUDE\.md|AGENTS\.md|\.claude|\.agents)/.test(path),
		);
		expect(forbidden).toEqual([]);
		expect(appFileExists('docs/CLAUDE.md')).toBe(true);
	});
});

describe('slugs and locales', () => {
	test('every slug parses, and the parse agrees with the path it came from', () => {
		for (const page of FIXTURE_PAGES) {
			const parsed = parseSlug(page.slug);
			expect(parsed.ok, `${page.slug}: ${parsed.ok ? '' : parsed.message}`).toBe(true);
		}
	});

	test('every locale directory in the tree is a locale, spelled canonically', () => {
		const directories = new Set(
			appFiles()
				.filter((path) => /^docs\/site\/(content|snippets)\//.test(path))
				.map((path) => path.split('/')[3] as string),
		);
		expect([...directories].sort()).toEqual([...LOCALES].sort());
		for (const directory of directories) {
			const match = matchLocale(directory);
			expect(match.ok && match.canonical, directory).toBe(true);
		}
	});

	test('the source locale has a file for every page, because everything is translated from it', () => {
		for (const page of FIXTURE_PAGES) {
			expect(page.locales[SOURCE_LOCALE], page.slug).toBe('source');
		}
	});

	test('the project config lists its locales in canonical order', () => {
		const config = JSON.parse(site('docs.json')) as { i18n: { locales: Locale[] } };
		expect(config.i18n.locales).toEqual(sortLocales(config.i18n.locales));
		expect(config.i18n.locales).toEqual([...LOCALES]);
	});
});

describe('the nav', () => {
	test('every page the nav names has a source file', () => {
		for (const entry of navDocs(nav)) {
			expect(
				appFileExists(join('docs', 'site', contentPath(SOURCE_LOCALE, entry.slug))),
				entry.slug,
			).toBe(true);
		}
	});

	test('the nav names exactly the pages declared to be in it', () => {
		expect(
			navDocs(nav)
				.map((entry) => entry.slug)
				.sort(),
		).toEqual(
			FIXTURE_PAGES.filter((page) => page.inNav)
				.map((page) => page.slug)
				.sort(),
		);
	});

	test('the draft is deliberately absent from the nav, and is not an orphan for it', () => {
		// A published page missing from the nav is an orphan error. A draft missing from
		// it is not, because a draft is not published. Both rules exist, and the corpus
		// is what shows they do not contradict each other.
		const draft = FIXTURE_PAGES.find((page) => page.draft === true);
		expect(draft?.inNav).toBe(false);
		expect(navDocs(nav).some((entry) => entry.slug === draft?.slug)).toBe(false);
	});

	test('no page appears in the nav twice', () => {
		const slugs = navDocs(nav).map((entry) => entry.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
	});

	test('group ids are unique and shaped for the DOM', () => {
		const ids = navGroupIds(nav);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(NAV_GROUP_ID_PATTERN.test(id), id).toBe(true);
	});

	test('the nav reaches the depth limit exactly, so the limit is exercised', () => {
		// One level short and the limit is never tested; one level over and the corpus
		// does not compile. Being exactly at it is the only state that proves anything.
		expect(navDepth(nav)).toBe(MAX_NAV_DEPTH);
	});

	test('exactly one page is hidden, with a reason rather than a bare flag', () => {
		const hidden = navDocs(nav).filter((entry) => entry.hidden !== undefined);
		expect(hidden).toHaveLength(1);
		expect((hidden[0]?.hidden as string).length).toBeGreaterThan(20);
	});
});

describe('the consuming config', () => {
	test('it names the same project as the source config', () => {
		const config = JSON.parse(site('docs.json')) as { project: string };
		expect(consumer.project).toBe(config.project);
		expect(consumer.project).toBe(FIXTURE_PROJECT);
	});

	test('its page list is every published page, which is what root.tsx needs at build time', () => {
		// `hexdocs sync` writes this. It has to be a build input because root.tsx renders
		// the canonical link and eight hreflang alternates above <Meta />, and meta() can
		// append tags but never delete them.
		expect([...consumer.pages].sort()).toEqual(
			FIXTURE_PAGES.filter((page) => page.draft !== true)
				.map((page) => page.slug)
				.sort(),
		);
	});

	test('exactly one version is the default', () => {
		expect(consumer.versions.filter((entry) => entry.default === true)).toHaveLength(1);
	});
});

describe('node coverage', () => {
	test('every AST node type is claimed by at least one page', () => {
		const claimed = new Set(NODE_CLAIMS.map((claim) => claim.type));
		expect([...AST_NODE_TYPES].filter((type) => !claimed.has(type))).toEqual([]);
	});

	test('every declared variant has a claim, and every claim has a declared variant', () => {
		// Both directions, because one is not enough. Type coverage alone is satisfied by
		// one claim per type, so every variant beyond the first was deletable with both
		// suites green, including the ones whose own reason says they are the sole
		// coverage of `align`, of `start`, of `checked`, of `wrap` and of the em dash
		// status cell. The test count would fall and nothing would compare it to anything.
		const declared = new Set(
			Object.entries(REQUIRED_VARIANTS).flatMap(([type, variants]) =>
				variants.map((variant) => `${type}\u0000${variant}`),
			),
		);
		const claimed = NODE_CLAIMS.map((claim) => `${claim.type}\u0000${claim.variant ?? ''}`);

		expect([...declared].filter((key) => !claimed.includes(key)).sort()).toEqual([]);
		expect(claimed.filter((key) => !declared.has(key)).sort()).toEqual([]);
		expect(new Set(claimed).size).toBe(claimed.length);
		expect(claimed.length).toBe(declared.size);
	});

	test('every node type has an entry in the variant table, so a new type cannot skip it', () => {
		expect([...AST_NODE_TYPES].filter((type) => !(type in REQUIRED_VARIANTS))).toEqual([]);
		expect(
			Object.keys(REQUIRED_VARIANTS).filter(
				(type) => !(AST_NODE_TYPES as readonly string[]).includes(type),
			),
		).toEqual([]);
	});

	test('every claim points at a file that exists', () => {
		for (const claim of NODE_CLAIMS) {
			expect(appFileExists(join('docs', 'site', claim.file)), claim.file).toBe(true);
		}
	});

	test.each(
		NODE_CLAIMS.map(
			(claim) =>
				[
					`${claim.type}${claim.variant === undefined ? '' : ` (${claim.variant})`}`,
					claim,
				] as const,
		),
	)('%s is still spelled the way the compiler will look for it', (_name, claim) => {
		expect(claim.pattern.test(readAppFile(join('docs', 'site', claim.file)))).toBe(true);
	});

	test('every transclusion the corpus claims is present, and names a snippet that exists', () => {
		const ids = new Set(FIXTURE_SNIPPETS.map((snippet) => snippet.id));
		for (const claim of INCLUDE_CLAIMS) {
			expect(ids.has(claim.id), claim.id).toBe(true);
			expect(claim.pattern.test(readAppFile(join('docs', 'site', claim.file))), claim.file).toBe(
				true,
			);
		}
	});

	test('a snippet exists in every locale of every page that includes it', () => {
		// Otherwise `snippet-resolves` has no valid corpus to run against: the fixture
		// would be permanently failing the rule it exists to test.
		for (const page of FIXTURE_PAGES) {
			for (const id of page.includes ?? []) {
				const snippet = FIXTURE_SNIPPETS.find((entry) => entry.id === id);
				expect(snippet, id).toBeDefined();
				for (const locale of Object.keys(page.locales) as Locale[]) {
					expect(snippet?.locales[locale], `${id} in ${locale} for ${page.slug}`).toBeDefined();
				}
			}
		}
	});
});

describe('the fixture front matter reader refuses what it cannot read', () => {
	const wrap = (body: string): string => `---\n${body}\n---\n\nA body.\n`;

	/*
	 * The module's contract is that it understands one narrow subset and refuses
	 * everything else BY NAME, because a permissive reader would accept front matter the
	 * compiler rejects, the suite would pass, and the corpus would be teaching a shape
	 * the toolchain cannot read. That claim was stated and not measured; every row here
	 * is a shape the reader used to accept and silently reinterpret.
	 */
	const refused: [string, string, string][] = [
		['a colon in a bare scalar', 'title: a: b', 'colon followed by a space'],
		['a trailing comment', 'title: Scanning # for later', '# after whitespace'],
		['a leading hash', 'title: #scanning', 'leading #'],
		['a block scalar', 'title: |', 'block scalar indicator'],
		['a quote inside a quoted scalar', 'title: "a" and "b"', 'quote inside a quoted scalar'],
		['a backslash in a quoted scalar', 'title: "a\\nb"', 'contains a backslash'],
		['a flow sequence', 'title: [a, b]', 'starts a YAML construct'],
		['a single-quoted scalar', "title: 'Scanning'", 'starts a YAML construct'],
		['a key with neither value nor list', 'title: Scanning\ntags:', 'no value and no list'],
		['a duplicate key', 'title: One\ntitle: Two', 'declared twice'],
		['a list item with no key', 'title: One\n  - orphan', 'already has a scalar value'],
		['a line that is neither', 'title: One\nnot a key line', 'is not "key: value"'],
	];

	test.each(refused)('%s is refused, naming the construct', (_name, body, needle) => {
		expect(() => parseFixtureFrontMatter(wrap(body), 'probe.md')).toThrow(needle);
	});

	test('a file with no front matter, and one that never closes it, are both refused', () => {
		expect(() => parseFixtureFrontMatter('# Just a body\n', 'probe.md')).toThrow('no front matter');
		expect(() => parseFixtureFrontMatter('---\ntitle: One\n', 'probe.md')).toThrow('never closed');
	});

	test('the subset it does accept is the one the corpus uses', () => {
		const parsed = parseFixtureFrontMatter(
			wrap(
				'title: Scanning a tag\ndescription: One sentence.\ndraft: true\ntags:\n  - scanning\n  - chips',
			),
			'probe.md',
		);
		expect(parsed.data).toEqual({
			title: 'Scanning a tag',
			description: 'One sentence.',
			draft: true,
			tags: ['scanning', 'chips'],
		});
		expect(parsed.keys).toEqual(['title', 'description', 'draft', 'tags']);
		expect(parsed.body).toBe('A body.\n');
	});

	test('a key named after something on Object.prototype is not a duplicate of it', () => {
		// `key in data` reported `constructor` as already declared. Nothing in the corpus
		// uses such a key and nothing should, but a reader that refuses the wrong file for
		// the wrong reason sends whoever hits it looking in the wrong place.
		expect(() => parseFixtureFrontMatter(wrap('constructor: One'), 'probe.md')).not.toThrow();
	});
});

describe('links and images resolve', () => {
	const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

	/** Every link target in a file, with the anchor split off. */
	function targets(path: string): { href: string; anchor: string | undefined }[] {
		const found: { href: string; anchor: string | undefined }[] = [];
		for (const match of readAppFile(join('docs', 'site', path)).matchAll(LINK)) {
			const raw = match[1] as string;
			const hash = raw.indexOf('#');
			found.push(
				hash === -1
					? { href: raw, anchor: undefined }
					: { href: raw.slice(0, hash), anchor: raw.slice(hash + 1) },
			);
		}
		return found;
	}

	/** The same path with its locale segment replaced, which is how a slug is addressed. */
	const inSourceLocale = (path: string): string =>
		path.replace(/^(content|snippets)\/[^/]+\//, `$1/${SOURCE_LOCALE}/`);

	test('every relative link resolves to a page in the slug namespace', () => {
		// Resolved against the SOURCE locale's tree, not the linking page's. A link is a
		// slug, and the slug namespace is `nav.json` plus the English tree; a locale with
		// no translation of the target still has the page, served as the English fallback
		// with a notice and noindex. Checking against the linking locale would call the
		// Arabic reference index broken for pointing at a page nobody has translated,
		// which is a state `graceful` parity exists to publish rather than refuse.
		//
		// Anchors are not resolved here. Heading id derivation is the compiler's, and
		// checking them against a slugifier this file invented would be checking the
		// wrong thing.
		let checked = 0;
		for (const path of declaredFiles()) {
			const directory = dirname(path);
			for (const { href } of targets(path)) {
				if (href.startsWith('http') || href.startsWith('mailto:') || href === '') continue;
				checked += 1;
				const resolved = inSourceLocale(posix.normalize(posix.join(directory, href)));
				expect(appFileExists(join('docs', 'site', resolved)), `${path} links to ${href}`).toBe(
					true,
				);
			}
		}
		expect(checked).toBeGreaterThan(30);
	});

	test('at least one translated page links to a page missing in its own locale', () => {
		// The fallback path, which is the whole reason the check above resolves against
		// the source locale. Without an instance in the corpus, the distinction would be
		// a comment rather than something the compiler has to get right.
		const crossing: string[] = [];
		for (const path of declaredFiles()) {
			if (path.startsWith(`content/${SOURCE_LOCALE}/`)) continue;
			const directory = dirname(path);
			for (const { href } of targets(path)) {
				if (!href.endsWith('.md')) continue;
				const resolved = posix.normalize(posix.join(directory, href));
				if (!appFileExists(join('docs', 'site', resolved))) crossing.push(`${path} -> ${href}`);
			}
		}
		expect(crossing.length).toBeGreaterThan(0);
	});

	test('every image points at an asset the corpus declares', () => {
		const declared = new Set(FIXTURE_ASSETS.map((asset) => asset.path));
		let checked = 0;
		for (const path of declaredFiles()) {
			const directory = dirname(path);
			for (const { href } of targets(path)) {
				if (!/\.(png|jpg|webp|avif|svg)$/.test(href)) continue;
				checked += 1;
				expect(declared.has(posix.normalize(posix.join(directory, href))), `${path}: ${href}`).toBe(
					true,
				);
			}
		}
		expect(checked).toBeGreaterThan(2);
	});

	test('an internal link carrying an anchor exists, because the optional field needs one', () => {
		const withAnchor = declaredFiles().flatMap((path) =>
			targets(path).filter((target) => target.anchor !== undefined && target.href.endsWith('.md')),
		);
		expect(withAnchor.length).toBeGreaterThan(0);
	});
});

describe('a translation matches the shape of its source', () => {
	/** Headings, fences and link targets, read out of one file's body. */
	function shape(path: string): {
		headings: number[];
		fences: string[];
		targets: string[];
	} {
		const body = readAppFile(join('docs', 'site', path)).replace(/^---\n[\s\S]*?\n---\n/, '');
		const headings: number[] = [];
		const fences: string[] = [];
		let current: string[] | undefined;

		for (const line of body.split('\n')) {
			if (line.startsWith('```')) {
				if (current === undefined) {
					current = [line];
				} else {
					current.push(line);
					fences.push(current.join('\n'));
					current = undefined;
				}
				continue;
			}
			if (current !== undefined) {
				current.push(line);
				continue;
			}
			const heading = /^(#{1,6})\s/.exec(line);
			if (heading !== null) headings.push((heading[1] as string).length);
		}

		const targets = [...body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g)].map(
			(match) => match[1] as string,
		);
		return { headings, fences, targets };
	}

	const pairs = FIXTURE_PAGES.flatMap((page) =>
		(Object.keys(page.locales) as Locale[])
			.filter((locale) => locale !== SOURCE_LOCALE)
			.map((locale) => [page.slug, locale] as const),
	).concat(
		FIXTURE_SNIPPETS.flatMap((snippet) =>
			(Object.keys(snippet.locales) as Locale[])
				.filter((locale) => locale !== SOURCE_LOCALE)
				.map((locale) => [`snippets:${snippet.id}`, locale] as const),
		),
	);

	const pathFor = (key: string, locale: Locale): string =>
		key.startsWith('snippets:')
			? snippetPath(locale, key.slice('snippets:'.length))
			: contentPath(locale, key);

	test('there is something to compare, in every locale', () => {
		// A pair list that quietly emptied would make every assertion below vacuous.
		expect(pairs.length).toBeGreaterThan(25);
		expect(new Set(pairs.map(([, locale]) => locale)).size).toBe(LOCALES.length - 1);
	});

	test.each(pairs)('%s in %s has the same heading structure as its source', (key, locale) => {
		// Heading parity is graded rather than binary in the linter, but the corpus has to
		// start from parity or the graded case has nothing to grade. A translator who
		// adds a heading also changes the anchor set, which breaks every deep link into
		// the page in that language and nowhere else.
		expect(shape(pathFor(key, locale)).headings).toEqual(
			shape(pathFor(key, SOURCE_LOCALE)).headings,
		);
	});

	test.each(pairs)('%s in %s carries the same code, byte for byte', (key, locale) => {
		// Code is not translated, comments included. A translated identifier compiles to
		// a snippet that does not run, in a language nobody here proofreads.
		expect(shape(pathFor(key, locale)).fences).toEqual(shape(pathFor(key, SOURCE_LOCALE)).fences);
	});

	test.each(pairs)('%s in %s points at the same targets as its source', (key, locale) => {
		// Link text is translated; the target never is. That includes the anchor: the
		// compiler records the source locale's anchor as an alias on the translated
		// heading, which is what keeps a deep link written against the English page
		// working on this one. Re-deriving the anchor from the translated heading is the
		// thing that breaks it.
		expect(shape(pathFor(key, locale)).targets).toEqual(shape(pathFor(key, SOURCE_LOCALE)).targets);
	});
});

describe('front matter', () => {
	const pageFiles = declaredFiles().filter((path) => path.startsWith('content/'));

	test('every page declares a title and a description and nothing forbidden', () => {
		for (const path of pageFiles) {
			const { data } = parseFixtureFrontMatter(readAppFile(join('docs', 'site', path)), path);
			expect(typeof data['title'], path).toBe('string');
			expect(typeof data['description'], path).toBe('string');
			for (const key of ['slug', 'order', 'date', 'author', 'category', 'lang', 'summary']) {
				expect(key in data, `${path} declares ${key}`).toBe(false);
			}
		}
	});

	test('no body carries an h1, because the title is front matter', () => {
		for (const path of pageFiles) {
			const { body } = parseFixtureFrontMatter(readAppFile(join('docs', 'site', path)), path);
			expect(/^# /m.test(body), path).toBe(false);
		}
	});

	test('a snippet declares a title and nothing else', () => {
		for (const path of declaredFiles().filter((entry) => entry.startsWith('snippets/'))) {
			const { keys } = parseFixtureFrontMatter(readAppFile(join('docs', 'site', path)), path);
			expect(keys, path).toEqual(['title']);
		}
	});

	test('the draft says so, and it is the only one', () => {
		const drafts = pageFiles.filter(
			(path) =>
				parseFixtureFrontMatter(readAppFile(join('docs', 'site', path)), path).data['draft'] ===
				true,
		);
		expect(drafts).toEqual([contentPath('en', 'notes/scratch')]);
	});

	test('the scaffolded page is the only file carrying `translated: false`', () => {
		const flagged = pageFiles.filter(
			(path) =>
				parseFixtureFrontMatter(readAppFile(join('docs', 'site', path)), path).data[
					'translated'
				] === false,
		);
		const expected = FIXTURE_PAGES.flatMap((page) =>
			(Object.entries(page.locales) as [Locale, TranslationState][])
				.filter(([, state]) => state === 'scaffolded')
				.map(([locale]) => contentPath(locale, page.slug)),
		);
		expect(flagged.sort()).toEqual(expected.sort());
		expect(expected.length).toBeGreaterThan(0);
	});

	test('redirects are declared on the page they point at', () => {
		for (const page of FIXTURE_PAGES) {
			if (page.redirectFrom === undefined) continue;
			const { data } = parseFixtureFrontMatter(
				readAppFile(join('docs', 'site', contentPath('en', page.slug))),
				page.slug,
			);
			expect(data['redirectFrom'], page.slug).toEqual([...page.redirectFrom]);
		}
	});
});

describe('planted characters and prose', () => {
	const planted = plantedCharacters();

	test('every declaration is inside the fixture corpus', () => {
		// This mechanism exempts a character from the house lint. Allowing it to name a
		// path outside `fixtures/` would turn the corpus into a way to exempt real source,
		// which is the hole the whole no-exemptions rule exists to close.
		for (const group of planted.groups) {
			for (const file of group.files) {
				expect(file.startsWith('fixtures/'), file).toBe(true);
			}
		}
	});

	test('every declared character is actually in the file that declares it', () => {
		const missing: string[] = [];
		for (const group of planted.groups) {
			for (const file of group.files) {
				const source = readFileSync(file, 'utf8');
				for (const spelling of group.codePoints) {
					if (!source.includes(String.fromCodePoint(decodeCodePoint(spelling)))) {
						missing.push(`${file} declares ${spelling} (${group.id}) and does not contain it`);
					}
				}
			}
		}
		expect(missing).toEqual([]);
	});

	test('both kinds are represented, because they are checked differently', () => {
		const kinds = new Set(planted.groups.map((group) => group.kind));
		expect([...kinds].sort()).toEqual(['data', 'violation']);
	});

	test('every planted phrase is still in the page that claims it', () => {
		for (const entry of PLANTED_PROSE) {
			expect(readAppFile(join('docs', 'site', entry.file)), entry.needle).toContain(entry.needle);
		}
	});

	test('a suppressed hit carries the comment on the line above it, and no other does', () => {
		// Per hit, not per file. `reference/api.md` carries two planted violations and one
		// suppression, so a file-level check would call both of them suppressed and the
		// unsuppressed one would stop being coverage of anything.
		for (const entry of PLANTED_PROSE) {
			const source = readAppFile(join('docs', 'site', entry.file));
			const offset = source.indexOf(entry.needle);
			expect(
				offset,
				`${entry.file} no longer contains ${JSON.stringify(entry.needle)}`,
			).toBeGreaterThanOrEqual(0);

			const before = source.slice(0, offset).split('\n');
			const previous = before[before.length - 2] ?? '';
			// The spelling has to be the one the contract will parse. An HTML comment is
			// the only way to write a comment in markdown, so the pattern is applied to
			// its inner text, and pinning that here is what stops the fixture and the
			// parser disagreeing about where a suppression may be written.
			const inner = /^<!--(.*)-->$/.exec(previous.trim())?.[1] ?? '';
			const parsed = DISABLE_COMMENT_PATTERN.exec(inner);
			if (entry.suppressed === true) {
				expect(parsed?.[1], `${entry.file}: ${entry.needle}`).toBe(entry.rule);
				expect((parsed?.[2] ?? '').length).toBeGreaterThan(20);
			} else {
				expect(parsed, `${entry.file}: ${entry.needle} is suppressed and should not be`).toBeNull();
			}
		}
	});

	test('the corpus carries fewer suppressions than the cap, so the counting is exercised', () => {
		const config = JSON.parse(site('docs.json')) as { lint: { maxDisables: number } };
		const total = declaredFiles()
			.map(
				(path) =>
					(readAppFile(join('docs', 'site', path)).match(/hexdocs-disable-next-line/g) ?? [])
						.length,
			)
			.reduce((sum, count) => sum + count, 0);
		expect(total).toBe(PLANTED_SUPPRESSIONS.length);
		expect(total).toBeGreaterThan(0);
		expect(total).toBeLessThanOrEqual(config.lint.maxDisables);
	});

	test('the deny list terms the corpus plants are declared in the deny list', () => {
		const deny = JSON.parse(readAppFile('docs/docs.private.json')) as {
			strings: string[];
			patterns: { pattern: string; flags: string }[];
		};
		const competitor = PLANTED_PROSE.find((entry) => entry.rule === 'no-competitor-name');
		expect(deny.strings).toContain(competitor?.needle);

		const leak = PLANTED_PROSE.find((entry) => entry.rule === 'internal-leak');
		const matched = deny.patterns.some((entry) =>
			new RegExp(entry.pattern, entry.flags).test(leak?.needle as string),
		);
		expect(matched).toBe(true);
	});
});

describe('the tokeniser inputs', () => {
	test('every folding case behaves the way the table says it does', () => {
		// Measured rather than asserted. `INDEX_NORMALISATION` is NFKC and the comment
		// justifying it names one product name spelled two ways; until this ran, NFC
		// would have passed every test in the repository.
		for (const entry of FOLDING_CASES) {
			expect(entry.a.normalize('NFC') === entry.b.normalize('NFC'), `${entry.id} under NFC`).toBe(
				entry.nfc,
			);
			expect(
				entry.a.normalize('NFKC') === entry.b.normalize('NFKC'),
				`${entry.id} under NFKC`,
			).toBe(entry.nfkc);
		}
	});

	test('at least one case folds under NFKC and not under NFC, which is why NFKC was chosen', () => {
		const decisive = FOLDING_CASES.filter((entry) => entry.nfkc && !entry.nfc);
		expect(decisive.map((entry) => entry.id)).toContain('micro-sign-vs-greek-mu');
		expect(decisive.length).toBeGreaterThan(1);
	});

	test('at least one case folds under neither, so nobody concludes normalisation is enough', () => {
		const stubborn = FOLDING_CASES.filter((entry) => !entry.nfkc && !entry.nfc);
		expect(stubborn.length).toBeGreaterThan(0);
		expect(stubborn.map((entry) => entry.id)).toContain('arabic-alef-hamza');
	});

	test('the declared normalisation form is the one the cases were chosen for', () => {
		expect(INDEX_NORMALISATION).toBe('NFKC');
	});

	test('each input decomposes, or does not, exactly as the table says', () => {
		// The assertion that used to be here compared NFD-then-NFKC against NFKC, which
		// holds for every string by definition: it measured Node's `normalize` and said
		// nothing about these rows. This one fails when an accented sentence is replaced
		// by an unaccented one, which is the way the table quietly stops testing anything.
		for (const input of TOKENISER_INPUTS) {
			expect(input.text.normalize('NFD') !== input.text, `${input.locale}: ${input.why}`).toBe(
				input.decomposes,
			);
		}
	});

	test('the decomposing inputs cover every script with combining marks', () => {
		const decomposing = new Set(
			TOKENISER_INPUTS.filter((input) => input.decomposes).map((input) => input.locale),
		);
		for (const locale of ['fr', 'es', 'pt-BR', 'ja', 'ar'] as const) {
			expect(decomposing.has(locale), locale).toBe(true);
		}
	});

	test('a decomposed input is indistinguishable from its composed spelling to the index', () => {
		// Which is the property that matters: under the index normalisation the two forms
		// must be one term, or a query typed one way never matches text stored the other.
		for (const input of TOKENISER_INPUTS.filter((entry) => entry.decomposes)) {
			expect(input.text.normalize('NFD').normalize(INDEX_NORMALISATION), input.locale).toBe(
				input.text.normalize(INDEX_NORMALISATION),
			);
		}
	});

	test('every locale has at least one tokeniser input', () => {
		const covered = new Set(TOKENISER_INPUTS.map((input) => input.locale));
		expect([...LOCALES].filter((locale) => !covered.has(locale))).toEqual([]);
	});

	test('the invisibles the corpus preserves survive normalisation', () => {
		for (const entry of PRESERVED_INVISIBLES) {
			const character = String.fromCodePoint(entry.codePoint);
			expect(`a${character}b`.normalize(INDEX_NORMALISATION), entry.name).toContain(character);
		}
	});

	test('the corpus really carries each of them, or nothing tests that they survive', () => {
		// Surviving normalisation is a property of the function. Being in the corpus at
		// all is what makes the compiler and the renderer meet them, and it is the half
		// that quietly stops being true when somebody rewrites a page.
		for (const entry of PRESERVED_INVISIBLES) {
			const character = String.fromCodePoint(entry.codePoint);
			const carrying = declaredFiles().filter((path) =>
				readAppFile(join('docs', 'site', path)).includes(character),
			);
			expect(carrying.length, `${entry.name}: ${entry.why}`).toBeGreaterThan(0);
		}
	});

	test('the right-to-left mark is in the Arabic pages and nowhere else', () => {
		// It fixes the visual order of a line mixing Arabic with a Latin product name.
		// One in a Latin page would be a paste artefact rather than a decision.
		const mark = String.fromCodePoint(0x200f);
		const carrying = declaredFiles().filter((path) =>
			readAppFile(join('docs', 'site', path)).includes(mark),
		);
		expect(carrying.length).toBeGreaterThan(1);
		for (const path of carrying) expect(path).toMatch(/\/ar\//);
	});

	test('no file carries a no-break space or a tab', () => {
		// A no-break space splits a term in two under NFC and is invisible in review, and
		// the folding table already covers what it does. A tab in markdown changes list
		// nesting depending on the renderer's tab width.
		for (const path of declaredFiles()) {
			const source = readAppFile(join('docs', 'site', path));
			expect(source.includes('\u00a0'), `${path} carries a no-break space`).toBe(false);
			expect(source.includes('\t'), `${path} carries a tab`).toBe(false);
		}
	});
});

describe('the materialised repository', () => {
	let corpus: MaterialisedCorpus | undefined;
	const root = (): string => (corpus as MaterialisedCorpus).root;

	beforeAll(() => {
		corpus = materialiseCorpus(mkdtempSync(join(tmpdir(), 'hexdocs-fixture-')));
	}, 60_000);

	afterAll(() => {
		if (corpus !== undefined) rmSync(corpus.root, { recursive: true, force: true });
	});

	test('every commit in the declared history landed, and each one changed something', () => {
		// The materialiser refuses an empty commit, so reaching here at all means every
		// declared date was set on a real diff. The counts are what stop that becoming a
		// claim: a history that quietly collapsed to one commit would still throw nothing.
		expect(corpus?.commits.map((commit) => commit.at)).toEqual(
			FIXTURE_HISTORY.map((commit) => commit.at),
		);
		for (const commit of corpus?.commits ?? []) {
			expect(commit.files.length, commit.message).toBeGreaterThan(0);
		}
	});

	/** Every declared (file, locale, state) triple, pages and snippets alike. */
	const declaredStates = FIXTURE_PAGES.flatMap((page) =>
		(Object.entries(page.locales) as [Locale, TranslationState][]).map(([locale, state]) => ({
			label: `${page.slug} in ${locale}`,
			path: `docs/site/${contentPath(locale, page.slug)}`,
			source: `docs/site/${contentPath(SOURCE_LOCALE, page.slug)}`,
			locale,
			state,
		})),
	).concat(
		FIXTURE_SNIPPETS.flatMap((snippet) =>
			(Object.entries(snippet.locales) as [Locale, TranslationState][]).map(([locale, state]) => ({
				label: `snippet ${snippet.id} in ${locale}`,
				path: `docs/site/${snippetPath(locale, snippet.id)}`,
				source: `docs/site/${snippetPath(SOURCE_LOCALE, snippet.id)}`,
				locale,
				state,
			})),
		),
	);

	test('the state table is not a table of one state, and covers every state that exists', () => {
		// A sweep over a table that collapsed to one state would still pass every row.
		const states = new Set(declaredStates.map((entry) => entry.state));
		expect([...states].sort()).toEqual(['current', 'scaffolded', 'source', 'stale']);
		expect(declaredStates.length).toBeGreaterThan(35);
	});

	test.each(declaredStates.map((entry) => [entry.label, entry] as const))(
		'%s is in the state the corpus declares, according to git',
		(_label, entry) => {
			// The whole point of replaying a history rather than asserting states. Before
			// this, three pairs were checked by name and the other thirty-odd `current`
			// declarations were decorative: the table could have said the opposite of what
			// git reported and nothing would have noticed.
			const at = committerDate(root(), entry.path);
			const source = committerDate(root(), entry.source);
			expect(at, entry.path).toBeDefined();
			expect(source, entry.source).toBeDefined();

			if (entry.state === 'source') {
				expect(entry.locale).toBe(SOURCE_LOCALE);
				expect(at).toBe(source);
				return;
			}
			if (entry.state === 'stale') {
				expect(
					(at as string) < (source as string),
					`${entry.label} is not older than its source`,
				).toBe(true);
				return;
			}
			// `current` and `scaffolded` are the same comparison. What separates them is the
			// flag, which is exactly why the flag exists: the dates cannot tell them apart.
			expect((at as string) >= (source as string), `${entry.label} is older than its source`).toBe(
				true,
			);
			const flagged =
				parseFixtureFrontMatter(
					readAppFile(entry.path.replace('docs/site/', 'docs/site/')),
					entry.path,
				).data['translated'] === false;
			expect(flagged, `${entry.label} declares translated: false`).toBe(
				entry.state === 'scaffolded',
			);
		},
	);

	test('the source file of the stale page is newer than every translation of it', () => {
		// This is the whole point of replaying a history rather than committing the corpus
		// in one go. Committed at once, every file carries the same date, nothing is ever
		// newer than anything, and the corpus contains no stale page to test against.
		const page = FIXTURE_PAGES.find((entry) => entry.slug === 'guide/first-tag');
		const source = committerDate(root(), `docs/site/${contentPath('en', 'guide/first-tag')}`);
		expect(source).toBeDefined();
		for (const [locale, state] of Object.entries(page?.locales ?? {}) as [
			Locale,
			TranslationState,
		][]) {
			if (locale === SOURCE_LOCALE) continue;
			const translation = committerDate(
				root(),
				`docs/site/${contentPath(locale, 'guide/first-tag')}`,
			);
			expect(translation, locale).toBeDefined();
			expect(state).toBe('stale');
			expect((translation as string) < (source as string), locale).toBe(true);
		}
	});

	test('a current translation is newer than its source, which is what makes it current', () => {
		const source = committerDate(root(), `docs/site/${contentPath('en', 'index')}`);
		const translation = committerDate(root(), `docs/site/${contentPath('ja', 'index')}`);
		expect((translation as string) > (source as string)).toBe(true);
	});

	test('the scaffolded page reads as current by its dates, which is why the flag exists', () => {
		// The failure `translated: false` closes, reproduced. Its committer date is later
		// than the English source, so timestamps alone say the page is translated. Only
		// the flag, and the rule comparing the body to the source, say otherwise.
		const source = committerDate(
			root(),
			`docs/site/${contentPath('en', 'reference/chip-support')}`,
		);
		const scaffold = committerDate(
			root(),
			`docs/site/${contentPath('es', 'reference/chip-support')}`,
		);
		expect((scaffold as string) > (source as string)).toBe(true);
	});

	test('a missing translation has no file and therefore no date at all', () => {
		expect(
			committerDate(root(), `docs/site/${contentPath('fr', 'guide/troubleshooting')}`),
		).toBeUndefined();
	});

	test('the stale snippet is newer in English than in any translation', () => {
		const source = committerDate(root(), `docs/site/${snippetPath('en', 'safety-note')}`);
		const translation = committerDate(root(), `docs/site/${snippetPath('ja', 'safety-note')}`);
		expect((translation as string) < (source as string)).toBe(true);
	});

	test('a page can be current while what it transcludes is not', () => {
		// The pair that makes effective freshness testable at all. The Japanese home page
		// is newer than its English source, and the snippet it includes is not.
		const page = committerDate(root(), `docs/site/${contentPath('ja', 'index')}`);
		const pageSource = committerDate(root(), `docs/site/${contentPath('en', 'index')}`);
		const snippet = committerDate(root(), `docs/site/${snippetPath('ja', 'safety-note')}`);
		const snippetSource = committerDate(root(), `docs/site/${snippetPath('en', 'safety-note')}`);
		expect((page as string) > (pageSource as string)).toBe(true);
		expect((snippet as string) < (snippetSource as string)).toBe(true);
	});

	test('the repository is not shallow, which the compiler refuses to run against', () => {
		expect(appFiles(root()).length).toBeGreaterThan(FIXTURE_PAGES.length);
	});
});
