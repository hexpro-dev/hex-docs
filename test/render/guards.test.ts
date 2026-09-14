/**
 * The structural absence of raw markup, held rather than asserted in a comment.
 *
 * `src/render/nodes.tsx` says there is no `dangerouslySetInnerHTML` anywhere in this package
 * and that the absence is structural: the AST has no `html` node and the compiler refuses raw
 * HTML in source, so no author text can reach markup the renderer did not construct. That is
 * only half a guarantee while a later edit can add the property to one component, so this
 * file is the other half. It reads every TypeScript source under both halves of the package.
 *
 * It looks for the property being set, as a JSX attribute or an object key, and not for the
 * word: the package names it in several comments and one lint message precisely to say it is
 * not used, and a scan that failed on those would push somebody to delete the explanations.
 *
 * The identifier is assembled rather than written out, so this file does not have to be
 * exempted from the rule it enforces, which is the same trick the attribution patterns use.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { describe, expect, test } from 'vitest';

import { REPO_ROOT } from '../support/golden.js';

const RAW_MARKUP = ['dangerously', 'Set', 'Inner', 'HTML'].join('');
/** Set, not mentioned: `name=` in JSX, or `name:` as a key in a props object. */
const SETS_RAW_MARKUP = new RegExp(`\\b${RAW_MARKUP}\\s*[=:]`);

function sources(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === 'node_modules') continue;
		const full = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...sources(full));
		else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
	}
	return found;
}

/** Every file under `roots` that names the property, relative to `base`. */
function rawMarkupIn(roots: readonly string[], base: string): { examined: number; hits: string[] } {
	const files = roots.flatMap((root) => sources(root));
	const hits = files
		.filter((file) => SETS_RAW_MARKUP.test(readFileSync(file, 'utf8')))
		.map((file) => relative(base, file));
	return { examined: files.length, hits };
}

describe('no raw markup anywhere in the package', () => {
	test('no source file under src or kit/src sets inner HTML', () => {
		const { examined, hits } = rawMarkupIn(
			[join(REPO_ROOT, 'src'), join(REPO_ROOT, 'kit', 'src')],
			REPO_ROOT,
		);
		// A scan that read nothing would pass over anything, so the count is held against the
		// renderer's own directory rather than a literal.
		expect(examined).toBeGreaterThan(sources(join(REPO_ROOT, 'src', 'render')).length);
		expect(hits).toEqual([]);
	});

	test('the scan finds the property when a file does set it', () => {
		// The positive control. Without it, a scanner that matched nothing, or read the wrong
		// directory, would satisfy the test above forever.
		const planted = mkdtempSync(join(tmpdir(), 'hexdocs-raw-markup-'));
		try {
			writeFileSync(
				join(planted, 'component.tsx'),
				`export const X = () => <div ${RAW_MARKUP}={{ __html: '<b>x</b>' }} />;\n`,
				'utf8',
			);
			writeFileSync(
				join(planted, 'props.ts'),
				`export const props = { ${RAW_MARKUP}: { __html: '' } };\n`,
				'utf8',
			);
			// Named in prose, which is how the package itself mentions it, and not a hit.
			writeFileSync(
				join(planted, 'clean.tsx'),
				`/** There is no ${RAW_MARKUP} here. */\nexport const Y = () => <div />;\n`,
				'utf8',
			);
			expect(rawMarkupIn([planted], planted)).toEqual({
				examined: 3,
				hits: ['component.tsx', 'props.ts'],
			});
		} finally {
			rmSync(planted, { recursive: true, force: true });
		}
	});
});
