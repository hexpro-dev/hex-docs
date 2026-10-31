/**
 * Where the `:more` preview goes, as arithmetic on rectangles and nothing else.
 *
 * The preview is a top-layer popover. That is what lets it escape the two things that
 * would otherwise clip or bury it: every table sits in `.hx-scroll`, whose `overflow-x:
 * auto` makes both axes clip, and the layout is a `z-index: 1` stacking context that a
 * host's sticky header paints over. The price of the top layer is that nothing positions
 * the element for it. CSS anchor positioning would, and is not yet in every engine this
 * package's readers use, so the position is computed here and written as two lengths.
 *
 * A pure function of the rectangles, so the placement is testable without a browser: the
 * side it flips to, the clamp at each edge, and the right-to-left alignment are each one
 * assertion against numbers rather than a screenshot.
 */

/** The parts of a `DOMRect` the placement reads. Viewport coordinates, in CSS pixels. */
export interface PopoverRect {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export interface PopoverSize {
	width: number;
	height: number;
}

export interface PopoverPlacement {
	/** Viewport coordinates of the popover's top-left corner, for `position: fixed`. */
	top: number;
	left: number;
	side: 'below' | 'above';
	/**
	 * The tallest the popover may be from that corner without leaving the viewport. The
	 * popover scrolls past it, so a long passage near the foot of a short window is still
	 * readable to its end rather than cut off at the screen's edge.
	 */
	maxHeight: number;
}

/** Space between the question mark and the popover. */
export const POPOVER_GAP = 6;

/** The closest the popover comes to any edge of the viewport. */
export const POPOVER_MARGIN = 8;

/**
 * The popover's corner, given the question mark's rectangle, the popover's size, the
 * viewport and the direction the text around the mark runs.
 *
 * Below the mark when it fits, above it when only that fits, and otherwise on whichever
 * side has more room, with `maxHeight` saying how much of it fits there. The popover
 * scrolls beyond that, which is what keeps the last case readable.
 *
 * It starts at the mark's inline start, which is its left edge in a left-to-right page and
 * its right edge in a right-to-left one, so the text it shows begins where the reader's
 * eye already is. Then it is clamped inside the margins, because a mark in the last cell
 * of a wide table is the common case and is exactly where a popover anchored at the mark
 * would run off the screen.
 */
export function placePopover(
	anchor: PopoverRect,
	size: PopoverSize,
	viewport: PopoverSize,
	direction: 'ltr' | 'rtl',
): PopoverPlacement {
	const below = anchor.bottom + POPOVER_GAP;
	const above = anchor.top - POPOVER_GAP - size.height;
	const fitsBelow = below + size.height <= viewport.height - POPOVER_MARGIN;
	const fitsAbove = above >= POPOVER_MARGIN;
	const roomBelow = viewport.height - anchor.bottom;
	const roomAbove = anchor.top;
	const side: PopoverPlacement['side'] =
		fitsBelow || (!fitsAbove && roomBelow >= roomAbove) ? 'below' : 'above';
	const top = side === 'below' ? below : Math.max(POPOVER_MARGIN, above);
	const maxHeight =
		side === 'below'
			? viewport.height - POPOVER_MARGIN - below
			: anchor.top - POPOVER_GAP - POPOVER_MARGIN;

	const start = direction === 'rtl' ? anchor.right - size.width : anchor.left;
	const furthest = viewport.width - POPOVER_MARGIN - size.width;
	const left = Math.max(POPOVER_MARGIN, Math.min(start, furthest));

	return { top, left, side, maxHeight: Math.max(0, maxHeight) };
}
