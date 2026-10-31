/**
 * `:more[...]`: supporting detail behind a circled question mark.
 *
 * Three states, and the one a reader gets depends on what their browser can do rather
 * than on what this file assumes.
 *
 * - **No script.** The server's markup has the text inline and the mark disabled, and
 *   `@media (scripting: none)` hides the mark and shows the text. A reader with JavaScript
 *   off reads the cell as it was written, which is the only state in which nobody can be
 *   locked out of the words. Print does the same.
 * - **Script, folded.** The mark is a button. A resting mouse or a keyboard arriving on it
 *   shows the text as a top-layer popover (`usePreview` says why the top layer); a click,
 *   a tap or Enter replaces the mark with the text, inline, where the cell can grow to fit
 *   it, and moves focus to it, because the control the reader was on no longer exists.
 * - **Revealed.** Stays revealed for the rest of the page view. There is deliberately no way
 *   to fold it back: the owner chose one-way, and a second control in every revealed cell
 *   would be the clutter the fold exists to remove.
 *
 * Revealed is keyed to the node object rather than held as a flag, so it cannot leak into
 * another page. React reuses a component at the same position in the next page's tree, and a
 * flag would open the `:more` that happened to sit where the last one was. A navigation
 * brings a new payload, the payload brings new nodes, and a `:more` whose node is not the
 * one that was revealed is folded.
 *
 * The button has no text and no `aria-expanded`. Its glyph is drawn by the stylesheet, so
 * its name is its `aria-label`, which is why it carries `interfaceLang` and not
 * `interfaceMark` (the status mark beside it in the same cell says why). And there is no
 * expanded state to announce, because activating it removes it; what the reader hears next
 * is the text itself, from the focus move.
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

import type { More as MoreNode } from '../contracts/ast.js';
import { interfaceLang } from '../site/direction.js';
import { uiString } from '../ui/strings.js';
import { useHydrated, usePreview } from './client.js';
import type { RenderContext } from './context.js';

export interface MoreProps {
	/** The node, for its identity. See the module comment. */
	node: MoreNode;
	/** Its children, already rendered by the inline switch, which this file does not import. */
	children: ReactNode;
	context: RenderContext;
}

export function More(props: MoreProps): ReactElement {
	const { node, context } = props;
	const hydrated = useHydrated();
	const [revealed, setRevealed] = useState<MoreNode | null>(null);
	const open = revealed === node;
	const mark = useRef<HTMLButtonElement>(null);
	const body = useRef<HTMLSpanElement>(null);
	const preview = usePreview(mark, body, hydrated && !open);

	useEffect(() => {
		if (open) body.current?.focus({ preventScroll: true });
	}, [open]);

	if (open) {
		return (
			<span className="hx-more" data-open="">
				<span ref={body} className="hx-more-body" tabIndex={-1}>
					{props.children}
				</span>
			</span>
		);
	}

	return (
		<span
			className="hx-more"
			// Set once the script runs, and what shows the mark and folds the text in an engine
			// that has the Popover API and not the `scripting` media query. Without it the
			// stylesheet's script-only rules never match there, the user agent hides the text
			// as a closed popover, and the mark stays hidden: the note is unreachable.
			data-ready={hydrated ? '' : undefined}
			onPointerEnter={preview.onPointerEnter}
			onPointerLeave={preview.onPointerLeave}
			onFocus={preview.onFocus}
			onBlur={preview.onBlur}
		>
			<button
				ref={mark}
				type="button"
				className="hx-more-mark"
				aria-label={uiString(context.locale, 'moreShow')}
				{...interfaceLang(context.locale, context.contentLocale)}
				disabled={!hydrated}
				onClick={() => {
					preview.hide();
					setRevealed(node);
				}}
			/>
			{/*
			 * `popover` only once the script is running. In the server's markup it would hide
			 * the text from a reader with no JavaScript behind the user agent's own
			 * `[popover]:not(:popover-open)` rule, which no media query in this package can
			 * reach.
			 */}
			<span ref={body} className="hx-more-body" popover={hydrated ? 'manual' : undefined}>
				{props.children}
			</span>
		</span>
	);
}
