import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import type { Block, Code } from '../../src/contracts/ast.js';
import { CODE_SCOPES } from '../../src/contracts/ast.js';
import { SCOPE_COLOUR, scopeClass } from '../../src/contracts/palette.js';
import { NO_EMIT } from '../../src/render/context.js';
import { PlainLink, renderBlocks } from '../../src/render/nodes.js';
import { goldenPage } from '../support/golden.js';

const context = {
	locale: 'en' as const,
	contentLocale: 'en' as const,
	address: { basePath: '/fixture-app/docs', locale: 'en' as const },
	bundleBase: '/_docs/fixture-app/1.1.0',
	Link: PlainLink,
	emit: NO_EMIT,
};

const render = (blocks: Block[]): string =>
	renderToStaticMarkup(<>{renderBlocks(blocks, context)}</>);

/** The fences the corpus actually carries, found rather than hand-built. */
function fencesOf(locale: 'en', slug: string): Code[] {
	const found: Code[] = [];
	const walk = (nodes: readonly Block[]): void => {
		for (const node of nodes) {
			if (node.type === 'code') found.push(node);
			else if (node.type === 'blockquote' || node.type === 'callout') walk(node.children);
			else if (node.type === 'list') for (const item of node.children) walk(item.children);
			else if (node.type === 'steps') for (const step of node.children) walk(step.children);
		}
	};
	walk(goldenPage(locale, slug).page.body);
	return found;
}

/** The zero-based indices of the lines the renderer marked. */
function markedIndices(html: string): number[] {
	const lines = [...html.matchAll(/<span class="hx-line"([^>]*)>/g)];
	return lines.flatMap((match, index) => (match[1]?.includes('data-marked="true"') ? [index] : []));
}

describe('the highlight coordinate system', () => {
	/**
	 * The one thing about this node that has been read both ways, pinned by name.
	 *
	 * `ast.ts` says "1-based line numbers to mark, relative to `startLine`". Three of the
	 * four independent designs for this renderer read that as "add `startLine` to the
	 * numbers", which marks nothing at all on either of the corpus's two highlighted
	 * fences and renders as a perfectly ordinary code block. The numbers index the excerpt.
	 */
	test('reference/api marks the guard clause and the three-line constructor call', () => {
		const fence = fencesOf('en', 'reference/api').find((code) => code.highlight !== undefined);
		expect(fence).toBeDefined();
		// The declared inputs, asserted so a corpus edit that changed them fails here
		// rather than quietly changing what this test is about.
		expect(fence?.startLine).toBe(12);
		expect(fence?.highlight).toEqual([2, 5, 6, 7]);
		expect(fence?.lines.length).toBe(10);

		expect(markedIndices(render([fence as Code]))).toEqual([1, 4, 5, 6]);
	});

	test('developer/architecture marks the throw and the alert message', () => {
		const fence = fencesOf('en', 'developer/architecture').find(
			(code) => code.highlight !== undefined,
		);
		expect(fence).toBeDefined();
		expect(fence?.startLine).toBe(48);
		expect(fence?.highlight).toEqual([3, 9]);
		expect(fence?.lines.length).toBe(12);

		expect(markedIndices(render([fence as Code]))).toEqual([2, 8]);
	});

	test('the printed number is startLine plus the index, which is the other coordinate', () => {
		const fence = fencesOf('en', 'reference/api').find((code) => code.highlight !== undefined);
		const html = render([fence as Code]);
		const numbers = [...html.matchAll(/hx-line-number" aria-hidden="true">(\d+)</g)].map((match) =>
			Number(match[1]),
		);
		expect(numbers).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
	});

	test('a fence with no startLine numbers from one and marks the same way', () => {
		const fence: Code = {
			type: 'code',
			highlighted: false,
			showLineNumbers: true,
			highlight: [1, 3],
			lines: [
				{ tokens: [{ text: 'a' }] },
				{ tokens: [{ text: 'b' }] },
				{ tokens: [{ text: 'c' }] },
			],
		};
		expect(markedIndices(render([fence]))).toEqual([0, 2]);
		expect(render([fence])).toContain('>1</span>');
	});
});

describe('the fence', () => {
	test('is a keyboard-reachable scroll region with a translated name', () => {
		// All three, because each alone is worse than the last: without the tab stop a
		// keyboard reader cannot scroll a wide block at all, and with a tab stop and no
		// name it is an unlabelled stop.
		const fence = fencesOf('en', 'reference/api')[0] as Code;
		const html = render([fence]);
		expect(html).toContain('tabindex="0"');
		expect(html).toContain('role="group"');
		expect(html).toMatch(/aria-label="[^"]+"/);
	});

	test('names the language in the region label when the fence declares one', () => {
		const fence = fencesOf('en', 'reference/api')[0] as Code;
		expect(fence.langLabel).toBeDefined();
		expect(render([fence])).toContain(`aria-label="${fence.langLabel as string} code block"`);
	});

	test('the visible language chip is hidden from assistive technology', () => {
		// It says the same word as the region label. Without this a screen reader reads the
		// language twice on every block, which on a reference page is most of the page.
		const fence = fencesOf('en', 'reference/api')[0] as Code;
		const html = render([fence]);
		expect(html).toMatch(/class="hx-fence-lang" aria-hidden="true"/);
	});

	test('carries a copy button even when the fence has no language and no filename', () => {
		// The unlabelled fences in this corpus are the box-drawing diagram and the
		// directory tree, which are exactly the blocks a reader most wants to copy.
		const plain: Code = {
			type: 'code',
			highlighted: false,
			showLineNumbers: false,
			lines: [{ tokens: [{ text: 'x' }] }],
		};
		const html = render([plain]);
		expect(html).toContain('class="hx-copy"');
		expect(html).toContain('disabled=""');
	});

	test('the copy button is disabled in the markup the server sends', () => {
		// A button announced as a button that does nothing because the script never ran is
		// worse than no button. It is enabled by an effect on hydration.
		const fence = fencesOf('en', 'reference/api')[0] as Code;
		expect(render([fence])).toMatch(/class="hx-copy" disabled=""/);
	});

	test('is laid out left to right whatever the page around it is', () => {
		const fence = fencesOf('en', 'reference/api')[0] as Code;
		expect(render([fence])).toContain('dir="ltr"');
	});

	test('wraps only when the fence asks to', () => {
		const base: Code = {
			type: 'code',
			highlighted: false,
			showLineNumbers: false,
			lines: [{ tokens: [{ text: 'x' }] }],
		};
		expect(render([base])).toContain('class="hx-pre"');
		expect(render([{ ...base, wrap: true }])).toContain('class="hx-pre hx-wrap"');
	});
});

describe('the diff gutter', () => {
	test('marks an inserted and a deleted line with a character as well as a colour', () => {
		// The two diff colours measure 1.29:1 against each other, so colour alone tells a
		// reader who cannot separate the hues nothing at all.
		const diff: Code = {
			type: 'code',
			lang: 'diff',
			highlighted: true,
			showLineNumbers: false,
			lines: [
				{ tokens: [{ text: '+ added', scope: 'inserted' }] },
				{ tokens: [{ text: '- gone', scope: 'deleted' }] },
				{ tokens: [{ text: '  same' }] },
			],
		};
		const html = render([diff]);
		expect(html).toContain('data-diff="inserted"');
		expect(html).toContain('data-diff="deleted"');
		expect([...html.matchAll(/class="hx-line-diff"/g)].length).toBe(2);
	});

	test('an ordinary line gets no gutter, so the marker means something', () => {
		const plain: Code = {
			type: 'code',
			highlighted: true,
			showLineNumbers: false,
			lines: [{ tokens: [{ text: 'x', scope: 'keyword' }] }],
		};
		expect(render([plain])).not.toContain('hx-line-diff');
	});
});

describe('scope classes', () => {
	test('every scope the palette maps renders as its own class', () => {
		// The class is named after the scope and not after the colour, so three scopes
		// sharing `code-ink` are still distinguishable in the markup and a claim in the
		// render suite can tell a regexp span from a string one.
		const fence: Code = {
			type: 'code',
			highlighted: true,
			showLineNumbers: false,
			lines: [{ tokens: CODE_SCOPES.map((scope) => ({ text: scope, scope })) }],
		};
		const html = render([fence]);
		for (const scope of CODE_SCOPES) expect(html).toContain(`class="${scopeClass(scope)}"`);
		expect([...html.matchAll(/class="hx-s-/g)].length).toBe(CODE_SCOPES.length);
		expect(Object.keys(SCOPE_COLOUR).length).toBe(CODE_SCOPES.length);
	});

	test('an unscoped token is bare text, not an empty span', () => {
		const fence: Code = {
			type: 'code',
			highlighted: false,
			showLineNumbers: false,
			lines: [{ tokens: [{ text: 'plain' }] }],
		};
		expect(render([fence])).not.toContain('hx-s-');
	});
});
