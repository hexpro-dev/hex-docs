/**
 * The rules that read one compiled page.
 *
 * Everything here needs the tree, the front matter or the budgets, which is what
 * separates it from `prose.ts`: those rules read what a reader reads and know nothing
 * about the structure it came from. Splitting them that way is what lets the prose pack
 * be exported for another repository's scripts to run, since it needs no compiler.
 *
 * The parser and the project loader emit their own findings as they go, and they are
 * not repeated here. A rule in this file is one that can only be decided once the page
 * is whole.
 */

import type { Block, ImageNode, Inline } from '../../../../src/contracts/ast.js';
import { inlineText } from '../../../../src/ast/text.js';
import type { Locale } from '../../../../src/contracts/locales.js';
import type { CompiledPage } from '../../../../src/contracts/page.js';
import type { DocsProjectConfig } from '../../../../src/contracts/project.js';

import { locate, positionAt, raw, type ParsedDocument, type RawFinding } from '../types.js';

export interface PageRuleContext {
	config: DocsProjectConfig;
	page: CompiledPage;
	parsed: ParsedDocument;
	/** Relative to `docs/site/`. */
	file: string;
	locale: Locale;
}

/**
 * The explicit bidirectional controls, as code points with names.
 *
 * U+200F is deliberately absent. It is a mark rather than an embedding: it has no
 * closing partner, it cannot be unbalanced, and the Arabic pages carry it on purpose to
 * fix the visual order of a line mixing Arabic with a Latin product name. A rule that
 * counted it would report every correct Arabic page in the corpus.
 */
const BIDI_CONTROLS = [
	{ codePoint: 0x202a, name: 'left-to-right embedding', opens: true },
	{ codePoint: 0x202b, name: 'right-to-left embedding', opens: true },
	{ codePoint: 0x202d, name: 'left-to-right override', opens: true },
	{ codePoint: 0x202e, name: 'right-to-left override', opens: true },
	{ codePoint: 0x202c, name: 'pop directional formatting', opens: false },
	{ codePoint: 0x2066, name: 'left-to-right isolate', opens: true },
	{ codePoint: 0x2067, name: 'right-to-left isolate', opens: true },
	{ codePoint: 0x2068, name: 'first strong isolate', opens: true },
	{ codePoint: 0x2069, name: 'pop directional isolate', opens: false },
] as const;

const SENTENCE_ENDINGS = ['.', '!', '?', '。', '！', '？', '؟'];

export function pageFindings(context: PageRuleContext): RawFinding[] {
	const { config, page, parsed, file, locale } = context;
	const findings: RawFinding[] = [];
	const budgets = config.budgets;
	const titleLine = parsed.frontMatter.keyLines.title;
	const descriptionLine = parsed.frontMatter.keyLines.description;

	if (page.title.length > budgets.titleMax) {
		findings.push(
			raw(
				'title-length',
				titleLine === undefined ? { kind: 'file', file } : { kind: 'file', file, line: titleLine },
				locale,
				`The title is ${page.title.length} characters and the budget is ${budgets.titleMax}.`,
				{
					remediation:
						'Shorten it. A search result truncates past this anyway, so the characters beyond the budget are only visible in the source.',
					excerpt: page.title,
				},
			),
		);
	}

	if (page.description.length > budgets.descriptionMax) {
		findings.push(
			raw(
				'description-length',
				descriptionLine === undefined
					? { kind: 'file', file }
					: { kind: 'file', file, line: descriptionLine },
				locale,
				`The description is ${page.description.length} characters and the budget is ${budgets.descriptionMax}.`,
				{
					remediation:
						'Shorten it. There is a maximum and no minimum on purpose: a floor measured in characters rejects correct Japanese, where character density is roughly double English.',
					excerpt: page.description,
				},
			),
		);
	}

	if (page.description !== '' && !SENTENCE_ENDINGS.some((end) => page.description.endsWith(end))) {
		findings.push(
			raw(
				'description-is-a-sentence',
				descriptionLine === undefined
					? { kind: 'file', file }
					: { kind: 'file', file, line: descriptionLine },
				locale,
				'The description does not end in a full stop.',
				{
					remediation:
						'Write one sentence. It is read aloud by a search result and by llms.txt, both of which run it into whatever follows.',
					excerpt: page.description,
					suggestion: `${page.description}.`,
				},
			),
		);
	}

	for (const segment of parsed.prose) {
		let depth = 0;
		// The offset of the first control that is still open, so the unclosed message below
		// can point at it rather than at the start of the paragraph.
		let openedAt: number | undefined;
		// Walked by UTF-16 index, not by code point. `positionAt` reads `SourceRun` offsets
		// and lengths, which are built from `String.prototype.length` and are therefore
		// UTF-16 units, so a code-point index handed to it shifts the reported column one to
		// the left for every astral character earlier in the same paragraph. This rule is an
		// error whose own remediation says the damage is invisible in a diff, which makes
		// the column the only thing pointing at the character. Every member of
		// `BIDI_CONTROLS` is BMP and one unit wide, so the two indices differ only because
		// of the other characters around them.
		const text = segment.folded.text;
		for (let index = 0; index < text.length; index += 1) {
			const character = text[index] as string;
			const control = BIDI_CONTROLS.find((entry) => entry.codePoint === character.codePointAt(0));
			if (control === undefined) continue;
			if (control.opens && depth === 0) openedAt = index;
			depth += control.opens ? 1 : -1;
			if (depth >= 0) continue;
			const position = positionAt(segment.folded, segment.file, index);
			findings.push(
				raw(
					'bidi-balance',
					{ kind: 'file', file: position.file, line: position.line, column: position.column },
					locale,
					`A ${control.name} with nothing open before it.`,
					{
						remediation:
							'Balance the controls, or delete them. An unbalanced control leaks the reversed direction into the rest of the page, and only a reader of that language sees it.',
					},
				),
			);
			depth = 0;
			openedAt = undefined;
		}
		if (depth > 0) {
			// The first opener that is still open, not offset zero. The message says the
			// controls are "opened here", and offset zero is the start of the paragraph,
			// which for a hard-wrapped paragraph is a different line from the one that has
			// the problem.
			const position = positionAt(segment.folded, segment.file, openedAt ?? 0);
			findings.push(
				raw(
					'bidi-balance',
					{ kind: 'file', file: position.file, line: position.line, column: position.column },
					locale,
					`${depth} bidirectional ${depth === 1 ? 'control is' : 'controls are'} opened here and never closed.`,
					{
						remediation:
							'Close each one. The direction leaks into everything after it on the page, including the navigation.',
					},
				),
			);
		}
	}

	walkBlocks(page.body, 1, (block, depth) => {
		if (depth > budgets.nestingDepthMax) {
			findings.push(
				raw(
					'page-size',
					locate(parsed.origins, block, file),
					locale,
					`Block nesting reaches ${depth}, and the budget is ${budgets.nestingDepthMax}.`,
					{
						remediation:
							'Flatten the structure. Nesting this deep is unreadable on a phone and unrenderable in a right-to-left column.',
					},
				),
			);
		}

		if (block.type === 'code') {
			const bytes = Buffer.byteLength(
				block.lines.map((line) => line.tokens.map((token) => token.text).join('')).join('\n'),
			);
			if (bytes > budgets.codeFenceBytesMax) {
				findings.push(
					raw(
						'page-size',
						locate(parsed.origins, block, file),
						locale,
						`A code fence is ${bytes} bytes and the budget is ${budgets.codeFenceBytesMax}.`,
						{
							remediation:
								'Excerpt it and link the file. A listing this long is a file, and a reader scrolls past it either way.',
						},
					),
				);
			}
		}

		// Two items is enough. Three was the first threshold and it let the registry's own
		// bad example through, which is what a test that runs the examples is for: a rule
		// whose documented example does not trip it is a rule nobody can check by reading.
		// The corpus has no list at all whose every item opens bold, so two costs nothing.
		if (block.type === 'list' && block.children.length >= 2) {
			const allBold = block.children.every((item) => {
				const first = item.children[0];
				if (first === undefined || first.type !== 'paragraph') return false;
				return first.children[0]?.type === 'strong';
			});
			if (allBold) {
				findings.push(
					raw(
						'no-bolded-bullet-leadins',
						locate(parsed.origins, block, file),
						locale,
						'Every item in this list opens with a bolded lead-in.',
						{
							remediation:
								'Bold the one or two that carry a term worth scanning for, or none. A bolded lead-in on every bullet is one of the structural tells the house rules name, and it stops the bold meaning anything.',
						},
					),
				);
			}
		}

		for (const image of imagesIn(block)) {
			if (image.alt.trim() !== '') continue;
			findings.push(
				raw(
					'alt-text-required',
					locate(parsed.origins, image, file),
					locale,
					'This image has no text alternative.',
					{
						remediation:
							'Describe what the image shows, in a sentence. A documentation screenshot with no alternative text is the single most common accessibility failure in a manual.',
						excerpt: image.src,
					},
				),
			);
		}
	});

	return findings;
}

function imagesIn(block: Block): ImageNode[] {
	if (block.type === 'figure') return [block.image];
	const found: ImageNode[] = [];
	const walk = (nodes: readonly Inline[]): void => {
		for (const node of nodes) {
			if (node.type === 'image') found.push(node);
			else if (
				node.type === 'emphasis' ||
				node.type === 'strong' ||
				node.type === 'strikethrough' ||
				node.type === 'link'
			) {
				walk(node.children);
			}
		}
	};
	if (block.type === 'paragraph' || block.type === 'heading') walk(block.children);
	if (block.type === 'table') {
		for (const cell of block.header) walk(cell.children);
		for (const row of block.rows) for (const cell of row) walk(cell.children);
	}
	return found;
}

/** Every block, with its nesting depth, so a budget can be applied to the structure. */
function walkBlocks(
	blocks: readonly Block[],
	depth: number,
	visit: (block: Block, depth: number) => void,
): void {
	for (const block of blocks) {
		visit(block, depth);
		switch (block.type) {
			case 'list':
				for (const item of block.children) walkBlocks(item.children, depth + 1, visit);
				break;
			case 'blockquote':
			case 'callout':
				walkBlocks(block.children, depth + 1, visit);
				break;
			case 'steps':
				for (const step of block.children) walkBlocks(step.children, depth + 1, visit);
				break;
			default:
				break;
		}
	}
}

/** The heading text of a page, for the parity comparison, in document order. */
export function headingTexts(page: CompiledPage): string[] {
	return page.headings.map((heading) => heading.text);
}
