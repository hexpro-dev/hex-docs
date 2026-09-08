/**
 * The compiler's golden output, read by the runtime suite.
 *
 * The renderer is tested against exactly what the compiler emits rather than against
 * hand-written trees, because a hand-written tree is the renderer author's idea of what
 * the compiler produces and the two drift silently: the renderer keeps passing while the
 * pages it is given change shape underneath it. Reading `kit/test/golden/` is what the
 * fixture corpus was built for, one step along.
 *
 * The cost is a dependency from this suite on the other suite's output, and it has a real
 * failure mode: a kit golden regenerated after the render goldens were written makes every
 * render assertion green about yesterday's compiler. That is closed at the render goldens
 * themselves, each of which records the digest of the page file it was produced from, so
 * an update run over stale kit output fails naming the file instead of writing the wrong
 * answer into something that then looks like evidence.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Locale } from '../../src/contracts/locales.js';
import type { BundleManifest } from '../../src/contracts/manifest.js';
import type { CompiledPage } from '../../src/contracts/page.js';

/**
 * The repository root, resolved without assuming this module has a file URL.
 *
 * It does not always. Measured: under the `happy-dom` environment vitest serves modules
 * from `http://localhost:3000/`, so `import.meta.url` is an http URL and `fileURLToPath`
 * refuses it with "The URL must be of scheme file" at import time, before any test runs.
 * Every module that resolves a path from `import.meta.url` is therefore unimportable from
 * a DOM test, which is a thing worth knowing rather than rediscovering. The working
 * directory is the repository root under both environments, and the assertion below is
 * what says so rather than assuming it.
 */
function repoRoot(): string {
	const url = import.meta.url;
	if (url.startsWith('file:')) return resolve(fileURLToPath(new URL('../..', url).href));
	const cwd = process.cwd();
	if (!existsSync(join(cwd, 'kit', 'test', 'golden'))) {
		throw new Error(
			`Cannot find the repository root. import.meta.url is ${url}, which is not a file URL, and ${cwd} does not look like the repository.`,
		);
	}
	return cwd;
}

export const REPO_ROOT = repoRoot();

export const GOLDEN_ROOT = join(REPO_ROOT, 'kit', 'test', 'golden');

export interface GoldenPage {
	locale: Locale;
	slug: string;
	/** Path relative to the repository root, for a failure message somebody can act on. */
	file: string;
	/** sha256 of the file's bytes, which is what a render golden records. */
	digest: string;
	page: CompiledPage;
}

function walk(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...walk(full));
		else if (entry.name.endsWith('.json')) found.push(full);
	}
	return found.sort();
}

/**
 * Every compiled page the compiler goldened, in a stable order.
 *
 * The locale and slug are recovered from the path rather than read out of the payload, so
 * a page filed under the wrong locale is a mismatch this loader can report rather than a
 * fact the suite absorbs. The check itself is in `test/render/golden.test.ts`; keeping the
 * recovery here means one place knows the layout.
 */
export function goldenPages(): GoldenPage[] {
	const root = join(GOLDEN_ROOT, 'pages');
	return walk(root).map((file) => {
		const rest = relative(root, file).split(/[\\/]/);
		const locale = rest[0] as Locale;
		const slug = rest
			.slice(1)
			.join('/')
			.replace(/\.json$/, '');
		const bytes = readFileSync(file);
		return {
			locale,
			slug,
			file: relative(REPO_ROOT, file),
			digest: createHash('sha256').update(bytes).digest('hex'),
			page: JSON.parse(bytes.toString('utf8')) as CompiledPage,
		};
	});
}

export function goldenManifest(): BundleManifest {
	return JSON.parse(readFileSync(join(GOLDEN_ROOT, 'manifest.json'), 'utf8')) as BundleManifest;
}

/** One page, by locale and slug, for a test that names the page it is about. */
export function goldenPage(locale: Locale, slug: string): GoldenPage {
	const found = goldenPages().find((entry) => entry.locale === locale && entry.slug === slug);
	if (found === undefined) {
		throw new Error(
			`No compiled golden for ${locale}/${slug}. The corpus moved, and a test naming a page that no longer exists is a test that stopped covering anything.`,
		);
	}
	return found;
}
