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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { CONSUMER_ROOT, materialiseCorpus } from '../../fixtures/index.js';
import { buildBundle } from '../../kit/src/compile/build.js';
import { BUNDLE_TREE, type BundleManifest } from '../../src/contracts/manifest.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import type { DocsSources } from '../../src/site/serve.js';

export interface FixtureBundle {
	manifest: BundleManifest;
	/** Every object at the path prefetch writes it to, decompressed, as text. */
	objects: Map<string, string>;
}

let built: FixtureBundle | undefined;

/** The corpus, compiled once per test file. */
export function fixtureBundle(): FixtureBundle {
	if (built !== undefined) return built;
	const scratch = mkdtempSync(join(tmpdir(), 'hexdocs-serve-'));
	try {
		const corpus = materialiseCorpus(join(scratch, 'repo'));
		const result = buildBundle(corpus.root, { generator: '@hex-pro/docs-kit@0.1.0' });
		const objects = new Map<string, string>();
		for (const object of result.objects) {
			const gzipped = object.key.endsWith('.gz');
			const path = gzipped ? object.key.slice(0, -'.gz'.length) : object.key;
			objects.set(path, (gzipped ? gunzipSync(object.bytes) : object.bytes).toString('utf8'));
		}
		built = { manifest: result.manifest, objects };
		return built;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * The fixture site config, pointed at the bundle this run compiled.
 *
 * The committed config names a commit from a different corpus history, and `docsServer`
 * refuses a manifest whose commit is not the one the label names, so the default version
 * is repointed. `redirects` is what `hexdocs sync` writes from the manifest.
 */
export function fixtureSite(bundle: FixtureBundle, basePath = '/fixture-app/docs'): DocsSiteConfig {
	const committed = JSON.parse(
		readFileSync(join(CONSUMER_ROOT, 'fixture-app.docs.json'), 'utf8'),
	) as DocsSiteConfig;
	return {
		...committed,
		basePath,
		versions: committed.versions.map((entry) =>
			entry.default === true ? { ...entry, commit: bundle.manifest.commit } : entry,
		),
		redirects: { ...bundle.manifest.redirects },
	};
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
