/**
 * The AST to React, as two exhaustive switches and nothing else.
 *
 * No hooks, no state, no context and no effects: every function here takes a node and a
 * context and returns markup. That is what lets the whole node layer be tested by calling
 * it, and it is why the shell keeps the hooks and the fence keeps the one piece of state
 * the copy button needs.
 *
 * There is no `dangerouslySetInnerHTML` anywhere in this package, and that is structural
 * rather than a convention somebody keeps: `ast.ts` has no `html` node and the compiler
 * refuses raw HTML in source, so there is no path from author text to markup this file did
 * not itself construct. `test/render/guards.test.ts` asserts the absence, and the absence
 * would be meaningless without the compiler half.
 *
 * ## The default branch is `unhandledNode`, not `assertNever`
 *
 * `ast.ts` says which one goes where and why: the compiler controls its own input, so an
 * unknown node there is a bug in the code that just produced it. This half is handed a
 * bundle compiled somewhere else, possibly by a newer toolchain, and taking a whole page
 * to a 500 over one node it could have skipped is the worse outcome. The real guard is
 * upstream, in `docsRoute`, which refuses an AST major it does not know; reaching here at
 * all means that already failed.
 */

import type { ReactElement, ReactNode } from 'react';

import {
	unhandledNode,
	type Block,
	type Callout,
	type Figure,
	type Heading,
	type ImageNode,
	type Inline,
	type Link,
	type ListItem,
	type ListNode,
	type Steps,
	type Table,
	type TableCell,
} from '../contracts/ast.js';
import type { Locale } from '../contracts/locales.js';
import { STATUS_SHAPE } from '../contracts/palette.js';
import type { DocsAddress } from '../site/address.js';
import { bundleUrl, docsHref } from '../site/address.js';
import { statusLabel } from '../ui/status.js';
import { calloutLabel, uiString } from '../ui/strings.js';
import { CodeBlock } from './code.js';
import type { DocsLinkComponent, RenderContext } from './context.js';

/**
 * The default `Link`: a plain anchor, so a consumer that passes nothing gets a working,
 * crawlable, no-JavaScript-safe site with full page loads rather than a broken one.
 */
export const PlainLink: DocsLinkComponent = (props) => {
	const { to, children, ...rest } = props;
	return (
		<a href={to} {...rest}>
			{children}
		</a>
	);
};

function hrefFor(link: Extract<Link, { kind: 'internal' }>, address: DocsAddress): string {
	return docsHref({ ...address, slug: link.slug, anchor: link.anchor });
}

function renderLink(node: Link, context: RenderContext, key: number): ReactNode {
	const children = renderInline(node.children, context);
	switch (node.kind) {
		case 'internal': {
			const Link = context.Link;
			return (
				<Link key={key} to={hrefFor(node, context.address)} title={node.title}>
					{children}
				</Link>
			);
		}
		case 'anchor':
			// Deliberately a plain anchor rather than the consumer's router link. A router
			// link to a hash on the current page is a navigation, which resets scroll and
			// pushes a history entry for a jump the browser already does natively.
			return (
				<a key={key} href={`#${node.anchor}`} title={node.title}>
					{children}
				</a>
			);
		case 'external':
			// `rel` is what `ast.ts` commits to for this kind. The visually hidden suffix
			// is the announcement: an icon alone is a fact only a sighted reader gets, and
			// `target="_blank"` with no warning is the WCAG 3.2.5 failure.
			return (
				<a
					key={key}
					href={node.href}
					title={node.title}
					target="_blank"
					rel="noopener noreferrer"
					className="hx-external"
				>
					{children}
					<span className="hx-sr">{uiString(context.locale, 'externalLink')}</span>
				</a>
			);
		case 'mailto':
			return (
				<a key={key} href={`mailto:${node.address}`} title={node.title}>
					{children}
				</a>
			);
		default:
			return unhandledNode(node, 'renderLink');
	}
}

function renderImage(node: ImageNode, context: RenderContext, key: number): ReactNode {
	// `width` and `height` come from the node rather than from the manifest's asset
	// record. Both carry the intrinsic size and both are described as authoritative, and
	// the node is the one the renderer is always holding: the manifest is not loaded per
	// page. `test/render/assets.test.ts` asserts the two agree for every image in the
	// corpus, so the choice is checked rather than assumed.
	return (
		<img
			key={key}
			className="hx-image"
			src={bundleUrl(context.bundleBase, node.src)}
			alt={node.alt}
			title={node.title}
			width={node.width}
			height={node.height}
			loading="lazy"
			decoding="async"
		/>
	);
}

export function renderInline(nodes: readonly Inline[], context: RenderContext): ReactNode[] {
	return nodes.map((node, index) => {
		switch (node.type) {
			case 'text':
				return node.value;
			case 'emphasis':
				return <em key={index}>{renderInline(node.children, context)}</em>;
			case 'strong':
				return <strong key={index}>{renderInline(node.children, context)}</strong>;
			case 'strikethrough':
				// `s`, not `del`. `del` is an editorial deletion with a document history
				// behind it; this is text the author struck through.
				return <s key={index}>{renderInline(node.children, context)}</s>;
			case 'inlineCode':
				// The class is what `unicode-bidi: isolate` hangs off, which is the single
				// highest-value line in the stylesheet's RTL section: without it the bidi
				// algorithm reorders `NDEFMessage.records` around the Arabic around it and
				// the reader sees a mangled symbol name.
				return (
					<code key={index} className="hx-code">
						{node.value}
					</code>
				);
			case 'link':
				return renderLink(node, context, index);
			case 'image':
				return renderImage(node, context, index);
			case 'break':
				return <br key={index} />;
			case 'status':
				// A shape, a colour and a localised name, so meaning never rests on hue
				// alone and never on a glyph: `lint.ts` bans the two glyphs an author would
				// reach for, and no glyph that survives the ban is covered by every font
				// the seven languages fall back to.
				return (
					<span
						key={index}
						className={`hx-status hx-status-${STATUS_SHAPE[node.value]}`}
						data-status={node.value}
						role="img"
						aria-label={statusLabel(context.locale, node.value)}
					/>
				);
			default:
				return unhandledNode(node, 'renderInline');
		}
	});
}

function renderCell(cell: TableCell, context: RenderContext): ReactNode {
	return renderInline(cell.children, context);
}

function renderTable(node: Table, context: RenderContext, key: number): ReactNode {
	// The wrapper is focusable and named. A table wider than its column scrolls, and a
	// scrollable region with no tab stop cannot be reached by keyboard at all; one with a
	// tab stop and no accessible name is an unlabelled stop, which is worse than the
	// original problem.
	return (
		<div
			key={key}
			className="hx-scroll"
			tabIndex={0}
			role="group"
			aria-label={uiString(context.locale, 'tableRegion')}
		>
			<table className="hx-table">
				{node.caption === undefined ? null : (
					<caption>{renderInline(node.caption, context)}</caption>
				)}
				<thead>
					<tr>
						{node.header.map((cell, column) => (
							<th key={column} scope="col" style={alignOf(node, column)}>
								{renderCell(cell, context)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{node.rows.map((row, index) => (
						<tr key={index}>
							{row.map((cell, column) => (
								<td key={column} style={alignOf(node, column)}>
									{renderCell(cell, context)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/**
 * A column's alignment, or nothing.
 *
 * `align` has one entry per column, so a row wider than the header reads past the end of
 * it. That is not hypothetical input: the renderer is handed bundles it did not compile,
 * and `noUncheckedIndexedAccess` is what turns the read into `undefined` rather than into
 * a crash. `textAlign: 'start'` would be wrong as a default, because `null` means the
 * reader's own default and a table in Arabic should follow the page.
 */
function alignOf(
	node: Table,
	column: number,
): { textAlign: 'left' | 'center' | 'right' } | undefined {
	const align = node.align[column];
	return align === undefined || align === null ? undefined : { textAlign: align };
}

function renderList(node: ListNode, context: RenderContext, key: number): ReactNode {
	const className = `hx-list${node.tight ? ' hx-tight' : ''}`;
	const items = node.children.map((item, index) => renderListItem(item, context, index));
	return node.style === 'ordered' ? (
		<ol key={key} className={className} start={node.start}>
			{items}
		</ol>
	) : (
		<ul key={key} className={className}>
			{items}
		</ul>
	);
}

function renderListItem(node: ListItem, context: RenderContext, key: number): ReactNode {
	if (node.checked === undefined) {
		return <li key={key}>{renderBlocks(node.children, context)}</li>;
	}
	// Not an `<input type="checkbox" disabled>`. A disabled control is announced as
	// disabled and is not focusable, which tells the reader they are being denied
	// something rather than that a step is done. This is a mark with a name, like a
	// status, and the same three channels: a shape, a colour and a word.
	const label = uiString(context.locale, node.checked ? 'taskDone' : 'taskTodo');
	return (
		<li key={key} className="hx-task-item">
			<span
				className={`hx-task hx-task-${node.checked ? 'done' : 'todo'}`}
				role="img"
				aria-label={label}
			/>
			{renderBlocks(node.children, context)}
		</li>
	);
}

function renderHeading(node: Heading, context: RenderContext, key: number): ReactNode {
	// The tag comes from `depth`, which starts at 2: the page title is front matter and
	// the shell renders the only `h1`, so a body heading can never compete with it.
	const Tag = `h${node.depth}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
	return (
		<Tag key={key} id={node.id} className="hx-heading">
			{renderInline(node.children, context)}
		</Tag>
	);
}

function renderCallout(node: Callout, context: RenderContext, key: number): ReactNode {
	const title =
		node.title === undefined
			? calloutLabel(context.locale, node.kind)
			: renderInline(node.title, context);
	return (
		<aside key={key} className="hx-callout" data-callout={node.kind}>
			<p className="hx-callout-title">{title}</p>
			{renderBlocks(node.children, context)}
		</aside>
	);
}

function renderFigure(node: Figure, context: RenderContext, key: number): ReactNode {
	return (
		<figure key={key} className="hx-figure">
			{renderImage(node.image, context, 0)}
			{node.caption === undefined ? null : (
				<figcaption>{renderInline(node.caption, context)}</figcaption>
			)}
		</figure>
	);
}

function renderSteps(node: Steps, context: RenderContext, key: number): ReactNode {
	return (
		<ol key={key} className="hx-steps">
			{node.children.map((step, index) => (
				<li key={index} id={step.id} className="hx-step">
					<p className="hx-step-title">
						<span className="hx-step-number">
							{uiString(context.locale, 'stepLabel', { number: String(index + 1) })}
						</span>
						{renderInline(step.title, context)}
					</p>
					{renderBlocks(step.children, context)}
				</li>
			))}
		</ol>
	);
}

export function renderBlocks(nodes: readonly Block[], context: RenderContext): ReactNode[] {
	return nodes.map((node, index) => {
		switch (node.type) {
			case 'paragraph':
				return <p key={index}>{renderInline(node.children, context)}</p>;
			case 'heading':
				return renderHeading(node, context, index);
			case 'list':
				return renderList(node, context, index);
			case 'code':
				return <CodeBlock key={index} node={node} context={context} />;
			case 'blockquote':
				return <blockquote key={index}>{renderBlocks(node.children, context)}</blockquote>;
			case 'callout':
				return renderCallout(node, context, index);
			case 'table':
				return renderTable(node, context, index);
			case 'figure':
				return renderFigure(node, context, index);
			case 'thematicBreak':
				return <hr key={index} />;
			case 'steps':
				return renderSteps(node, context, index);
			default:
				return unhandledNode(node, 'renderBlocks');
		}
	});
}

/**
 * The three child-only node types are unreachable from either switch.
 *
 * `ast.ts` keeps `ListItem`, `TableCell` and `Step` out of `Block` and `Inline` so the two
 * switches stay exhaustive, and pins the two unions disjoint at the foot of the file. That
 * is a compile-time property; this is the runtime half of it, asserted by
 * `test/render/nodes.test.ts` passing a bare `listItem` through `renderBlocks` and getting
 * nothing back rather than a rendered item in the wrong place.
 */
export function isChildOnly(type: string): boolean {
	return type === 'listItem' || type === 'tableCell' || type === 'step';
}
