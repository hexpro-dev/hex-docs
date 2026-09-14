/**
 * The fixture corpus compiled into a real bundle, and handed to `docsServer` the way a
 * consuming site's globs hand it over.
 *
 * Compiled rather than read from `kit/test/golden/`, because the goldens hold every page
 * payload and the manifest but only three of the raw markdown files and none of the
 * `llms.txt` files, and those are most of what `resource()` serves. Hand-writing the rest
 * would be this suite's idea of what the compiler writes, which is the drift
 * `test/support/golden.ts` exists to refuse. The cost is a materialised repository and one
 * compile, about two seconds, once per test file that asks for it.
 *
 * The keys are spelled exactly as Vite's `import.meta.glob` spells them from a consumer's
 * `app/lib/docs.server.ts`: relative, through `../docs/_bundles/<project>/<label>/`, and
 * with the gzip suffix gone because `hexdocs prefetch` writes objects decompressed. The
 * values are what the glob options produce: the parsed manifest for the eager glob, and a
 * loader resolving to the parsed payload or the text for the lazy ones.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { CONSUMER_ROOT, materialiseCorpus } from '../../fixtures/index.js';
import { buildBundle } from '../../kit/src/compile/build.js';
import { LOCALES, type Locale } from '../../src/contracts/locales.js';
import { BUNDLE_TREE, type BundleManifest } from '../../src/contracts/manifest.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import type { DocsServer, DocsSources } from '../../src/site/serve.js';

export interface FixtureBundle {
	manifest: BundleManifest;
	/** Every object at the path prefetch writes it to, decompressed, as text. */
	objects: Map<string, string>;
}

let built: FixtureBundle | undefined;

/** One materialised repository, compiled, every object at the path prefetch writes it to. */
function compile(root: string): FixtureBundle {
	const result = buildBundle(root, { generator: '@hex-pro/docs-kit@0.1.0' });
	const objects = new Map<string, string>();
	for (const object of result.objects) {
		const gzipped = object.key.endsWith('.gz');
		const path = gzipped ? object.key.slice(0, -'.gz'.length) : object.key;
		objects.set(path, (gzipped ? gunzipSync(object.bytes) : object.bytes).toString('utf8'));
	}
	return { manifest: result.manifest, objects };
}

/** The corpus, compiled once per test file. */
export function fixtureBundle(): FixtureBundle {
	if (built !== undefined) return built;
	const scratch = mkdtempSync(join(tmpdir(), 'hexdocs-serve-'));
	try {
		built = compile(materialiseCorpus(join(scratch, 'repo')).root);
		return built;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * The corpus with a change applied on top and committed, then compiled.
 *
 * For the served cases the committed corpus cannot reach, which is why
 * `kit/test/compile/divergence.test.ts` perturbs it too. The change is committed after the
 * whole replayed history, because a translation's state is a comparison of committer dates
 * and a file with no commit reads `current` against everything. Not cached, because each
 * caller perturbs it differently.
 */
export async function perturbedBundle(
	perturb: (repo: string) => Promise<void> | void,
): Promise<FixtureBundle> {
	const scratch = mkdtempSync(join(tmpdir(), 'hexdocs-perturbed-'));
	try {
		const root = materialiseCorpus(join(scratch, 'repo')).root;
		await perturb(root);
		const at = '2026-06-01T00:00:00Z';
		for (const args of [
			['add', '-A'],
			['commit', '--quiet', '--no-verify', '-m', 'perturb the corpus'],
		]) {
			execFileSync(
				'git',
				[
					'-c',
					'user.name=Fixture',
					'-c',
					'user.email=fixture@example.com',
					'-c',
					'commit.gpgsign=false',
					...args,
				],
				{
					cwd: root,
					stdio: 'ignore',
					env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
				},
			);
		}
		return compile(root);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * The fixture site config, checked against the bundle this run compiled.
 *
 * The committed config is what `hexdocs sync` writes for this corpus: its default version
 * names the commit the corpus materialises to, and its `redirects` are the manifest's.
 * They are compared here rather than patched in memory, because a patch would keep every
 * suite green over a checked-in config that no longer matches the corpus, which is the
 * one file a reader takes as an example of a synced config. A corpus edit moves the sha,
 * and this names the file to update instead of letting `docsServer` answer every request
 * with a 500 about a commit.
 */
export function fixtureSite(bundle: FixtureBundle, basePath = '/fixture-app/docs'): DocsSiteConfig {
	const committed = JSON.parse(
		readFileSync(join(CONSUMER_ROOT, 'fixture-app.docs.json'), 'utf8'),
	) as DocsSiteConfig;
	const pinned = committed.versions.find((entry) => entry.default === true)?.commit;
	if (pinned !== bundle.manifest.commit) {
		throw new Error(
			`fixtures/site/fixture-app.docs.json names ${String(pinned)} as its default commit, and ` +
				`the fixture corpus materialises to ${bundle.manifest.commit}. Set the default ` +
				`version's commit to that sha.`,
		);
	}
	const redirects = JSON.stringify(committed.redirects ?? {});
	if (redirects !== JSON.stringify(bundle.manifest.redirects)) {
		throw new Error(
			`fixtures/site/fixture-app.docs.json carries redirects ${redirects}, and the compiled ` +
				`manifest carries ${JSON.stringify(bundle.manifest.redirects)}. Copy the manifest's.`,
		);
	}
	return { ...committed, basePath };
}

/**
 * The fixture site config over a perturbed bundle.
 *
 * `fixtureSite` refuses any commit but the committed config's, which is right for the corpus
 * as committed and cannot be satisfied by a perturbation, whose commit is one past the
 * replayed history. So the default version names the perturbed bundle's commit, and
 * everything else is the committed file's.
 */
export function perturbedSite(bundle: FixtureBundle): DocsSiteConfig {
	const committed = JSON.parse(
		readFileSync(join(CONSUMER_ROOT, 'fixture-app.docs.json'), 'utf8'),
	) as DocsSiteConfig;
	return {
		...committed,
		versions: committed.versions.map((entry) =>
			entry.default === true ? { ...entry, commit: bundle.manifest.commit } : entry,
		),
	};
}

/** One page address in one locale, as `languageSweep` requested it and was answered. */
export interface SweptAddress {
	slug: string;
	locale: Locale;
	/** Whether the page's `seo.languages` names the locale it was requested in. */
	named: boolean;
	/** Whether the page was served `indexable` at that address. */
	indexable: boolean;
}

/**
 * Every page of a site in every locale, through `page()`, with no pair picked by hand.
 *
 * Returned rather than asserted, so each caller states what its bundle has to contain for
 * the agreement to mean anything. A bundle in which no locale's indexability differs between
 * a record's own state and its effective one agrees whichever of the two a reader reads.
 */
export async function languageSweep(
	server: DocsServer,
	site: DocsSiteConfig,
): Promise<SweptAddress[]> {
	const swept: SweptAddress[] = [];
	for (const slug of site.pages) {
		for (const locale of LOCALES) {
			const prefix = locale === 'en' ? '' : `/${locale}`;
			const path = slug === 'index' ? '' : `/${slug.replace(/\/?index$/, '')}`;
			const loaded = await server.page(
				new URL(`${prefix}${site.basePath}${path}`, 'http://docs.test'),
			);
			swept.push({
				slug,
				locale,
				named: loaded.seo.languages.includes(locale),
				indexable: loaded.seo.indexable,
			});
		}
	}
	return swept;
}

/** The glob key a consumer's `import.meta.glob` produces for one stored object. */
export function globKey(site: DocsSiteConfig, path: string, prefix = '../docs'): string {
	const label = site.versions.find((entry) => entry.default === true)?.label as string;
	return `${prefix}/${BUNDLE_TREE}/${site.project}/${label}/${path}`;
}

/** The four sources, for one site over one bundle. */
export function fixtureSources(bundle: FixtureBundle, site: DocsSiteConfig): DocsSources {
	const pages: DocsSources['pages'] = {};
	const text: DocsSources['text'] = {};
	for (const [path, body] of bundle.objects) {
		if (path.startsWith('pages/')) {
			pages[globKey(site, path)] = async () => JSON.parse(body) as unknown;
		} else if (path.startsWith('raw/') || path.startsWith('llms/')) {
			text[globKey(site, path)] = async () => body;
		}
	}
	return {
		configs: [site],
		manifests: { [globKey(site, 'manifest.json')]: bundle.manifest },
		pages,
		text,
	};
}
