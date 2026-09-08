/**
 * Flattening the tree back to text.
 *
 * Four things need this and none of them can share a walk with the renderer: a table of
 * contents entry, the search index's per-section body, the reading estimate's word
 * count and `llms.txt`. It lives in the runtime half because two of those are compile
 * time and two are not, and a second implementation of "what does this heading say"
 * would eventually disagree with the first about an inline code span.
 *
 * The defaults are the table of contents' defaults, because that is the caller with the
 * strictest requirement: an entry that rendered a link inside a link is invalid HTML
 * and an entry that rendered an image is not an entry. So an image contributes nothing
 * unless a caller asks for its alt text, and a status node contributes nothing unless a
 * caller supplies a label for it.
 */

import {
	unhandledNode,
	type Block,
	type ImageNode,
	type Inline,
	type StatusValue,
} from '../contracts/ast.js';

export interface FlattenOptions {
	/**
	 * What a `status` node contributes.
	 *
	 * Absent means nothing, which is right for a table of contents and wrong for the
	 * search index: `chip-support-matrix.md` carries 86 status glyphs, and a search for
	 * "supported" that matched no row is the failure the `status` node exists to fix. The
	 * label is a localised string and this module has no locale, so the caller passes one.
	 */
	status?: (value: StatusValue) => string;
	/** What an `image` node contributes. Absent means nothing. */
	image?: (node: ImageNode) => string;
	/**
	 * Whether a fenced code block's own text is included.
	 *
	 * The search index says yes: a developer looks for a symbol that appears in a fence
	 * and nowhere else. The reading estimate says no: a 200-line listing is not four
	 * hundred words of reading, and counting it makes every developer page claim to take
	 * twenty minutes.
	 */
	code?: boolean;
}

export function inlineText(nodes: readonly Inline[], options: FlattenOptions = {}): string {
	let text = '';
	for (const node of nodes) {
		switch (node.type) {
			case 'text':
				text += node.value;
				break;
			case 'inlineCode':
				text += node.value;
				break;
			case 'emphasis':
			case 'strong':
			case 'strikethrough':
			case 'link':
				text += inlineText(node.children, options);
				break;
			case 'image':
				text += options.image === undefined ? '' : options.image(node);
				break;
			case 'break':
				text += ' ';
				break;
			case 'status':
				text += options.status === undefined ? '' : options.status(node.value);
				break;
			default:
				// Not `assertNever`. This half is the one that reads a bundle it did not
				// write, so an unknown node here means a newer toolchain, and losing one word
				// out of a table of contents entry is a better outcome than a 500.
				unhandledNode(node, 'inlineText');
		}
	}
	return text;
}

/**
 * Every block's text, in document order, one block per line.
 *
 * Blocks are separated by a newline rather than a space so that a caller counting
 * sentences does not run the last word of a heading into the first word of the
 * paragraph under it.
 */
export function blockText(blocks: readonly Block[], options: FlattenOptions = {}): string {
	const parts: string[] = [];

	const walk = (nodes: readonly Block[]): void => {
		for (const node of nodes) {
			switch (node.type) {
				case 'paragraph':
				case 'heading':
					parts.push(inlineText(node.children, options));
					break;
				case 'list':
					for (const item of node.children) walk(item.children);
					break;
				case 'code':
					if (options.code === true) {
						parts.push(
							node.lines.map((line) => line.tokens.map((t) => t.text).join('')).join('\n'),
						);
					}
					break;
				case 'blockquote':
					walk(node.children);
					break;
				case 'callout':
					if (node.title !== undefined) parts.push(inlineText(node.title, options));
					walk(node.children);
					break;
				case 'table':
					if (node.caption !== undefined) parts.push(inlineText(node.caption, options));
					parts.push(node.header.map((cell) => inlineText(cell.children, options)).join(' '));
					for (const row of node.rows) {
						parts.push(row.map((cell) => inlineText(cell.children, options)).join(' '));
					}
					break;
				case 'figure':
					parts.push(inlineText([node.image], options));
					if (node.caption !== undefined) parts.push(inlineText(node.caption, options));
					break;
				case 'thematicBreak':
					break;
				case 'steps':
					for (const step of node.children) {
						parts.push(inlineText(step.title, options));
						walk(step.children);
					}
					break;
				default:
					unhandledNode(node, 'blockText');
			}
		}
	};

	walk(blocks);
	return parts.filter((part) => part !== '').join('\n');
}
