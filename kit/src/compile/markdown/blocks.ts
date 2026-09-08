/**
 * Markdown blocks to `Block[]`.
 *
 * A line-oriented recursive parser over the subset the AST can carry, and a refusal by
 * name for everything else. It is not a CommonMark implementation and does not try to
 * be: the union in `src/contracts/ast.ts` is sized to the real corpus, so a parser that
 * accepted more would be producing nodes with nowhere to go.
 *
 * What is deliberately absent, because each one otherwise reads as a bug:
 *
 * - **Setext headings.** `Title` followed by `===` or `---`. There is one heading
 *   spelling, `##`, and a page's `#` title lives in front matter. A thematic break is
 *   always a thematic break here, which is what the corpus's `---` between sections is.
 * - **Indented code blocks.** Four spaces of indent is list continuation in this
 *   parser, and a fence is the only way to write code. The corpus has no indented code
 *   block, and supporting both means every continuation line in a deep list is one
 *   stray space away from becoming a code block.
 * - **HTML blocks.** There is no `html` node. Raw HTML stays literal text and
 *   `no-raw-html` reports it, which is what makes "no `dangerouslySetInnerHTML`
 *   anywhere" a structural property rather than a promise.
 * - **Link reference definitions and footnotes.** Neither is in the corpus and
 *   footnotes are deferred to `ast-2` by name.
 *
 * Containers recurse by stripping their marker and re-entering with the same absolute
 * line numbers and adjusted columns, so a finding inside a step inside a list still
 * points at the line the author typed it on.
 */

import {
	type Block,
	type Blockquote,
	type Callout,
	type Code,
	type Figure,
	type Heading,
	type HeadingDepth,
	type HeadingIdSource,
	type ImageNode,
	type Inline,
	type ListItem,
	type ListNode,
	type Paragraph,
	type Step,
	type Steps,
	type Table,
	type TableAlign,
	type TableCell,
} from '../../../../src/contracts/ast.js';
import { inlineText } from '../../../../src/ast/text.js';
import type { DocsProjectConfig } from '../../../../src/contracts/project.js';
import {
	CALLOUT_ALERT_PATTERN,
	CONTAINER_DIRECTIVE_PATTERN,
	DIRECTIVE_CLOSE_PATTERN,
	EXPLICIT_HEADING_ID_PATTERN,
	LEAF_DIRECTIVE_PATTERN,
	SECTION_NUMBER_PATTERN,
	SNIPPET_ID_PATTERN,
	SNIPPET_INCLUDE_NAME,
	calloutKindOf,
	isContainerDirective,
	parseFenceInfo,
	parseHighlightLines,
	sectionNumberAnchor,
} from '../../../../src/contracts/source.js';

import {
	positionAt,
	raw,
	type FoldedText,
	type NodeOrigins,
	type ParseServices,
	type ProseKind,
	type ProseSegment,
	type RawFinding,
} from '../types.js';
import { foldLines, type SourceLine } from './fold.js';
import { parseInline } from './inline.js';

export interface BlockContext {
	/** Relative to `docs/site/`. */
	file: string;
	config: DocsProjectConfig;
	origins: NodeOrigins;
	services: ParseServices;
	/** All appended to. One parse reports everything it found rather than the first thing. */
	problems: RawFinding[];
	prose: ProseSegment[];
	includes: string[];
	/** Guards against a snippet that includes itself, directly or through another. */
	includeDepth: number;
}

const FENCE = /^(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^(#{1,6})[ \t]+(.*)$/;
const THEMATIC_BREAK = /^(?:-{3,}|\*{3,}|_{3,})$/;
const BULLET_MARKER = /^([-*+])([ \t]+)/;
const ORDERED_MARKER = /^(\d{1,9})([.)])([ \t]+)/;
const TASK_MARKER = /^\[([ xX])\][ \t]+/;
const TABLE_DELIMITER = /^\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?$/;

/** Leading spaces. Tabs are counted as one column, which is what the corpus writes. */
function indentOf(text: string): number {
	let count = 0;
	while (text[count] === ' ' || text[count] === '\t') count += 1;
	return count;
}

function isBlank(line: SourceLine | undefined): boolean {
	return line === undefined || line.text.trim() === '';
}

/** A line with `count` leading characters removed, keeping the absolute position. */
function shift(line: SourceLine, count: number): SourceLine {
	return { text: line.text.slice(count), line: line.line, column: line.column + count };
}

/**
 * Whether a line begins a block, and therefore ends the paragraph above it.
 *
 * An ordered list only interrupts a paragraph when it starts at 1, which is
 * CommonMark's rule and which exists for a real sentence: a paragraph whose wrapped
 * line begins "1985. The standard was" is prose, not a list.
 */
function startsBlock(lines: readonly SourceLine[], index: number): boolean {
	const line = lines[index] as SourceLine;
	const body = line.text.slice(indentOf(line.text));
	if (body === '') return true;
	if (ATX_HEADING.test(body)) return true;
	if (FENCE.test(body)) return true;
	if (THEMATIC_BREAK.test(body.trimEnd())) return true;
	if (body.startsWith('>')) return true;
	if (CONTAINER_DIRECTIVE_PATTERN.test(body.trimEnd())) return true;
	if (DIRECTIVE_CLOSE_PATTERN.test(body.trimEnd())) return true;
	if (LEAF_DIRECTIVE_PATTERN.test(body.trimEnd())) return true;
	const bullet = BULLET_MARKER.exec(body);
	if (bullet !== null && body.slice(bullet[0].length).trim() !== '') return true;
	const ordered = ORDERED_MARKER.exec(body);
	if (ordered !== null && ordered[1] === '1' && body.slice(ordered[0].length).trim() !== '') {
		return true;
	}
	// A table needs the line after it to be a delimiter row, which is why this takes the
	// whole array rather than one line. Without it a table written straight under a
	// paragraph with no blank line between them is swallowed into the paragraph, header
	// row and delimiter row and all, and what the reader sees is a line of pipes.
	if (body.includes('|') && isTableStart(lines, index)) return true;
	return false;
}

export function parseBlocks(lines: readonly SourceLine[], context: BlockContext): Block[] {
	const blocks: Block[] = [];

	const at = (line: number, column: number) =>
		({ kind: 'file', file: context.file, line, column }) as const;

	const problem = (
		rule: RawFinding['rule'],
		line: SourceLine,
		message: string,
		remediation: string | null = null,
	): void => {
		context.problems.push(
			raw(rule, at(line.line, line.column), null, message, {
				remediation,
				excerpt: line.text.trim() === '' ? null : line.text.trim(),
			}),
		);
	};

	/** Parses inline content and records its prose in one step, so neither is forgotten. */
	const inline = (
		folded: FoldedText,
		kind: ProseKind,
		node: Block | undefined,
		scope: 'inline' | 'cell' = 'inline',
	): Inline[] => {
		const result = parseInline(folded, {
			file: context.file,
			scope,
			origins: context.origins,
			services: context.services,
			problems: context.problems,
		});
		if (result.prose.text.trim() !== '') {
			context.prose.push({
				file: context.file,
				kind,
				folded: result.prose,
				...(node === undefined ? {} : { node }),
			});
		}
		// One segment per title, carrying its own line and column. Kept out of the block's
		// prose on purpose: see `InlineResult.titles`.
		for (const title of result.titles) {
			if (title.text.trim() === '') continue;
			context.prose.push({ file: context.file, kind: 'title', folded: title });
		}
		return result.nodes;
	};

	const record = <T extends object>(node: T, line: SourceLine): T => {
		context.origins.set(node, { file: context.file, line: line.line, column: line.column });
		return node;
	};

	let index = 0;
	while (index < lines.length) {
		const line = lines[index] as SourceLine;
		if (isBlank(line)) {
			index += 1;
			continue;
		}

		const indent = indentOf(line.text);
		const body = line.text.slice(indent);
		const start = shift(line, indent);

		// ---- fenced code ---------------------------------------------------
		const fence = FENCE.exec(body);
		if (fence !== null) {
			const marker = fence[1] as string;
			const info = fence[2] as string;
			let end = index + 1;
			while (end < lines.length) {
				const candidate = (lines[end] as SourceLine).text.trim();
				if (
					candidate.startsWith(marker[0] as string) &&
					candidate.length >= marker.length &&
					candidate === candidate[0]?.repeat(candidate.length)
				) {
					break;
				}
				end += 1;
			}
			if (end >= lines.length) {
				problem(
					'unsupported-syntax',
					start,
					`A code fence opened with ${marker.length} ${marker[0] === '`' ? 'backticks' : 'tildes'} is never closed.`,
					'Close it with a marker at least as long as the one that opened it.',
				);
			}
			const content = lines
				.slice(index + 1, Math.min(end, lines.length))
				.map((source) => source.text.slice(Math.min(indent, indentOf(source.text))))
				.join('\n');
			blocks.push(record(codeBlock(info, content, start, context), start));
			index = Math.min(end + 1, lines.length);
			continue;
		}

		// ---- heading -------------------------------------------------------
		const heading = ATX_HEADING.exec(body);
		if (heading !== null) {
			const hashes = (heading[1] as string).length;
			const rest = heading[2] as string;
			if (hashes === 1) {
				problem(
					'no-h1-in-body',
					start,
					'A page cannot carry its own level one heading: the title is front matter and the shell renders it.',
					'Delete the line. The title in front matter is what the nav, the manifest, the search index and the tab all use.',
				);
				index += 1;
				continue;
			}
			blocks.push(
				headingBlock(hashes as HeadingDepth, rest, start, context, inline, record, problem),
			);
			index += 1;
			continue;
		}

		// ---- thematic break ------------------------------------------------
		if (THEMATIC_BREAK.test(body.trimEnd())) {
			blocks.push(record({ type: 'thematicBreak' }, start));
			index += 1;
			continue;
		}

		// ---- container directive -------------------------------------------
		const container = CONTAINER_DIRECTIVE_PATTERN.exec(body.trimEnd());
		if (container !== null) {
			const width = (container[1] as string).length;
			const name = container[2] as string;
			const label = container[3];
			const close = findClose(lines, index + 1, width);
			if (close === undefined) {
				problem(
					'unsupported-syntax',
					start,
					// The marker as the author typed it, not a literal three colons. A nested
					// container opens with four and the message quoting `:::note` sent a reader
					// looking for a line that is not in the file.
					`The "${':'.repeat(width)}${name}" container is never closed at the width it opened with (${width} colons).`,
					`Close it with a line of exactly ${width} colons. Nesting adds a colon to the outer marker.`,
				);
			}
			const inner = lines
				.slice(index + 1, close ?? lines.length)
				.map((source) => shift(source, Math.min(indent, indentOf(source.text))));
			blocks.push(
				...directiveBlocks(name, label, inner, start, context, {
					inline,
					record,
					problem,
				}),
			);
			index = close === undefined ? lines.length : close + 1;
			continue;
		}

		// A close with nothing open. It would otherwise become a paragraph reading ":::",
		// which is a hole in the page with no sign of where it came from.
		if (DIRECTIVE_CLOSE_PATTERN.test(body.trimEnd())) {
			problem(
				'unsupported-syntax',
				start,
				'A directive close with no container open above it.',
				'Delete it, or open the container it was meant to close.',
			);
			index += 1;
			continue;
		}

		// ---- leaf directive -------------------------------------------------
		const leaf = LEAF_DIRECTIVE_PATTERN.exec(body.trimEnd());
		if (leaf !== null) {
			const name = leaf[1] as string;
			const argument = leaf[2] as string;
			if (name !== SNIPPET_INCLUDE_NAME) {
				problem(
					'unsupported-syntax',
					start,
					`"::${name}" is not a leaf directive. The only one is "::${SNIPPET_INCLUDE_NAME}[id]".`,
					isContainerDirective(name)
						? `"${name}" is a container: open it with three colons and close it with three.`
						: null,
				);
			} else if (!SNIPPET_ID_PATTERN.test(argument)) {
				problem(
					'snippet-resolves',
					start,
					`"${argument}" is not a snippet id. Ids are one slug segment: lower case letters, digits and single hyphens.`,
				);
			} else if (context.includeDepth > 0) {
				problem(
					'snippet-resolves',
					start,
					'A snippet cannot include another snippet.',
					'Inline the fragment. Nesting transclusion makes the provenance of a page a graph nobody can read, and one cycle away from a build that does not terminate.',
				);
			} else {
				const resolved = context.services.resolveInclude(argument, {
					file: context.file,
					line: start.line,
					column: start.column,
				});
				if (resolved.ok) {
					context.includes.push(argument);
					blocks.push(...resolved.blocks);
				} else {
					problem('snippet-resolves', start, resolved.message, resolved.remediation);
				}
			}
			index += 1;
			continue;
		}

		// ---- blockquote ------------------------------------------------------
		if (body.startsWith('>')) {
			let end = index;
			while (end < lines.length) {
				const candidate = lines[end] as SourceLine;
				if (isBlank(candidate)) break;
				if (!candidate.text.slice(indentOf(candidate.text)).startsWith('>')) break;
				end += 1;
			}
			const inner = lines.slice(index, end).map((source) => {
				const own = indentOf(source.text);
				const withoutMarker = source.text.slice(own + 1);
				const gap = withoutMarker.startsWith(' ') ? 1 : 0;
				return shift(source, own + 1 + gap);
			});
			blocks.push(quoteBlock(inner, start, context, { inline, record }));
			index = end;
			continue;
		}

		// ---- table -----------------------------------------------------------
		if (body.includes('|') && isTableStart(lines, index)) {
			const { table, next } = tableBlock(lines, index, context, { inline, record, problem });
			blocks.push(table);
			index = next;
			continue;
		}

		// ---- list -------------------------------------------------------------
		const bullet = BULLET_MARKER.exec(body);
		const ordered = ORDERED_MARKER.exec(body);
		if (
			(bullet !== null && body.slice(bullet[0].length).trim() !== '') ||
			(ordered !== null && body.slice(ordered[0].length).trim() !== '')
		) {
			const { list, next } = listBlock(lines, index, indent, context, { record });
			blocks.push(list);
			index = next;
			continue;
		}

		// ---- paragraph ----------------------------------------------------------
		let end = index + 1;
		while (end < lines.length && !startsBlock(lines, end)) end += 1;
		const paragraphLines = lines
			.slice(index, end)
			.map((source) => shift(source, indentOf(source.text)));
		const folded = foldLines(paragraphLines);
		const paragraph: Paragraph = { type: 'paragraph', children: [] };
		paragraph.children = inline(folded, 'paragraph', paragraph);
		record(paragraph, start);
		blocks.push(promoteFigure(paragraph, context));
		index = end;
	}

	return blocks;
}

/**
 * A paragraph holding nothing but an image becomes a figure.
 *
 * The promotion is a compile-time decision on purpose. Left to the renderer it would be
 * a heuristic re-run on every render, and the difference between `<p><img></p>` and
 * `<figure>` would depend on whether a stray space survived the parse.
 */
function promoteFigure(paragraph: Paragraph, context: BlockContext): Block {
	const meaningful = paragraph.children.filter(
		(child) => child.type !== 'text' || child.value.trim() !== '',
	);
	const only = meaningful[0];
	if (meaningful.length !== 1 || only === undefined || only.type !== 'image') return paragraph;
	const figure: Figure = { type: 'figure', image: only };
	const origin = context.origins.get(paragraph);
	if (origin !== undefined) context.origins.set(figure, origin);
	return figure;
}

/** The line index of the directive close at exactly `width` colons, or `undefined`. */
function findClose(lines: readonly SourceLine[], from: number, width: number): number | undefined {
	for (let index = from; index < lines.length; index += 1) {
		const candidate = (lines[index] as SourceLine).text.trim();
		const close = DIRECTIVE_CLOSE_PATTERN.exec(candidate);
		if (close !== null && (close[1] as string).length === width) return index;
	}
	return undefined;
}

function codeBlock(info: string, content: string, start: SourceLine, context: BlockContext): Code {
	const parsed = parseFenceInfo(info);
	const allowed = context.config.code.languages;

	for (const message of parsed.problems) {
		context.problems.push(
			raw(
				'unsupported-syntax',
				{ kind: 'file', file: context.file, line: start.line, column: start.column },
				null,
				message,
				{ excerpt: info.trim() === '' ? null : info.trim() },
			),
		);
	}

	if (parsed.lang === undefined) {
		context.problems.push(
			raw(
				'code-fence-language',
				{ kind: 'file', file: context.file, line: start.line, column: start.column },
				null,
				'This fence carries no language, so it renders unhighlighted and nothing says whether that was intended.',
				{
					remediation: `Label it. Use "${allowed.includes('text') ? 'text' : allowed[0]}" for output, a tree or anything that is deliberately not code.`,
				},
			),
		);
	} else if (!allowed.includes(parsed.lang)) {
		context.problems.push(
			raw(
				'code-fence-language',
				{ kind: 'file', file: context.file, line: start.line, column: start.column },
				null,
				`"${parsed.lang}" is not in this project's fence language allowlist.`,
				{
					remediation: `Add it to code.languages in docs.json, or fix the spelling. The allowlist is ${allowed.join(', ')}.`,
					excerpt: parsed.lang,
				},
			),
		);
	}

	const highlighted = context.services.highlight(content, parsed.lang);
	const options = parsed.options;

	const code: Code = {
		...(parsed.lang === undefined ? {} : { lang: parsed.lang }),
		...(highlighted.label === undefined ? {} : { langLabel: highlighted.label }),
		type: 'code',
		highlighted: highlighted.highlighted,
		lines: highlighted.lines,
		showLineNumbers: options.lineNumbers === true,
	};

	if (typeof options.title === 'string') {
		code.filename = options.title;
		// The third piece of reader-visible text the house rules could not see. A fence's
		// `title=` is rendered as the code block's filename caption, so an em dash or a
		// banned phrase in one shipped and no rule scanned it. Located by searching the
		// fence line rather than by threading offsets out of `parseFenceInfo`, which would
		// mean a contract change for a column: the value appears once on that line, and
		// falling back to the start of the line names the fence, which is where an author
		// would look anyway.
		const at = start.text.indexOf(options.title);
		context.prose.push({
			file: context.file,
			kind: 'title',
			folded: {
				text: options.title,
				runs: [
					{
						offset: 0,
						length: options.title.length,
						line: start.line,
						column: start.column + (at === -1 ? 0 : at),
					},
				],
			},
		});
	}
	if (typeof options.start === 'string') {
		const startLine = Number(options.start);
		if (!Number.isInteger(startLine) || startLine < 1) {
			context.problems.push(
				raw(
					'unsupported-syntax',
					{ kind: 'file', file: context.file, line: start.line, column: start.column },
					null,
					`start="${options.start}" is not a line number.`,
					{ remediation: 'Write a positive whole number, as start=12.' },
				),
			);
		} else {
			code.startLine = startLine;
		}
	}
	if (typeof options.highlight === 'string') {
		const marked = parseHighlightLines(options.highlight);
		if (marked === undefined) {
			context.problems.push(
				raw(
					'unsupported-syntax',
					{ kind: 'file', file: context.file, line: start.line, column: start.column },
					null,
					`highlight="${options.highlight}" is not a line list.`,
					{
						remediation:
							'Write comma-separated numbers and inclusive ranges, as highlight="2,5-7".',
					},
				),
			);
		} else {
			code.highlight = marked;
		}
	}
	if (options.wrap === true) code.wrap = true;

	return code;
}

type InlineFn = (
	folded: FoldedText,
	kind: ProseKind,
	node: Block | undefined,
	scope?: 'inline' | 'cell',
) => Inline[];
type RecordFn = <T extends object>(node: T, line: SourceLine) => T;
type ProblemFn = (
	rule: RawFinding['rule'],
	line: SourceLine,
	message: string,
	remediation?: string | null,
) => void;

function headingBlock(
	depth: HeadingDepth,
	rest: string,
	start: SourceLine,
	context: BlockContext,
	inline: InlineFn,
	record: RecordFn,
	problem: ProblemFn,
): Heading {
	if (depth > 4) {
		problem(
			'heading-depth',
			start,
			`A level ${depth} heading is deeper than anything this package renders distinguishably.`,
			'Restructure the section, or split the page. Four levels is already a page asking to be two.',
		);
	}

	let text = rest.trimEnd();
	let explicit: string | undefined;
	const marked = EXPLICIT_HEADING_ID_PATTERN.exec(text);
	if (marked !== null) {
		explicit = marked[1] as string;
		text = text.slice(0, marked.index).trimEnd();
	}

	const offset = start.text.length - rest.length;
	const folded = foldLines([{ text, line: start.line, column: start.column + offset }]);

	const heading: Heading = { type: 'heading', depth, id: '', idSource: 'slug', children: [] };
	heading.children = inline(folded, 'heading', heading);

	const flattened = inlineText(heading.children);
	const derived = deriveHeadingId(flattened, explicit, context.config.headingIds);
	heading.id = derived.id;
	heading.idSource = derived.source;
	record(heading, start);
	return heading;
}

export interface DerivedHeadingId {
	id: string;
	source: HeadingIdSource;
}

/**
 * The anchor a heading answers to, before the page makes it unique.
 *
 * An explicit `{#id}` always wins, because it is the only spelling that is identical in
 * every language and a translator is asked to copy it across unchanged. Section numbers
 * win next under a project configured for them: `#section-4` addresses the same clause
 * in all seven languages, and slugified headings would give every language its own
 * anchors and break every inbound link with nothing reporting it.
 */
export function deriveHeadingId(
	text: string,
	explicit: string | undefined,
	mode: DocsProjectConfig['headingIds'],
): DerivedHeadingId {
	if (explicit !== undefined) return { id: explicit, source: 'explicit' };
	if (mode === 'section-number') {
		const numbered = SECTION_NUMBER_PATTERN.exec(text);
		if (numbered !== null) {
			return { id: sectionNumberAnchor(numbered[1] as string), source: 'section-number' };
		}
	}
	return { id: slugifyHeading(text), source: 'slug' };
}

/**
 * Heading text to an anchor.
 *
 * Letters and numbers in any script survive, which is what makes an anchor
 * locale-dependent by construction and is why `aliases` exists. A heading with no
 * letters at all, which is a heading made entirely of punctuation, falls back to
 * `section`; the page's uniqueness pass then numbers it.
 */
export function slugifyHeading(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '');
	return slug === '' ? 'section' : slug;
}

function quoteBlock(
	inner: readonly SourceLine[],
	start: SourceLine,
	context: BlockContext,
	helpers: { inline: InlineFn; record: RecordFn },
): Blockquote | Callout {
	const first = inner[0];
	const alert = first === undefined ? null : CALLOUT_ALERT_PATTERN.exec(first.text.trim());
	if (alert !== null && first !== undefined) {
		const kind = calloutKindOf(alert[1] as string);
		if (kind !== undefined) {
			const callout: Callout = { type: 'callout', kind, children: [] };
			callout.children = parseBlocks(inner.slice(1), context);
			return helpers.record(callout, start);
		}
	}
	const quote: Blockquote = { type: 'blockquote', children: [] };
	quote.children = parseBlocks(inner, context);
	return helpers.record(quote, start);
}

function directiveBlocks(
	name: string,
	label: string | undefined,
	inner: readonly SourceLine[],
	start: SourceLine,
	context: BlockContext,
	helpers: { inline: InlineFn; record: RecordFn; problem: ProblemFn },
): Block[] {
	const { inline, record, problem } = helpers;

	const labelFolded = (kind: ProseKind): Inline[] => {
		if (label === undefined || label === '') return [];
		const column = start.column + start.text.indexOf('[') + 1;
		return inline(foldLines([{ text: label, line: start.line, column }]), kind, undefined);
	};

	if (!isContainerDirective(name)) {
		problem(
			'unsupported-syntax',
			start,
			`":::${name}" is not a directive this AST major understands.`,
			'The container directives are the five callout kinds plus steps, step, figure and table. The contents are kept as ordinary blocks.',
		);
		return parseBlocks(inner, context);
	}

	const kind = calloutKindOf(name);
	if (kind !== undefined) {
		const callout: Callout = { type: 'callout', kind, children: [] };
		const title = labelFolded('caption');
		if (title.length > 0) callout.title = title;
		callout.children = parseBlocks(inner, context);
		return [record(callout, start)];
	}

	if (name === 'steps') {
		const steps: Steps = { type: 'steps', children: [] };
		steps.children = parseSteps(inner, context, helpers);
		if (steps.children.length === 0) {
			problem(
				'unsupported-syntax',
				start,
				'A steps container holds step containers and nothing else, and this one holds none.',
				'Wrap each step in ":::step[Title]". A steps container is what HowTo structured data is derived from, so an empty one is a claim with nothing behind it.',
			);
		}
		return [record(steps, start)];
	}

	if (name === 'step') {
		problem(
			'unsupported-syntax',
			start,
			'A step container only means anything inside a steps container.',
			'Wrap the steps in "::::steps", with one more colon than the steps themselves.',
		);
		return parseBlocks(inner, context);
	}

	if (name === 'figure') {
		const children = parseBlocks(inner, context);
		const image = firstImage(children);
		if (image === undefined) {
			problem(
				'unsupported-syntax',
				start,
				'A figure container holds exactly one image.',
				'Put the image inside it, or use an ordinary paragraph.',
			);
			return children;
		}
		// Two ways to hold more than an image, and only the first used to be reported. A
		// paragraph holding nothing but an image is already a `figure` by the time
		// `parseBlocks` returns, so a single child that is still a `paragraph` is one that
		// had words around the image. `:::figure[Caption]` wrapping `Before the image
		// ![alt](scan.png) after the image.` compiled to a figure and a caption with the
		// sentence gone, no finding, and a prose segment still recorded for text that would
		// not ship, so the linter could report a style problem at a line the reader never
		// sees. This guard's own message already promised to report exactly that.
		const surrounded = children.some(
			(child) =>
				child.type === 'paragraph' &&
				child.children.some((inlineChild) => inlineChild.type === 'image'),
		);
		if (children.length > 1 || surrounded) {
			problem(
				'unsupported-syntax',
				start,
				surrounded && children.length === 1
					? 'A figure container holds one image, and this one holds an image with text around it.'
					: 'A figure container holds one image and its caption, and this one holds more.',
				'Move the extra text outside it. Anything else in the container is dropped, because a figure carries an image and a caption and has nowhere to put a paragraph.',
			);
		}
		const figure: Figure = { type: 'figure', image };
		const caption = labelFolded('caption');
		if (caption.length > 0) figure.caption = caption;
		return [record(figure, start)];
	}

	// `table`: the caption is the directive's label rather than the container's last
	// paragraph, because the paragraph form is ambiguous with the prose that follows a
	// table and the ambiguity only shows up as a missing sentence on a published page.
	const children = parseBlocks(inner, context);
	const table = children.find((child): child is Table => child.type === 'table');
	if (table === undefined) {
		problem(
			'unsupported-syntax',
			start,
			'A table container holds exactly one table.',
			'Put the table inside it. The container exists to carry the caption.',
		);
		return children;
	}
	const caption = labelFolded('caption');
	if (caption.length > 0) table.caption = caption;
	return children;
}

function firstImage(blocks: readonly Block[]): ImageNode | undefined {
	for (const block of blocks) {
		if (block.type === 'figure') return block.image;
		if (block.type !== 'paragraph') continue;
		for (const child of block.children) if (child.type === 'image') return child;
	}
	return undefined;
}

function parseSteps(
	inner: readonly SourceLine[],
	context: BlockContext,
	helpers: { inline: InlineFn; record: RecordFn; problem: ProblemFn },
): Step[] {
	const steps: Step[] = [];
	let index = 0;
	while (index < inner.length) {
		const line = inner[index] as SourceLine;
		if (isBlank(line)) {
			index += 1;
			continue;
		}
		const indent = indentOf(line.text);
		const start = shift(line, indent);
		const container = CONTAINER_DIRECTIVE_PATTERN.exec(start.text.trimEnd());
		if (container === null || container[2] !== 'step') {
			helpers.problem(
				'unsupported-syntax',
				start,
				'A steps container holds step containers and nothing else.',
				'Move this into a ":::step[Title]" or out of the steps container.',
			);
			index += 1;
			continue;
		}
		const width = (container[1] as string).length;
		const close = findClose(inner, index + 1, width);
		if (close === undefined) {
			helpers.problem(
				'unsupported-syntax',
				start,
				`This step is never closed at the width it opened with (${width} colons).`,
			);
		}
		const label = container[3] ?? '';
		const body = inner
			.slice(index + 1, close ?? inner.length)
			.map((source) => shift(source, Math.min(indent, indentOf(source.text))));

		const step: Step = { type: 'step', id: '', title: [], children: [] };
		const column = start.column + start.text.indexOf('[') + 1;
		step.title =
			label === ''
				? []
				: helpers.inline(
						foldLines([{ text: label, line: start.line, column }]),
						'stepTitle',
						undefined,
					);
		step.id = slugifyHeading(inlineText(step.title));
		step.children = parseBlocks(body, context);
		steps.push(helpers.record(step, start));
		index = close === undefined ? inner.length : close + 1;
	}
	return steps;
}

function isTableStart(lines: readonly SourceLine[], index: number): boolean {
	const header = lines[index];
	const delimiter = lines[index + 1];
	if (header === undefined || delimiter === undefined) return false;
	if (!header.text.includes('|')) return false;
	const body = delimiter.text.trim();
	return body.includes('-') && body.includes('|') && TABLE_DELIMITER.test(body);
}

/** Splits a table row on unescaped pipes, keeping each cell's column in the source line. */
function splitRow(line: SourceLine): SourceLine[] {
	const cells: SourceLine[] = [];
	let current = '';
	let from = 0;
	const text = line.text.trim();
	const lead = line.text.length - line.text.trimStart().length;
	const flush = (end: number): void => {
		const trimmed = current.trim();
		const offset = trimmed === '' ? 0 : current.indexOf(trimmed);
		cells.push({ text: trimmed, line: line.line, column: line.column + lead + from + offset });
		current = '';
		from = end + 1;
	};
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index] as string;
		if (character === '\\') {
			current += text.slice(index, index + 2);
			index += 1;
			continue;
		}
		if (character === '|') {
			flush(index);
			continue;
		}
		current += character;
	}
	flush(text.length);
	// The outer pipes produce an empty cell at each end. Dropping them here rather than
	// in the caller is what keeps a row with no outer pipes parsing the same way.
	if (cells.length > 0 && (cells[0] as SourceLine).text === '' && text.startsWith('|')) {
		cells.shift();
	}
	if (cells.length > 0 && (cells.at(-1) as SourceLine).text === '' && text.endsWith('|')) {
		cells.pop();
	}
	return cells;
}

function alignmentOf(cell: string): TableAlign | null {
	const left = cell.startsWith(':');
	const right = cell.endsWith(':');
	if (left && right) return 'center';
	if (left) return 'left';
	if (right) return 'right';
	return null;
}

function tableBlock(
	lines: readonly SourceLine[],
	index: number,
	context: BlockContext,
	helpers: { inline: InlineFn; record: RecordFn; problem: ProblemFn },
): { table: Table; next: number } {
	const headerLine = lines[index] as SourceLine;
	const delimiterLine = lines[index + 1] as SourceLine;
	const headerCells = splitRow(headerLine);
	const declared = splitRow(delimiterLine).map((cell) => alignmentOf(cell.text));
	// `align` is one entry per column, so a delimiter row with a different number of
	// cells is padded rather than carried across. A short row would otherwise index past
	// the end and give the last columns `undefined` where the contract says `null`.
	const alignment: (TableAlign | null)[] = headerCells.map((_, column) => declared[column] ?? null);

	const cellNode = (source: SourceLine): TableCell => {
		const cell: TableCell = { type: 'tableCell', children: [] };
		cell.children = helpers.inline(foldLines([source]), 'tableCell', undefined, 'cell');
		context.origins.set(cell, {
			file: context.file,
			line: source.line,
			column: source.column,
		});
		return cell;
	};

	const header = headerCells.map(cellNode);
	const rows: TableCell[][] = [];
	let cursor = index + 2;
	while (cursor < lines.length) {
		const row = lines[cursor] as SourceLine;
		if (isBlank(row) || !row.text.includes('|')) break;
		const cells = splitRow(row);
		// `align` is built from the header and has exactly one entry per header column,
		// which is what `Table.align` promises. A row with a different number of cells
		// breaks that promise silently: a renderer reading `align[column]` for the extra
		// cell gets `undefined` where the contract says `TableAlign | null`. Reported at
		// the row rather than dropped, because a row with a stray pipe in it is a typo and
		// the author is the one who can see which cell was meant.
		if (cells.length !== headerCells.length) {
			helpers.problem(
				'table-header-required',
				row,
				`This row has ${cells.length} cells and the header has ${headerCells.length}.`,
				'Give every row the same number of cells as the header. An extra cell has no column to be aligned against, and a missing one shifts everything after it into the wrong column.',
			);
		}
		rows.push(cells.map(cellNode));
		cursor += 1;
	}

	if (headerCells.some((cell) => cell.text === '')) {
		helpers.problem(
			'table-header-required',
			headerLine,
			'A table has a header cell with no text in it.',
			'Name every column. A blank header is a column a screen reader announces as nothing and a search result cannot label.',
		);
	}
	if (rows.length > context.config.budgets.tableRowsMax) {
		helpers.problem(
			'page-size',
			headerLine,
			`This table has ${rows.length} rows and the budget is ${context.config.budgets.tableRowsMax}.`,
			'Split it, or move the data behind a link. A table this long is a database with no query.',
		);
	}

	const table: Table = { type: 'table', align: alignment, header, rows };
	helpers.record(table, headerLine);
	return { table, next: cursor };
}

function listBlock(
	lines: readonly SourceLine[],
	index: number,
	indent: number,
	context: BlockContext,
	helpers: { record: RecordFn },
): { list: ListNode; next: number } {
	const first = lines[index] as SourceLine;
	const body = first.text.slice(indent);
	const isOrdered = ORDERED_MARKER.test(body);
	const startNumber = isOrdered ? Number((ORDERED_MARKER.exec(body) as RegExpExecArray)[1]) : 1;

	interface Collected {
		marker: SourceLine;
		/** Columns the marker occupies, so continuation lines dedent by the right amount. */
		contentIndent: number;
		content: SourceLine[];
		checked?: boolean;
	}
	const collected: Collected[] = [];
	let loose = false;
	let cursor = index;
	let sawBlank = false;

	while (cursor < lines.length) {
		const line = lines[cursor] as SourceLine;
		if (isBlank(line)) {
			sawBlank = true;
			cursor += 1;
			continue;
		}
		const own = indentOf(line.text);
		const text = line.text.slice(own);
		const marker = isOrdered ? ORDERED_MARKER.exec(text) : BULLET_MARKER.exec(text);

		if (own === indent && marker !== null && text.slice(marker[0].length).trim() !== '') {
			// A blank line between two items is what makes a list loose. Trailing blanks
			// after the last item are not, which is why this is recorded when the next item
			// arrives rather than counted at the end.
			if (sawBlank && collected.length > 0) loose = true;
			sawBlank = false;
			const contentIndent = indent + marker[0].length;
			const rest = shift(line, contentIndent);
			const task = TASK_MARKER.exec(rest.text);
			const item: Collected = { marker: line, contentIndent, content: [] };
			if (task !== null) {
				item.checked = (task[1] as string).toLowerCase() === 'x';
				item.content.push(shift(rest, task[0].length));
			} else {
				item.content.push(rest);
			}
			collected.push(item);
			cursor += 1;
			continue;
		}

		const current = collected.at(-1);
		if (current === undefined) break;
		if (own < current.contentIndent) break;
		if (sawBlank) {
			// A blank line inside an item with content after it also makes the list loose,
			// and the blank has to survive into the item so the two halves stay two blocks.
			loose = true;
			current.content.push({ text: '', line: line.line - 1, column: 1 });
			sawBlank = false;
		}
		current.content.push(shift(line, current.contentIndent));
		cursor += 1;
	}

	const items: ListItem[] = collected.map((entry) => {
		const item: ListItem = { type: 'listItem', children: [] };
		if (entry.checked !== undefined) item.checked = entry.checked;
		item.children = parseBlocks(entry.content, context);
		return helpers.record(item, entry.marker);
	});

	const list: ListNode = {
		type: 'list',
		style: isOrdered ? 'ordered' : 'bullet',
		tight: !loose,
		children: items,
	};
	if (isOrdered && startNumber !== 1) list.start = startNumber;
	helpers.record(list, first);
	return { list, next: cursor };
}
