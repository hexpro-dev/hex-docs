/**
 * Two consuming websites, as bytes, materialised into a temporary directory.
 *
 * **Why these are strings in a TypeScript file rather than files on disk.** Every design
 * that proposed step 5 committed `fixtures/consumer/apps/front/app/routes.ts` and its
 * siblings as real files, and all of them break this repository's own ladder on day one.
 * Measured, not predicted:
 *
 *   * `tsconfig.test.json` and `kit/tsconfig.json` both include `fixtures`, so a copied
 *     `routes.ts` importing `@react-router/dev/routes` and a `.tsx` sitemap route fail
 *     the typecheck row against a program that has neither the dependency nor a DOM lib.
 *   * `scripts/lint.mjs` has `fixtures` in `REQUIRED_DIRS` and scans `.ts`, `.tsx` and
 *     `.json`, and the real `paths.ts` carries four em dashes and `routes.ts` one. A
 *     faithful copy fails the banned-character scan, and the only exemption mechanism is
 *     scoped to declared code points in `fixtures/planted.json`, which would then have to
 *     pin an em dash in a consumer fixture forever.
 *   * `pnpm format` rewrites `- "!common/docs"` to single quotes in a YAML file, and the
 *     double quotes are the whole point: the consumer's own guard matches that literal
 *     string including them.
 *
 * Held as strings, none of that applies: the content is opaque to Prettier, invisible to
 * the typechecker, and any character a rule would object to is written as an escape. It
 * is also the pattern `materialiseCorpus()` already established one directory over.
 *
 * **These are minimal, not verbatim.** Each file carries exactly the shape the wiring
 * checks read and nothing else, and the shapes were taken from the real repositories
 * rather than invented. What each one is for is stated at the constant.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The two shapes, and the difference between them is the reason there are two.
 *
 * A single fixture would let every check be written against one consumer and pass, which
 * is how a guard ends up correct about the repository it was developed in and wrong about
 * the other one. Seven of the nine wiring checks find a materially different situation in
 * each of these.
 */
export type ConsumerShape = 'glob-workspace' | 'literal-workspace';

export interface ConsumerFile {
	/** Relative to the repository root. */
	readonly path: string;
	readonly contents: string;
	/** What this file is here to exercise. Read when a check starts failing on it. */
	readonly why: string;
}

/**
 * The first shape, after hex-web.
 *
 * A `common/*` glob that would enrol the submodule as a workspace package, a `tsconfig`
 * with block comments in its `paths` object, a `deploy.config.json` whose `extra_dirs`
 * already has a `front` key with three entries hand-packed onto one line, an existing
 * `prebuild` shared by four sibling packages, and a `LOCALISED_PATHS` that is a composed
 * mutable array with somewhere to splice.
 */
export const GLOB_WORKSPACE: readonly ConsumerFile[] = [
	{
		path: '.gitmodules',
		why: 'wiring-submodule parses the stanzas. Tab indented, as git writes it.',
		contents: [
			'[submodule "hex-terraform"]',
			'\tpath = hex-terraform',
			'\turl = git@github.com:hexpro-dev/hex-terraform.git',
			'[submodule "common/private-image-converter"]',
			'\tpath = common/private-image-converter',
			'\turl = git@github.com:hexpro-dev/private-image-converter.git',
			'',
		].join('\n'),
	},
	{
		path: 'pnpm-workspace.yaml',
		why: 'wiring-workspace-exclusion. Line 3 is a glob that enrols anything under common/, and the existing exclusion is double quoted because the consumer own guard matches that literal string including the quotes.',
		contents: [
			'packages:',
			'  - config',
			'  - common/*',
			'  # Deliberately not a workspace member, despite living under common/.',
			'  - "!common/private-image-converter"',
			'  - apps/front',
			'',
			'onlyBuiltDependencies:',
			'  - esbuild',
			'',
		].join('\n'),
	},
	{
		path: 'deploy.config.json',
		why: 'wiring-deploy-hash-dirs. The front key exists and its first three entries are hand-packed onto one line, which an insert has to leave alone.',
		contents: [
			'{',
			'\t"hash": {',
			'\t\t"exclude_dirs": [',
			'\t\t\t"node_modules", "build", "dist", ".git"',
			'\t\t],',
			'\t\t"extra_dirs": {',
			'\t\t\t"front": [',
			'\t\t\t\t"common/ui", "common/i18n", "common/blog",',
			'\t\t\t\t"common/private-image-converter"',
			'\t\t\t]',
			'\t\t}',
			'\t}',
			'}',
			'',
		].join('\n'),
	},
	{
		path: 'apps/front/tsconfig.json',
		why: 'wiring-tsconfig-path. JSONC: the paths object carries block comments, so a reader that assumes strict JSON fails here and one that strips comments is correct on both shapes.',
		contents: [
			'{',
			'\t"extends": "../../config/tsconfig.front.json",',
			'\t"compilerOptions": {',
			'\t\t"baseUrl": ".",',
			'\t\t"resolveJsonModule": true,',
			'\t\t"paths": {',
			'\t\t\t"~/*": ["./app/*"],',
			'\t\t\t/* The image converter, resolved to its TypeScript source. It is a',
			'\t\t\t * submodule whose package exports point at a dist/ that nothing in this',
			'\t\t\t * repo builds, so mapping straight to the source is what makes the',
			'\t\t\t * compiler and the bundler agree.',
			'\t\t\t */',
			'\t\t\t"@hexpro/private-image-converter": [',
			'\t\t\t\t"../../common/private-image-converter/src/index.ts"',
			'\t\t\t]',
			'\t\t}',
			'\t}',
			'}',
			'',
		].join('\n'),
	},
	{
		path: 'apps/front/package.json',
		why: 'wiring-prebuild-hook. A prebuild already exists and its value is shared verbatim by four sibling packages, so the guard is appended to this string and never to the script it names.',
		contents: [
			'{',
			'\t"name": "front",',
			'\t"private": true,',
			'\t"scripts": {',
			'\t\t"prebuild": "../../common/copy-assets.sh",',
			'\t\t"build": "react-router build",',
			'\t\t"locales:check": "node scripts/check-locales.mjs"',
			'\t}',
			'}',
			'',
		].join('\n'),
	},
	{
		path: 'apps/front/app/routes.ts',
		why: 'wiring-routes. Static leaves are declared between the bare mount and the :lang mount, which is where the docs machine routes have to go.',
		contents: [
			"import { route } from '@react-router/dev/routes';",
			'',
			'const PAGES = [',
			"\t['', 'routes/home.tsx'],",
			"\t['costs', 'routes/costs.tsx'],",
			'] as const;',
			'',
			'export default [',
			"\t...pages(''),",
			"\t...pages('en/'),",
			'\t// Static segments outrank the dynamic ":lang", so these are never shadowed.',
			"\troute('robots.txt', 'routes/robots[.]txt.tsx'),",
			"\troute('sitemap.xml', 'routes/sitemap[.]xml.tsx'),",
			"\troute(':lang', 'routes/lang.tsx', [...pages('')]),",
			'];',
			'',
		].join('\n'),
	},
	{
		path: 'apps/front/app/lib/paths.ts',
		why: 'wiring-localised-paths. A composed mutable array: there is somewhere to spread.',
		contents: [
			"import { APPS } from './apps';",
			'',
			'export const LOCALISED_PATHS: string[] = [',
			"\t'/',",
			'\t...APPS.map((app) => app.path),',
			'\t...LEGAL_PATHS,',
			'];',
			'',
			'export function isLocalisedPath(path: string): boolean {',
			'\treturn LOCALISED_PATHS.includes(normalise(path));',
			'}',
			'',
		].join('\n'),
	},
	{
		path: 'apps/front/app/routes/sitemap[.]xml.tsx',
		why: 'wiring-sitemap. A local entries array of plain objects, which is a place a docs spread can go.',
		contents: [
			"import { SUPPORTED_LANGUAGES } from '@hex-pro/i18n';",
			'',
			'const entries = [',
			"\t{ path: '/', priority: '1.0', changefreq: 'weekly' },",
			"\t{ path: '/costs', priority: '0.7', changefreq: 'monthly' },",
			'];',
			'',
			'export function loader() {',
			'\treturn new Response(render(entries), {',
			"\t\theaders: { 'Content-Type': 'application/xml' },",
			'\t});',
			'}',
			'',
		].join('\n'),
	},
	{
		path: '.mcp.json',
		why: 'wiring-mcp. Tracked, tab indented, with servers already in it, so the docs entry is added rather than the file created.',
		contents: [
			'{',
			'\t"mcpServers": {',
			'\t\t"shadcn": {',
			'\t\t\t"command": "npx",',
			'\t\t\t"args": ["-y", "shadcn@latest", "mcp"]',
			'\t\t}',
			'\t}',
			'}',
			'',
		].join('\n'),
	},
	{
		path: 'apps/front/.gitignore',
		why: 'The prefetch output has to be ignored, and neither real consumer has an entry today.',
		contents: ['.react-router/\nbuild/\n'].join(''),
	},
];

/**
 * The second shape, after kcalc-web.
 *
 * An explicit literal package list with no glob and no exclusion anywhere, a bare-JSON
 * tsconfig with one path entry and no `resolveJsonModule`, an `extra_dirs` with only a
 * `worker` key so the `front` key has to be created, no `prebuild` at all, and a
 * `LOCALISED_PATHS` that is a readonly alias of one page registry with nowhere to splice.
 *
 * Every one of those differences makes a check that was written against the first shape
 * give the wrong answer here, which is the reason this fixture exists.
 */
export const LITERAL_WORKSPACE: readonly ConsumerFile[] = [
	{
		path: '.gitmodules',
		why: 'wiring-submodule. One stanza, and no source-consumed submodule has ever been mounted here.',
		contents: [
			'[submodule "hex-terraform"]',
			'\tpath = hex-terraform',
			'\turl = git@github.com:hexpro-dev/hex-terraform.git',
			'',
		].join('\n'),
	},
	{
		path: 'pnpm-workspace.yaml',
		why: 'wiring-workspace-exclusion. No glob and no exclusion line anywhere, so the mount is already not enrolled and an exclusion here would be inert decoration. A check asserting the presence of an exclusion line would fail a correctly wired repository forever.',
		contents: [
			'packages:',
			'  - config',
			'  - web/database',
			'  - web/api',
			'  - web/front',
			'',
		].join('\n'),
	},
	{
		path: 'deploy.config.json',
		why: 'wiring-deploy-hash-dirs. extra_dirs exists with only a worker key, so the front key must be created rather than appended to, and an empty read means two different things.',
		contents: [
			'{',
			'\t"hash": {',
			'\t\t"exclude_dirs": [',
			'\t\t\t"node_modules", "build", "dist", ".git"',
			'\t\t],',
			'\t\t"extra_dirs": {',
			'\t\t\t"worker": ["web/database", "dockerfiles"]',
			'\t\t}',
			'\t}',
			'}',
			'',
		].join('\n'),
	},
	{
		path: 'web/front/tsconfig.json',
		why: 'wiring-tsconfig-path. Bare JSON, one path entry, and no resolveJsonModule, which the generated docs module needs because it imports *.docs.json directly.',
		contents: [
			'{',
			'\t"extends": "../../config/tsconfig.front.json",',
			'\t"compilerOptions": {',
			'\t\t"baseUrl": ".",',
			'\t\t"paths": {',
			'\t\t\t"~/*": ["./app/*"]',
			'\t\t}',
			'\t}',
			'}',
			'',
		].join('\n'),
	},
	{
		path: 'web/front/package.json',
		why: 'wiring-prebuild-hook. No prebuild at all: the idiom here is chaining into build, so the guard has nowhere obvious to go and the remediation differs.',
		contents: [
			'{',
			'\t"name": "front",',
			'\t"private": true,',
			'\t"scripts": {',
			'\t\t"build": "node scripts/build-lastmod.mjs && react-router build",',
			'\t\t"verify": "node scripts/verify.mjs"',
			'\t}',
			'}',
			'',
		].join('\n'),
	},
	{
		path: 'web/front/app/routes.ts',
		why: 'wiring-routes. The same two mounts, so the ordering rule is testable on both shapes.',
		contents: [
			"import { route } from '@react-router/dev/routes';",
			'',
			'export default [',
			"\t...pages(''),",
			"\troute('robots.txt', 'routes/robots[.]txt.tsx'),",
			"\troute(':lang', 'routes/lang.tsx', [...pages('')]),",
			'];',
			'',
		].join('\n'),
	},
	{
		path: 'web/front/app/lib/paths.ts',
		why: 'wiring-localised-paths. A readonly alias of one registry whose keys are a closed union with an exhaustive scope record, so a docs page cannot join it and concatenating is the supported shape.',
		contents: [
			"import { PAGES } from './pages';",
			'',
			'const PAGE_PATHS = PAGES.map((page) => page.path);',
			'',
			'export const LOCALISED_PATHS: readonly string[] = PAGE_PATHS;',
			'',
			'export function isLocalisedPath(path: string): boolean {',
			'\treturn LOCALISED_PATHS.includes(normalise(path));',
			'}',
			'',
		].join('\n'),
	},
	{
		path: 'web/front/app/routes/sitemap[.]xml.tsx',
		why: 'wiring-sitemap. No entries array at all: it flatMaps the page registry directly, so there is nowhere for a docs spread to go and the finding has to say so rather than emitting the other shape instruction.',
		contents: [
			"import { PAGES } from '~/lib/pages';",
			"import { LASTMOD_BY_KEY } from '~/lib/lastmod.json';",
			'',
			'export function loader() {',
			'\tconst urls = PAGES.flatMap((page) => render(page, LASTMOD_BY_KEY[page.key]));',
			"\treturn new Response(wrap(urls), { headers: { 'Content-Type': 'application/xml' } });",
			'}',
			'',
		].join('\n'),
	},
	{
		path: '.mcp.json',
		why: 'wiring-mcp. Servers here are launched through a wrapper, which is a shape the command-resolves assertion has to tolerate.',
		contents: [
			'{',
			'\t"mcpServers": {',
			'\t\t"recipe-scraper": {',
			'\t\t\t"command": "npx",',
			'\t\t\t"args": ["dotenv-cli", "-e", ".env.local", "--", "node", "server.js"]',
			'\t\t}',
			'\t}',
			'}',
			'',
		].join('\n'),
	},
	{
		path: 'web/front/.gitignore',
		why: 'The prefetch output has to be ignored here too, under a different site directory.',
		contents: '.react-router/\nbuild/\n',
	},
];

export interface Consumer {
	readonly shape: ConsumerShape;
	/** The repository root on disk. */
	readonly root: string;
	/** The site directory, relative to the root: what `--site` takes. */
	readonly site: string;
	readonly files: readonly ConsumerFile[];
}

const SITE_OF: Record<ConsumerShape, string> = {
	'glob-workspace': 'apps/front',
	'literal-workspace': 'web/front',
};

const FILES_OF: Record<ConsumerShape, readonly ConsumerFile[]> = {
	'glob-workspace': GLOB_WORKSPACE,
	'literal-workspace': LITERAL_WORKSPACE,
};

/**
 * Writes one shape into a fresh temporary directory and returns where.
 *
 * The caller removes it. There is no cache keyed on the shape, deliberately: `install`
 * writes into this tree, so two tests sharing one directory would be two tests sharing a
 * mutable fixture, and the second one would pass or fail depending on the first.
 */
export function materialiseConsumer(shape: ConsumerShape): Consumer {
	const root = mkdtempSync(join(tmpdir(), `hexdocs-${shape}-`));
	const files = FILES_OF[shape];
	for (const file of files) {
		const target = join(root, file.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, file.contents, 'utf8');
	}
	return { shape, root, site: SITE_OF[shape], files };
}

/**
 * The same, with a docs config already in place under the site.
 *
 * Separate from `materialiseConsumer` because "there is no docs config yet" is the state
 * `install` starts from and "there is one" is the state `verify-install` and `sync` are
 * about, and a fixture that always had one could not exercise the first.
 */
export function materialiseConsumerWithConfig(
	shape: ConsumerShape,
	siteConfigPath: string,
): Consumer {
	const consumer = materialiseConsumer(shape);
	const target = join(consumer.root, consumer.site, 'app', 'docs', 'fixture-app.docs.json');
	mkdirSync(dirname(target), { recursive: true });
	cpSync(siteConfigPath, target);
	return consumer;
}

export function removeConsumer(consumer: Consumer): void {
	rmSync(consumer.root, { recursive: true, force: true });
}

export const CONSUMER_SHAPES: readonly ConsumerShape[] = ['glob-workspace', 'literal-workspace'];
