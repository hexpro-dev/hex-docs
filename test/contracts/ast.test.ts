import { afterEach, describe, expect, test, vi } from 'vitest';

import {
	assertNever,
	AST_NODE_TYPES,
	AST_VERSION,
	BLOCK_TYPES,
	CALLOUT_KINDS,
	CHILD_TYPES,
	CODE_SCOPES,
	HEADING_ID_SOURCES,
	INLINE_TYPES,
	resetUnhandledNodeWarnings,
	STATUS_VALUES,
	unhandledNode,
} from '../../src/contracts/ast.js';

afterEach(() => {
	resetUnhandledNodeWarnings();
	vi.restoreAllMocks();
});

describe('the node inventory', () => {
	test('the three arrays partition the whole set with no overlap', () => {
		expect(AST_NODE_TYPES.length).toBe(
			BLOCK_TYPES.length + INLINE_TYPES.length + CHILD_TYPES.length,
		);
		expect(new Set(AST_NODE_TYPES).size).toBe(AST_NODE_TYPES.length);
	});

	test('block and inline stay disjoint, so the renderer has two exhaustive switches', () => {
		const inline = new Set<string>(INLINE_TYPES);
		for (const type of BLOCK_TYPES) expect(inline.has(type)).toBe(false);
	});

	test('the count is what the plan budgeted: about twenty', () => {
		// A guard on scope rather than on correctness. If this number climbs, someone
		// added renderer surface, a golden fixture and a forward-compatibility entry,
		// and the deferral reasoning at the top of ast.ts is worth re-reading first.
		expect(AST_NODE_TYPES.length).toBeLessThanOrEqual(24);
		expect(AST_NODE_TYPES.length).toBeGreaterThanOrEqual(18);
	});

	test('deferred node types are genuinely absent, not merely undocumented', () => {
		// Each of these was considered and left out of ast-1. Re-adding one bumps
		// AST_VERSION, so it should not happen by accident.
		for (const deferred of [
			'mathBlock',
			'mathInline',
			'diagram',
			'details',
			'footnoteReference',
			'html',
		]) {
			expect(AST_NODE_TYPES as readonly string[]).not.toContain(deferred);
		}
	});

	test('there is no html node, which is what makes the no-raw-markup rule structural', () => {
		expect(AST_NODE_TYPES as readonly string[]).not.toContain('html');
	});
});

describe('the vocabularies', () => {
	test('callout kinds are GitHub’s five, so source renders correctly on the page an author reads it on', () => {
		expect([...CALLOUT_KINDS]).toEqual(['note', 'tip', 'important', 'warning', 'caution']);
	});

	test('code scopes are names rather than colours, so a bundle can be restyled without recompiling', () => {
		expect(CODE_SCOPES.length).toBeGreaterThan(10);
		for (const scope of CODE_SCOPES) expect(scope).toMatch(/^[a-z]+$/);
		expect(new Set(CODE_SCOPES).size).toBe(CODE_SCOPES.length);
	});

	test('heading ids can be derived three ways, because two are already in production', () => {
		expect([...HEADING_ID_SOURCES]).toEqual(['slug', 'explicit', 'section-number']);
	});

	test('status values cover the four states a support matrix cell can be in', () => {
		expect([...STATUS_VALUES]).toEqual(['yes', 'partial', 'no', 'na']);
	});
});

describe('the two default branches', () => {
	test('assertNever throws, because the compiler controls its own input', () => {
		expect(() => assertNever({ type: 'invented' } as never, 'compileBlock')).toThrowError(
			/compileBlock: unhandled node "invented"/,
		);
	});

	test('unhandledNode does not throw, because the renderer does not control its input', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(unhandledNode({ type: 'fromTheFuture' }, 'renderBlock')).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain('fromTheFuture');
		expect(warn.mock.calls[0]?.[0]).toContain(String(AST_VERSION));
	});

	test('unhandledNode warns once per node type, not once per node', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		for (let i = 0; i < 50; i += 1) unhandledNode({ type: 'same' }, 'renderBlock');
		unhandledNode({ type: 'other' }, 'renderBlock');
		expect(warn).toHaveBeenCalledTimes(2);
	});

	test('unhandledNode survives a node with no type at all', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(unhandledNode({}, 'renderInline')).toBeNull();
		expect(warn.mock.calls[0]?.[0]).toContain('(no type)');
	});
});
