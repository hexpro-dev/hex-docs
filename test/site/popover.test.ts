/**
 * Where a `:more` preview lands, given the mark, the preview and the viewport.
 *
 * The reasons for each rule are on `placePopover`. These cases are the edges a table
 * actually reaches: the last cell of a wide table, a mark near the foot of the window,
 * and an Arabic page, where the preview starts at the mark's right-hand edge.
 */

import { describe, expect, test } from 'vitest';

import { POPOVER_GAP, POPOVER_MARGIN, placePopover } from '../../src/site/popover.js';

const VIEWPORT = { width: 1280, height: 800 };
const SIZE = { width: 300, height: 120 };
const mark = (left: number, top: number) => ({ left, top, right: left + 16, bottom: top + 16 });

describe('placePopover', () => {
	test('below the mark, starting at its left edge, when there is room', () => {
		expect(placePopover(mark(100, 200), SIZE, VIEWPORT, 'ltr')).toEqual({
			top: 216 + POPOVER_GAP,
			left: 100,
			side: 'below',
			maxHeight: VIEWPORT.height - POPOVER_MARGIN - (216 + POPOVER_GAP),
		});
	});

	test('starting at its right edge in a right-to-left page', () => {
		const placed = placePopover(mark(600, 200), SIZE, VIEWPORT, 'rtl');
		expect(placed.left + SIZE.width).toBe(616);
	});

	test('above the mark when only that fits', () => {
		const placed = placePopover(mark(100, 720), SIZE, VIEWPORT, 'ltr');
		expect(placed.side).toBe('above');
		expect(placed.top + SIZE.height).toBe(720 - POPOVER_GAP);
		expect(placed.maxHeight).toBeGreaterThanOrEqual(SIZE.height);
	});

	test('on the roomier side, capped to fit, when neither fits', () => {
		const tall = { width: 300, height: 700 };
		const high = placePopover(mark(100, 150), tall, VIEWPORT, 'ltr');
		expect(high.side).toBe('below');
		expect(high.top + high.maxHeight).toBe(VIEWPORT.height - POPOVER_MARGIN);

		const low = placePopover(mark(100, 600), tall, VIEWPORT, 'ltr');
		expect(low.side).toBe('above');
		expect(low.top).toBe(POPOVER_MARGIN);
		expect(low.top + low.maxHeight).toBe(600 - POPOVER_GAP);
	});

	test('clamped inside the margins at both edges, in both directions', () => {
		// The last cell of a wide table: anchored at the mark, it would run off the right.
		const right = placePopover(mark(1200, 200), SIZE, VIEWPORT, 'ltr');
		expect(right.left + SIZE.width).toBe(VIEWPORT.width - POPOVER_MARGIN);
		// The first cell of an Arabic table, anchored at the mark's right edge, would run off
		// the left.
		const left = placePopover(mark(20, 200), SIZE, VIEWPORT, 'rtl');
		expect(left.left).toBe(POPOVER_MARGIN);
	});

	test('never a negative height, which a browser would read as no cap at all', () => {
		const placed = placePopover(
			{ top: 10, bottom: 26, left: 10, right: 26 },
			{ width: 100, height: 50 },
			{ width: 360, height: 20 },
			'ltr',
		);
		expect(placed.maxHeight).toBe(0);
	});

	test('wider than the viewport keeps its start on screen', () => {
		const placed = placePopover(
			mark(10, 10),
			{ width: 400, height: 100 },
			{ width: 360, height: 640 },
			'ltr',
		);
		expect(placed.left).toBe(POPOVER_MARGIN);
	});
});
