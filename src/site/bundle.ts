/**
 * The prefetched bundles, as the consumer's globs hand them over, and the checks a bundle has
 * to pass before anything is served from it.
 *
 * Shared by the page and machine routes in `serve.ts` and by the agent interface in
 * `agents.ts`, which read the same objects and must refuse the same broken states with the
 * same sentence. It was private to `serve.ts` until the agent interface needed it; nothing
 * here changed in the move.
 */

import { AST_VERSION } from '../contracts/ast.js';
import type { Locale } from '../contracts/locales.js';
import {
	BUNDLE_TREE,
	MANIFEST_KEY,
	MANIFEST_VERSION,
	PUBLIC_TREE,
	validateManifestShape,
	type BundleManifest,
} from '../contracts/manifest.js';
import { validateSearchIndexShape, type SearchIndex } from '../contracts/search.js';
import type { DocsSiteConfig, VersionEntry } from '../contracts/site.js';
import { assertIndexCompatible } from '../search/query.js';

export interface DocsSources {
	configs: readonly DocsSiteConfig[];
	/** Eager glob of `../docs/_bundles/*\/*\/manifest.json`, `import: 'default'`. */
	manifests: Record<string, unknown>;
	/** Lazy glob of `../docs/_bundles/*\/*\/pages/**\/*.json`, `import: 'default'`. */
	pages: Record<string, () => Promise<unknown>>;
	/**
	 * Lazy glob of `../docs/_bundles/*\/*\/raw/**\/*.md` and `../docs/_bundles/*\/*\/llms/*.txt`,
	 * `query: '?raw'`, `import: 'default'`.
	 *
	 * Typed as resolving to `unknown`, not `string`. The module `install` writes passes
	 * `import.meta.glob<string>`, which Vite 7 types as resolving to `string`, but that type
	 * argument is an assertion Vite never checks, and the module is the consumer's to edit.
	 * The same glob written without it resolves to `unknown`, which a `string` here would
	 * refuse with TS2322. So the field takes the widest glob a consumer may write, and each
	 * value is checked when it is read, which is also what refuses a glob written without
	 * `import: 'default'`.
	 */
	text: Record<string, () => Promise<unknown>>;
	/**
	 * Lazy glob of `../docs/_bundles/*\/*\/search/*.idx.json`, `import: 'default'`.
	 *
	 * Optional, because only the agent interface reads it: the docs pages fetch the copy
	 * `hexdocs prefetch` writes into `public/`, from the browser. A site that passes nothing
	 * here serves every page as before and answers a search through the agent interface with
	 * a 500 naming the glob. Lazy, so the index is parsed on the first query rather than at
	 * start-up, and only for the locale asked.
	 */
	search?: Record<string, () => Promise<unknown>>;
}

/** The directory a bundle's public objects are served from: `/_docs/<project>/<label>`. */
export function bundleBaseOf(project: string, label: string): string {
	return `/${PUBLIC_TREE}/${project}/${label}`;
}

/** Where `hexdocs prefetch` writes an object: its key with the gzip suffix gone. */
export function stored(key: string): string {
	return key.endsWith('.gz') ? key.slice(0, -'.gz'.length) : key;
}

/**
 * `<anything>/_bundles/<project>/<label>/<object>`, split on the tree name.
 *
 * Parsed on the `BUNDLE_TREE` segment rather than on a prefix, so the relative path a
 * consumer's glob produces decides nothing, and a server module moved to another directory
 * keeps working. The last occurrence is used, which is unambiguous: no project,
 * label, locale or slug segment may begin with an underscore. A key that does not have
 * that shape names no bundle and is ignored; if every key is like that, every request
 * for the site reports its bundle as missing, which names the fix.
 */
function splitKey(key: string): { bundle: string; object: string } | undefined {
	const segments = key.split('/');
	const at = segments.lastIndexOf(BUNDLE_TREE);
	if (at < 0 || segments.length < at + 4) return undefined;
	return {
		bundle: `${segments[at + 1]}/${segments[at + 2]}`,
		object: segments.slice(at + 3).join('/'),
	};
}

export interface BundleFiles {
	manifest?: unknown;
	pages: Map<string, () => Promise<unknown>>;
	text: Map<string, () => Promise<unknown>>;
	search: Map<string, () => Promise<unknown>>;
}

export function indexSources(sources: DocsSources): Map<string, BundleFiles> {
	const bundles = new Map<string, BundleFiles>();
	const filesFor = (bundle: string): BundleFiles => {
		let files = bundles.get(bundle);
		if (files === undefined) {
			files = { pages: new Map(), text: new Map(), search: new Map() };
			bundles.set(bundle, files);
		}
		return files;
	};
	for (const [key, value] of Object.entries(sources.manifests)) {
		const split = splitKey(key);
		if (split !== undefined && split.object === MANIFEST_KEY)
			filesFor(split.bundle).manifest = value;
	}
	for (const [field, loaders] of [
		['pages', sources.pages],
		['text', sources.text],
		['search', sources.search ?? {}],
	] as const) {
		for (const [key, load] of Object.entries(loaders)) {
			const split = splitKey(key);
			if (split !== undefined) filesFor(split.bundle)[field].set(split.object, load);
		}
	}
	return bundles;
}

export type Bundle =
	| {
			ok: true;
			manifest: BundleManifest;
			label: string;
			bundleBase: string;
			files: BundleFiles;
	  }
	| { ok: false; message: string };

/**
 * The default version's bundle for one site, checked once.
 *
 * Four identity checks before the shape check, because each names a different wrong
 * state and all of them are a site that ran `hexdocs prefetch` against a different config
 * or not at all. The commit comparison is the one worth stating: a relabel moves a label
 * to another commit, and a build that skipped the prefetch would otherwise serve the old
 * commit's pages under the new label with nothing on the page to show it.
 *
 * `validateManifestShape` is written against the manifest type and dereferences it
 * freely, so an object that is not shaped like a manifest throws from inside it. That
 * throw is caught here and becomes the same refusal. Letting it escape would be a
 * `TypeError` inside a page loader and inside the sitemap loader, which React Router
 * answers with a 500 that says nothing about prefetching.
 */
export function checkBundle(site: DocsSiteConfig, bundles: Map<string, BundleFiles>): Bundle {
	const version: VersionEntry | undefined = site.versions.find((entry) => entry.default === true);
	if (version === undefined) {
		return {
			ok: false,
			message: `The ${site.project} docs config has no default version, so there is no bundle to serve. Label a version as the default and run hexdocs prefetch.`,
		};
	}
	const refuse = (reason: string): Bundle => ({
		ok: false,
		message: `The ${site.project} docs bundle for version "${version.label}" cannot be served: ${reason}. Run hexdocs prefetch for this site, then rebuild.`,
	});

	const files = bundles.get(`${site.project}/${version.label}`);
	const value = files?.manifest;
	if (files === undefined || value === undefined) {
		return refuse(`no ${BUNDLE_TREE}/${site.project}/${version.label}/${MANIFEST_KEY} was found`);
	}
	if (typeof value !== 'object' || value === null) return refuse('its manifest is not an object');
	const claimed = value as Partial<BundleManifest>;
	if (claimed.manifest !== MANIFEST_VERSION) {
		return refuse(`its manifest version is ${String(claimed.manifest)}, not ${MANIFEST_VERSION}`);
	}
	if (claimed.ast !== AST_VERSION) {
		return refuse(
			`it was compiled at ast-${String(claimed.ast)} and this runtime reads ast-${AST_VERSION}`,
		);
	}
	if (claimed.project !== site.project) {
		return refuse(`its manifest names project "${String(claimed.project)}"`);
	}
	if (claimed.commit !== version.commit) {
		return refuse(
			`its manifest is commit ${String(claimed.commit)} and the label names ${version.commit}`,
		);
	}

	let problems: string[];
	try {
		problems = validateManifestShape(value as BundleManifest);
	} catch (error) {
		problems = [`it is not shaped like a manifest (${String(error)})`];
	}
	if (problems.length > 0) return refuse(problems.join(' '));

	return {
		ok: true,
		manifest: value as BundleManifest,
		label: version.label,
		bundleBase: bundleBaseOf(site.project, version.label),
		files,
	};
}

/**
 * One object from a lazy glob, or `undefined` for an object the glob does not have and for
 * one whose loader rejects, because to the reader both mean the object is not in this build.
 * Each caller then refuses with a 500 naming the object, rather than letting a rejection
 * escape a loader that promises a `Response`.
 */
export async function readObject(
	loaders: ReadonlyMap<string, () => Promise<unknown>>,
	key: string,
): Promise<unknown> {
	const loader = loaders.get(stored(key));
	try {
		return loader === undefined ? undefined : await loader();
	} catch {
		return undefined;
	}
}

/**
 * A text object, or `undefined` when it is unreadable.
 *
 * A value that is not a string is unreadable too. That is what a glob written without
 * `import: 'default'` hands over, a module object with the text inside it, and serving
 * `[object Object]` as markdown with a 200 is the failure that looks like a page.
 */
export async function readText(files: BundleFiles, key: string): Promise<string | undefined> {
	const text = await readObject(files.text, key);
	return typeof text === 'string' ? text : undefined;
}

/**
 * One locale's search index, checked, or the sentence saying why there is none.
 *
 * The same two checks the browser makes before it scores anything, for the same reason: an
 * index built by a tokeniser this runtime does not implement returns nothing for most queries,
 * silently, and a truncated one ranks the wrong sections. Both are refusals here, once per
 * index per process, rather than an empty result an agent would take as "no such page".
 */
export async function loadSearchIndex(
	site: DocsSiteConfig,
	bundle: Bundle & { ok: true },
	locale: Locale,
): Promise<{ ok: true; index: SearchIndex } | { ok: false; message: string }> {
	const key = `search/${locale}.idx.json`;
	const value = await readObject(bundle.files.search, key);
	const refuse = (reason: string) => ({
		ok: false as const,
		message: `The ${site.project} docs search index for version "${bundle.label}" in ${locale} cannot be read: ${reason}. Pass the search glob to docsServer, run hexdocs prefetch for this site, then rebuild.`,
	});
	if (typeof value !== 'object' || value === null) {
		return refuse(`no readable ${BUNDLE_TREE}/${site.project}/${bundle.label}/${key} was found`);
	}
	const index = value as SearchIndex;
	try {
		assertIndexCompatible(index);
		const problems = validateSearchIndexShape(index);
		if (problems.length > 0) return refuse(problems.join(' '));
	} catch (error) {
		// `assertIndexCompatible` throws a sentence naming every disagreeing header field, and a
		// value shaped nothing like an index throws a `TypeError` from inside the shape check.
		return refuse(String(error));
	}
	if (index.bundle !== bundle.manifest.commit) {
		return refuse(`it is commit ${index.bundle} and the manifest is ${bundle.manifest.commit}`);
	}
	return { ok: true, index };
}
