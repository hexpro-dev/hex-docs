/**
 * Resolving what an author wrote into what the renderer reads.
 *
 * Source writes relative markdown paths, because that is what renders on GitHub, where
 * a developer reads the page long before it is published. The AST carries slugs,
 * because the address a slug resolves to depends on the mount point and the locale,
 * neither of which the compiler knows. Baking `/hex-nfc/docs/...` into a bundle would
 * break the moment the same bundle were mounted at a second site, and it would break
 * silently, as a working link to a 404.
 *
 * A link is resolved against the **source locale**, not the linking page's locale. The
 * Arabic reference index links a page nobody has translated, and that link is correct:
 * the page exists in the bundle and the site serves the English fallback with a notice
 * and `noindex`. Resolving against the linking locale would make `graceful` parity's
 * normal state a broken link on every translated page.
 */

import { posix } from 'node:path';

import type { LinkResolution, ImageResolution } from './types.js';

export interface LinkTargets {
	/** Every slug the project publishes, in the wire spelling. */
	slugs: ReadonlySet<string>;
	/** Old slug to current slug, from `redirectFrom`, so a moved page keeps its inbound links. */
	redirects: ReadonlyMap<string, string>;
	/** Site-relative asset path to what the bundle calls it and how big it is. */
	assets: ReadonlyMap<string, { src: string; width: number; height: number }>;
}

/** `content/en/guide/first-tag.md` to `content/en`. */
function localeRootOf(file: string): string {
	return file.split('/').slice(0, 2).join('/');
}

function directoryOf(file: string): string {
	return file.split('/').slice(0, -1).join('/');
}

/**
 * Resolves a relative reference against the file it was written in.
 *
 * Returns `undefined` when it climbs out of `docs/site/`, which is the one thing a
 * relative path can do that a slug cannot express.
 */
function resolveRelative(file: string, href: string): string | undefined {
	const joined = posix.normalize(posix.join(directoryOf(file), href));
	if (joined.startsWith('..') || joined.startsWith('/')) return undefined;
	return joined;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function createLinkResolver(
	file: string,
	targets: LinkTargets,
): (href: string, title: string | undefined) => LinkResolution {
	const localeRoot = localeRootOf(file);

	return (href, title) => {
		const withTitle = title === undefined ? {} : { title };

		if (href.startsWith('#')) {
			const anchor = href.slice(1);
			if (anchor === '') {
				return {
					ok: false,
					message: 'A link to "#" points at nothing.',
					remediation: 'Give it a heading id, or make it ordinary text.',
				};
			}
			return { ok: true, link: { type: 'link', kind: 'anchor', anchor, ...withTitle } };
		}

		if (href.startsWith('mailto:')) {
			const address = href.slice('mailto:'.length);
			if (!address.includes('@')) {
				return {
					ok: false,
					message: `"${href}" is not an email address.`,
					remediation: 'Write mailto: followed by an address.',
				};
			}
			return { ok: true, link: { type: 'link', kind: 'mailto', address, ...withTitle } };
		}

		if (href.startsWith('https://')) {
			return { ok: true, link: { type: 'link', kind: 'external', href, ...withTitle } };
		}

		if (href.startsWith('http://')) {
			return {
				ok: false,
				message: `"${href}" is plain http.`,
				remediation:
					'Use https. The renderer has no http kind, matching the safeHref already shipping in hex-web, and a mixed-content link on a documentation page is a link a browser will not follow.',
			};
		}

		if (SCHEME.test(href)) {
			return {
				ok: false,
				message: `"${href.slice(0, href.indexOf(':'))}:" is not a scheme this package links to.`,
				remediation: 'Links are site-relative, https or mailto. Nothing else reaches the renderer.',
			};
		}

		const [path, anchor] = splitFragment(href);
		if (path === '') {
			// Reachable for one href and one only: the empty string, which is `[text]()`.
			// Anything beginning with `#` was answered by the anchor branch above, so a
			// message about a fragment would name the one case that cannot get here and
			// leave the case that can with no explanation.
			return {
				ok: false,
				message: 'A link with no destination.',
				remediation:
					'Write the path to a markdown page, or "#anchor" for a link within this page. An unfinished link is better left as ordinary text than as a control that goes nowhere.',
			};
		}

		const resolved = resolveRelative(file, path);
		if (resolved === undefined) {
			return {
				ok: false,
				message: `"${href}" climbs out of the publishable root.`,
				remediation: 'Everything a page links to lives under docs/site/.',
			};
		}
		if (!path.endsWith('.md')) {
			return {
				ok: false,
				message: `"${href}" does not point at a markdown page.`,
				remediation:
					'A link points at a page. An image is written with the image syntax, and there is nothing else in a bundle to link to.',
			};
		}
		if (!resolved.startsWith(`${localeRoot}/`)) {
			return {
				ok: false,
				message: `"${href}" points outside "${localeRoot}/".`,
				remediation:
					'Link the page in this locale. A link is a slug, and the site resolves it against the language of the reader and falls back on its own.',
			};
		}

		const slug = resolved.slice(localeRoot.length + 1).replace(/\.md$/, '');
		const target = targets.slugs.has(slug) ? slug : targets.redirects.get(slug);
		if (target === undefined) {
			return {
				ok: false,
				message: `"${href}" resolves to the slug "${slug}", which no page in this project has.`,
				remediation:
					'Check the path, or run hexdocs mv if the page moved: it rewrites inbound links and adds the redirect.',
			};
		}

		return {
			ok: true,
			link: {
				type: 'link',
				kind: 'internal',
				slug: target,
				...(anchor === undefined ? {} : { anchor }),
				...withTitle,
			},
		};
	};
}

function splitFragment(href: string): [string, string | undefined] {
	const hash = href.indexOf('#');
	if (hash === -1) return [href, undefined];
	return [href.slice(0, hash), href.slice(hash + 1)];
}

export function createImageResolver(
	file: string,
	targets: LinkTargets,
): (src: string) => ImageResolution {
	return (src) => {
		if (SCHEME.test(src) || src.startsWith('//')) {
			return {
				ok: false,
				message: `"${src}" is an external image.`,
				remediation:
					'Commit the image under docs/site/assets/ and reference it by relative path. Everything the browser fetches is a static file from the origin of the consuming site, which is what the build-time prefetch exists to guarantee.',
			};
		}
		const resolved = resolveRelative(file, src);
		if (resolved === undefined) {
			return {
				ok: false,
				message: `"${src}" climbs out of the publishable root.`,
				remediation: 'Assets live under docs/site/assets/.',
			};
		}
		const asset = targets.assets.get(resolved);
		if (asset === undefined) {
			return {
				ok: false,
				message: `"${src}" resolves to "${resolved}", which is not an asset in this project.`,
				remediation:
					'Check the path. An asset that failed to publish, because of its colour space or because it is an unsafe SVG, is also absent here and reports its own finding.',
			};
		}
		return { ok: true, src: asset.src, width: asset.width, height: asset.height };
	};
}
