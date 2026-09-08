import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
	AST_NODE_TYPES,
	BLOCK_TYPES,
	INLINE_TYPES,
	resetUnhandledNodeWarnings,
	type Block,
	type Inline,
} from '../../src/contracts/ast.js';
import { NO_EMIT } from '../../src/render/context.js';
import { PlainLink, isChildOnly, renderBlocks, renderInline } from '../../src/render/nodes.js';

const context = {
	locale: 'en' as const,
	contentLocale: 'en' as const,
	address: { basePath: '/fixture-app/docs', locale: 'en' as const },
	bundleBase: '/_docs/fixture-app/1.1.0',
	Link: PlainLink,
	emit: NO_EMIT,
};

const blocks = (nodes: Block[]): string =>
	renderToStaticMarkup(<>{renderBlocks(nodes, context)}</>);
const inline = (nodes: Inline[]): string =>
	renderToStaticMarkup(<>{renderInline(nodes, context)}</>);

describe('a node type this runtime does not know', () => {
	beforeEach(() => {
		resetUnhandledNodeWarnings();
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetUnhandledNodeWarnings();
	});

	test('renders nothing rather than taking the page down', () => {
		// `ast.ts` says which default branch goes where and why: the compiler throws because
		// it controls its own input, and the renderer does not because it is handed a bundle
		// somebody else compiled. Losing a paragraph is a better outcome than a 500 on a
		// whole page, and `docsRoute` is the guard that should have caught it first.
		const unknown = { type: 'mermaid', diagram: 'graph TD' } as unknown as Block;
		expect(blocks([unknown])).toBe('');
		expect(inline([unknown as unknown as Inline])).toBe('');
	});

	test('says so once per node type, not once per node', () => {
		const warn = vi.spyOn(console, 'warn');
		const unknown = { type: 'footnote' } as unknown as Block;
		blocks([unknown, unknown, unknown]);
		expect(warn.mock.calls.length).toBe(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain('footnote');
	});

	test('an unknown link kind is skipped the same way', () => {
		// The third switch. It is exhaustive over four kinds today and a fifth would arrive
		// the same way a node type would: in a bundle a newer toolchain wrote.
		const link = { type: 'link', kind: 'ftp', href: 'x', children: [] } as unknown as Inline;
		expect(inline([link])).toBe('');
	});

	test('the warning is what makes an unknown node visible at all', () => {
		// It warns in production too, and `ast.ts` says why: an unknown node there is a real
		// misconfiguration somebody should see. The one thing this cannot do is be seen on a
		// long-lived server, where once per process is once per deploy. That is a stated
		// limitation of the mechanism and the reason the refusal lives in `docsRoute`.
		const warn = vi.spyOn(console, 'warn');
		blocks([{ type: 'ast-2-node' } as unknown as Block]);
		expect(String(warn.mock.calls[0]?.[0])).toContain('[hex-docs]');
	});
});

describe('the three child-only node types', () => {
	test('are unreachable from either switch', () => {
		// `ast.ts` keeps `listItem`, `tableCell` and `step` out of `Block` and `Inline` so
		// the two switches stay exhaustive, and pins the unions disjoint at compile time.
		// This is the runtime half of that: a bare one renders nothing rather than landing
		// somewhere it does not belong.
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		for (const type of ['listItem', 'tableCell', 'step']) {
			expect(isChildOnly(type)).toBe(true);
			expect(blocks([{ type, children: [] } as unknown as Block])).toBe('');
		}
		resetUnhandledNodeWarnings();
		vi.restoreAllMocks();
	});

	test('and every type that is not one of them is not claimed as one', () => {
		// Both directions, so the predicate cannot quietly widen.
		const claimed = AST_NODE_TYPES.filter(isChildOnly);
		expect([...claimed].sort()).toEqual(['listItem', 'step', 'tableCell']);
		for (const type of [...BLOCK_TYPES, ...INLINE_TYPES]) expect(isChildOnly(type)).toBe(false);
	});
});

describe('links', () => {
	test('an internal link becomes an address built by the address rules', () => {
		const html = inline([
			{
				type: 'link',
				kind: 'internal',
				slug: 'guide/index',
				children: [{ type: 'text', value: 'g' }],
			},
		]);
		expect(html).toBe('<a href="/fixture-app/docs/guide/">g</a>');
	});

	test('an internal link with an anchor keeps it', () => {
		const html = inline([
			{
				type: 'link',
				kind: 'internal',
				slug: 'guide/first-tag',
				anchor: 'before-you-start',
				children: [{ type: 'text', value: 'g' }],
			},
		]);
		expect(html).toContain('href="/fixture-app/docs/guide/first-tag#before-you-start"');
	});

	test('an anchor link is a plain fragment, not a client-side navigation', () => {
		// A router link to a hash on the current page is a navigation: it resets scroll and
		// pushes a history entry for a jump the browser already does natively.
		expect(inline([{ type: 'link', kind: 'anchor', anchor: 'x', children: [] }])).toBe(
			'<a href="#x"></a>',
		);
	});

	test('an external link carries the rel the contract commits to, and says it leaves', () => {
		const html = inline([
			{
				type: 'link',
				kind: 'external',
				href: 'https://example.com',
				children: [{ type: 'text', value: 'e' }],
			},
		]);
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain('target="_blank"');
		// An icon alone is a fact only a sighted reader gets, and `target="_blank"` with no
		// warning at all is the WCAG 3.2.5 failure.
		expect(html).toContain('Opens in a new window');
	});

	test('a mailto link gets its scheme back', () => {
		expect(inline([{ type: 'link', kind: 'mailto', address: 'a@b.c', children: [] }])).toBe(
			'<a href="mailto:a@b.c"></a>',
		);
	});

	test('a title survives on every kind that can carry one', () => {
		for (const node of [
			{ type: 'link', kind: 'internal', slug: 'index', title: 't', children: [] },
			{ type: 'link', kind: 'anchor', anchor: 'x', title: 't', children: [] },
			{ type: 'link', kind: 'external', href: 'https://e.com', title: 't', children: [] },
			{ type: 'link', kind: 'mailto', address: 'a@b.c', title: 't', children: [] },
		] as Inline[]) {
			expect(inline([node])).toContain('title="t"');
		}
	});
});

describe('a structurally degenerate payload', () => {
	/**
	 * None of these is in the corpus and all of them are reachable.
	 *
	 * The renderer is handed bundles a newer toolchain compiled, and the contract's promise
	 * is that a node it can display badly it displays badly rather than throwing. A row
	 * wider than `align` reads past the end of that array, which `noUncheckedIndexedAccess`
	 * turns into `undefined` rather than a crash, and an empty container is an empty
	 * element rather than a missing one.
	 */
	test('a table row wider than its alignment array', () => {
		const html = blocks([
			{
				type: 'table',
				align: ['left'],
				header: [{ type: 'tableCell', children: [{ type: 'text', value: 'h' }] }],
				rows: [
					[
						{ type: 'tableCell', children: [{ type: 'text', value: 'a' }] },
						{ type: 'tableCell', children: [{ type: 'text', value: 'b' }] },
					],
				],
			},
		]);
		expect(html).toContain('>b</td>');
		expect(html).toContain('style="text-align:left"');
	});

	test('a null alignment leaves the column to the reader own direction', () => {
		const html = blocks([
			{ type: 'table', align: [null], header: [{ type: 'tableCell', children: [] }], rows: [] },
		]);
		expect(html).not.toContain('text-align');
	});

	test('an empty list, an empty callout and an empty procedure', () => {
		expect(blocks([{ type: 'list', style: 'bullet', tight: true, children: [] }])).toContain('<ul');
		expect(blocks([{ type: 'callout', kind: 'note', children: [] }])).toContain('Note');
		expect(blocks([{ type: 'steps', children: [] }])).toContain('<ol class="hx-steps">');
	});

	test('a task list item is a named mark rather than a disabled control', () => {
		// A disabled checkbox is announced as disabled and is not focusable, which tells the
		// reader they are being denied something rather than that a step is done.
		const done = blocks([
			{
				type: 'list',
				style: 'bullet',
				tight: true,
				children: [{ type: 'listItem', checked: true, children: [] }],
			},
		]);
		expect(done).toContain('aria-label="Done"');
		expect(done).not.toContain('<input');
	});
});
