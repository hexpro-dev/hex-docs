/**
 * What every published object points at, and which of those destinations nothing serves.
 *
 * Two representations of one address carry links, and both have to name only pages the
 * bundle has a record for. A raw object carries `hexdocs:page/<slug>.md` tokens that a site
 * turns into addresses, and a page payload carries `internal` link nodes that the renderer
 * turns into addresses. A site builds its route rows from `manifest.pages` and nothing
 * else, so a destination naming a slug with no record is a 404 in both, and neither the
 * manifest's own invariants nor the lint can see inside a gzipped object to say so.
 *
 * Shared by the golden test, which runs it over the corpus, and by the divergence tests,
 * which run it over the perturbations the corpus cannot reach. Only the second can fail:
 * the corpus has no linked page that is missing its source-locale file, so a check that
 * ran over the corpus alone passed whatever the link resolver was handed.
 */

import { RAW_ASSET_LINK, RAW_PAGE_LINK } from '../../../src/contracts/manifest.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';
import type { BuildResult } from '../../src/compile/build.js';
import { highlight } from '../../src/compile/highlight/index.js';
import { parseDocument } from '../../src/compile/markdown/index.js';
import { gunzipMember } from '../../src/compile/serialise.js';

export interface RawDestinationSweep {
	/**
	 * `<object key>: <destination>` for every token naming a page with no record or an asset
	 * the bundle does not carry. A site substitutes these into addresses it has no route for.
	 */
	offending: string[];
	/**
	 * `<object key>: <destination>` for every destination left as the author typed it.
	 *
	 * Separate from `offending` because it is a different state. A destination the compiler
	 * could not resolve stays in the raw object as written and raises its own
	 * `link-resolves` error, which is what refuses the publish, so a perturbed build that
	 * should fail carries these and a clean build carries none.
	 */
	unresolved: string[];
	seen: { page: number; asset: number; other: number };
	/**
	 * Tokens sitting exactly where a site substitutes: `](` followed by a prefix. A token the
	 * parser reads back as a destination and the substitution does not find is served to a
	 * reader as `hexdocs:page/...`, so this has to equal `seen.page + seen.asset`.
	 */
	substitutable: number;
	/** How many raw objects were read, so a sweep over none reads as a failure. */
	raws: number;
}

/**
 * Every destination in every raw object, read back with the compiler's own parser.
 *
 * The parser rather than a pattern, because that is what a markdown reader of the object
 * sees: a pattern over the text would count a sample in a fence or a code span as a link.
 */
export function rawDestinations(result: BuildResult): RawDestinationSweep {
	const pages = new Set(Object.keys(result.manifest.pages));
	const assets = new Set(result.manifest.assets.map((asset) => `${asset.sha256}.${asset.ext}`));
	const offending: string[] = [];
	const unresolved: string[] = [];
	const seen = { page: 0, asset: 0, other: 0 };

	const check = (key: string, href: string): void => {
		if (href.startsWith(RAW_PAGE_LINK)) {
			const [path] = href.slice(RAW_PAGE_LINK.length).split('#');
			const slug = (path as string).replace(/\.md$/, '');
			if (!(path as string).endsWith('.md') || !pages.has(slug)) offending.push(`${key}: ${href}`);
			seen.page += 1;
		} else if (href.startsWith(RAW_ASSET_LINK)) {
			if (!assets.has(href.slice(RAW_ASSET_LINK.length))) offending.push(`${key}: ${href}`);
			seen.asset += 1;
		} else if (href.startsWith('#') || href.startsWith('https://') || href.startsWith('mailto:')) {
			seen.other += 1;
		} else {
			unresolved.push(`${key}: ${href}`);
		}
	};

	const raws = result.objects.filter((object) => object.key.startsWith('raw/'));
	let substitutable = 0;
	for (const object of raws) {
		const text = gunzipMember(object.bytes).toString('utf8');
		substitutable +=
			text.split(`](${RAW_PAGE_LINK}`).length - 1 + text.split(`](${RAW_ASSET_LINK}`).length - 1;
		parseDocument(text, {
			file: 'content/en/raw.md',
			config: result.project.config as DocsProjectConfig,
			services: {
				highlight,
				resolveLink: (href) => {
					check(object.key, href);
					return { ok: true, link: { type: 'link', kind: 'external', href: 'https://x' } };
				},
				resolveImage: (src) => {
					check(object.key, src);
					return { ok: true, src: 'assets/x.png', width: 1, height: 1 };
				},
				resolveInclude: () => ({ ok: true, blocks: [] }),
			},
		});
	}

	return { offending, unresolved, seen, substitutable, raws: raws.length };
}

/**
 * Every internal link node in every published page payload whose slug has no record.
 *
 * Read out of the gzipped objects rather than out of `result.pages`, because the objects
 * are what a site serves and `result.pages` also holds pages the bundle never publishes.
 * The walk is over the JSON rather than over the AST types, so a link inside a node type
 * added later is still found without anybody teaching this function the new shape.
 */
export function unservedInternalLinks(result: BuildResult): { offending: string[]; seen: number } {
	const pages = new Set(Object.keys(result.manifest.pages));
	const offending: string[] = [];
	let seen = 0;

	const walk = (key: string, value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) walk(key, item);
			return;
		}
		if (value === null || typeof value !== 'object') return;
		const node = value as Record<string, unknown>;
		if (node['type'] === 'link' && node['kind'] === 'internal') {
			seen += 1;
			if (!pages.has(node['slug'] as string)) offending.push(`${key}: ${String(node['slug'])}`);
		}
		for (const child of Object.values(node)) walk(key, child);
	};

	for (const object of result.objects) {
		if (!object.key.startsWith('pages/')) continue;
		walk(object.key, JSON.parse(gunzipMember(object.bytes).toString('utf8')));
	}
	return { offending, seen };
}
