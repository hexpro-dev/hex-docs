/**
 * The fenced code block.
 *
 * Its own file because it is the one node with state, the one with a keyboard-reachable
 * scroll region, and the one whose two coordinate systems are easy to get backwards.
 *
 * ## `highlight` indexes the excerpt, `startLine` only changes what is printed
 *
 * `ast.ts` says "1-based line numbers to mark, relative to `startLine`", and that sentence
 * has been read both ways. It means the numbers count from the top of the fence: the
 * corpus writes `start=12 highlight="2,5-7"` over ten lines and means the guard clause and
 * the three-line constructor call, and `start=48 highlight="3,9"` over twelve and means
 * the throw and the alertMessage assignment. Adding `startLine` to the numbers marks
 * nothing at all on either block, which is a failure that renders as a perfectly ordinary
 * code block. `test/render/code.test.ts` names both files and both indices.
 */

import { useState, type ReactElement } from 'react';

import type { Code, CodeLine } from '../contracts/ast.js';
import { DIFF_GUTTER, scopeClass } from '../contracts/palette.js';
import { CODE_DIRECTION } from '../site/direction.js';
import { uiString } from '../ui/strings.js';
import type { RenderContext } from './context.js';
import { useHydrated } from './client.js';

/** Which line numbers to mark, as a set, indexed from the top of the fence. */
function markedLines(node: Code): ReadonlySet<number> {
	return new Set(node.highlight ?? []);
}

/**
 * Whether a line is a diff line, and which kind.
 *
 * Read off the first token, because a highlighter scopes the whole line when it scopes a
 * diff at all. The gutter character is the second channel: `inserted` and `deleted`
 * measure 1.29:1 against each other, so a reader who cannot separate the two hues gets
 * nothing from the colour, and `palette.ts` carries the measurement.
 */
function diffOf(line: CodeLine): 'inserted' | 'deleted' | undefined {
	const scope = line.tokens[0]?.scope;
	return scope === 'inserted' || scope === 'deleted' ? scope : undefined;
}

export function CodeBlock({ node, context }: { node: Code; context: RenderContext }): ReactElement {
	const marked = markedLines(node);
	const start = node.startLine ?? 1;
	const label =
		node.langLabel === undefined
			? uiString(context.locale, 'codeRegion')
			: uiString(context.locale, 'codeRegionNamed', { language: node.langLabel });

	return (
		<div className="hx-fence" data-lang={node.lang}>
			{/*
			 * The bar is unconditional, because the copy button is. An unlabelled fence is
			 * the box-drawing diagram and the directory tree in this corpus, which are
			 * exactly the blocks a reader most wants to copy, and hanging the button off
			 * the presence of a filename would have taken it away from them.
			 */}
			<div className="hx-fence-bar">
				{node.filename === undefined ? null : (
					<span className="hx-fence-file">{node.filename}</span>
				)}
				{node.langLabel === undefined ? null : (
					// `aria-hidden`, because the region below is already named with the same
					// word. Without it a screen reader announces the language twice on every
					// block, which on a reference page is most of the page.
					<span className="hx-fence-lang" aria-hidden="true">
						{node.langLabel}
					</span>
				)}
				<CopyButton node={node} context={context} />
			</div>
			<pre
				className={`hx-pre${node.wrap === true ? ' hx-wrap' : ''}`}
				dir={CODE_DIRECTION}
				tabIndex={0}
				role="group"
				aria-label={label}
			>
				<code>
					{node.lines.map((line, index) => {
						const diff = diffOf(line);
						return (
							<span
								key={index}
								className="hx-line"
								data-marked={marked.has(index + 1) ? 'true' : undefined}
								data-diff={diff}
							>
								{node.showLineNumbers ? (
									<span className="hx-line-number" aria-hidden="true">
										{start + index}
									</span>
								) : null}
								{diff === undefined ? null : (
									<span className="hx-line-diff" aria-hidden="true">
										{DIFF_GUTTER[diff]}
									</span>
								)}
								{line.tokens.map((token, position) =>
									token.scope === undefined ? (
										token.text
									) : (
										<span key={position} className={scopeClass(token.scope)}>
											{token.text}
										</span>
									),
								)}
								{'\n'}
							</span>
						);
					})}
				</code>
			</pre>
		</div>
	);
}

/**
 * Copy, disabled until the page is interactive.
 *
 * A button rendered by the server, announced as a button, that does nothing because the
 * script never ran is worse than no button: it is a control that lies. Rendering it only
 * after hydration would move the bar's layout under the reader; rendering it disabled says
 * what is true, costs no shift, and becomes live the moment the page does.
 */
function CopyButton({ node, context }: { node: Code; context: RenderContext }): ReactElement {
	const hydrated = useHydrated();
	const [copied, setCopied] = useState(false);

	const text = node.lines.map((line) => line.tokens.map((token) => token.text).join('')).join('\n');

	return (
		<button
			type="button"
			className="hx-copy"
			disabled={!hydrated}
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					context.emit('hexdocs:copy', { kind: 'code' });
					setTimeout(() => setCopied(false), 2000);
				});
			}}
		>
			{uiString(context.locale, copied ? 'copied' : 'copyCode')}
		</button>
	);
}
