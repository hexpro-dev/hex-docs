import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { scanImports } from '../../scripts/lib/scan-imports.mjs';
import { REPO_ROOT } from '../support/golden.js';

const SRC = join(REPO_ROOT, 'src');

/**
 * Resolve one relative specifier to a file on disk.
 *
 * Specifiers here carry a `.js` extension by house rule, and the file behind them is
 * `.ts` or `.tsx`. A `.css` specifier resolves to itself, which is the whole point: it
 * has to appear in the graph so the assertion below can see it.
 */
function resolveSpecifier(from: string, specifier: string): string | undefined {
	const base = resolve(dirname(from), specifier);
	for (const candidate of [
		base.replace(/\.js$/, '.ts'),
		base.replace(/\.js$/, '.tsx'),
		base,
		`${base}.ts`,
		`${base}.tsx`,
	]) {
		if (existsSync(candidate) && !candidate.endsWith('/')) return candidate;
	}
	return undefined;
}

interface Graph {
	/** Every file reachable from the entry point, repository-relative and sorted. */
	files: string[];
	/** Specifiers that resolved to nothing, so a broken walk is a failure rather than a short list. */
	unresolved: string[];
}

/** Every file reachable from an entry point, following relative imports only. */
function graphFrom(entry: string): Graph {
	const seen = new Set<string>();
	const unresolved: string[] = [];
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		if (!/\.tsx?$/.test(file)) continue;
		const records = scanImports(readFileSync(file, 'utf8')) as { specifier: string }[];
		for (const { specifier } of records) {
			// A computed dynamic import carries no specifier, and there are none in this
			// package: the gate that would catch one is `scripts/check-imports.mjs`, which
			// reads the same records.
			if (typeof specifier !== 'string' || !specifier.startsWith('.')) continue;
			const resolved = resolveSpecifier(file, specifier);
			if (resolved === undefined) {
				unresolved.push(`${relative(REPO_ROOT, file)} imports "${specifier}"`);
				continue;
			}
			queue.push(resolved);
		}
	}
	return { files: [...seen].map((file) => relative(REPO_ROOT, file)).sort(), unresolved };
}

const barrel = graphFrom(join(SRC, 'index.ts'));
const renderer = graphFrom(join(SRC, 'render', 'index.ts'));
const BARREL = barrel.files;
const RENDERER = renderer.files;

describe('the two entry points', () => {
	/**
	 * The barrel has to stay importable from bare node.
	 *
	 * `hex-web` imports this package from places with no bundler at all: its hand-run
	 * `.mjs` guards, its sitemap generation and `hexdocs sync` all run under plain node,
	 * where a `.css` specifier throws before anything else happens. The failure is not a
	 * broken page, it is a build that dies inside a submodule during a deploy, and the
	 * cause is one convenient re-export somebody adds a year from now.
	 */
	test('nothing reachable from src/index.ts imports a stylesheet', () => {
		expect(BARREL.filter((file) => file.endsWith('.css'))).toEqual([]);
	});

	test('nothing reachable from src/index.ts is a component', () => {
		// JSX is the other half of the same property. A `.tsx` file compiles under a
		// consumer's bundler and not under `node --experimental-strip-types`, and it drags
		// `react/jsx-runtime` in with it.
		expect(BARREL.filter((file) => file.endsWith('.tsx'))).toEqual([]);
	});

	test('the walk actually reached the barrel, so the two assertions above mean something', () => {
		// The positive control. Both assertions are satisfied by an empty list, which is
		// what a resolver that silently failed would produce.
		expect(BARREL.length).toBeGreaterThan(15);
		expect(BARREL).toContain('src/index.ts');
		expect(BARREL).toContain('src/site/address.ts');
		expect(BARREL).toContain('src/ui/strings.ts');
	});

	test('the renderer entry point does reach the stylesheet and the components', () => {
		// The other direction, and the reason the split is not simply "no CSS anywhere":
		// the package does ship a stylesheet, and it is imported by the entry point that a
		// bundler compiles rather than by the one node reads.
		expect(RENDERER).toContain('src/render/docs.css');
		expect(RENDERER.filter((file) => file.endsWith('.tsx')).length).toBeGreaterThan(3);
	});

	test('the renderer reaches the barrel modules, so the split costs no duplication', () => {
		// The renderer imports the address rules and the string tables rather than carrying
		// its own copies, which is what makes the two entry points a boundary rather than a
		// fork.
		expect(RENDERER).toContain('src/site/address.ts');
		expect(RENDERER).toContain('src/ui/strings.ts');
	});

	test('every relative import in the package resolves to a file that exists', () => {
		// A specifier that resolves to nothing would silently prune the graph below it, and
		// every assertion above is satisfied by a graph that stopped early.
		expect([...barrel.unresolved, ...renderer.unresolved]).toEqual([]);
		expect(new Set([...BARREL, ...RENDERER]).size).toBeGreaterThan(20);
	});
});
