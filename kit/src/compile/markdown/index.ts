/**
 * One markdown file to a parsed document.
 *
 * The order here is the contract: front matter first, then the authoring comments come
 * out, then the blocks are parsed, then the prose is swept for the spellings this AST
 * major reserves. Stripping the comments before the parse rather than after is what
 * makes "no suppression comment ever reaches a bundle" a property of the pipeline
 * rather than of a filter somebody has to remember to run.
 */

import { RESERVED_MATH_PATTERN } from '../../../../src/contracts/source.js';
import { DISABLE_COMMENT_PATTERN } from '../../../../src/contracts/lint.js';
import type { DocsProjectConfig } from '../../../../src/contracts/project.js';

import { readFrontMatter } from '../frontmatter.js';
import {
	positionAt,
	raw,
	type DisableComment,
	type NodeOrigins,
	type ParseServices,
	type ParsedDocument,
	type ProseSegment,
	type RawFinding,
} from '../types.js';
import { parseBlocks } from './blocks.js';
import { readSource, toLines, type SourceLine } from './fold.js';

/** A whole HTML comment on one line, which is the only shape this parser accepts. */
const COMMENT_LINE = /^\s*<!--([\s\S]*?)-->\s*$/;
/** A comment opening anywhere on the line, whole-line or not. */
const COMMENT_OPEN = /<!--/;

export interface ParseOptions {
	/** Relative to `docs/site/`. */
	file: string;
	config: DocsProjectConfig;
	services: ParseServices;
	/** Shared with every snippet expanded into this document, so origins stay in one map. */
	origins?: NodeOrigins;
	/** Non-zero while parsing a snippet, which is what refuses a nested include. */
	includeDepth?: number;
}

export function parseDocument(source: string, options: ParseOptions): ParsedDocument {
	const text = readSource(source);
	const frontMatter = readFrontMatter(text, options.file);

	const problems: RawFinding[] = [...frontMatter.problems];
	const prose: ProseSegment[] = [...frontMatter.prose];
	const disables: DisableComment[] = [];
	const includes: string[] = [];
	const origins: NodeOrigins = options.origins ?? new WeakMap();

	const lines = stripComments(
		toLines(frontMatter.body, frontMatter.bodyLine),
		options.file,
		disables,
		problems,
	);

	const blocks = parseBlocks(lines, {
		file: options.file,
		config: options.config,
		origins,
		services: options.services,
		problems,
		prose,
		includes,
		includeDepth: options.includeDepth ?? 0,
	});

	for (const segment of prose) {
		const match = RESERVED_MATH_PATTERN.exec(segment.folded.text);
		if (match === null) continue;
		const position = positionAt(segment.folded, segment.file, match.index);
		problems.push(
			raw(
				'unsupported-syntax',
				{ kind: 'file', file: position.file, line: position.line, column: position.column },
				null,
				'"$$" is reserved for mathematics, which this AST major cannot carry.',
				{
					remediation:
						'Write the expression as text or as an image. The delimiter is refused rather than rendered so that adding mathematics in a later AST major is not a breaking change for pages that already used it.',
					excerpt: segment.folded.text.slice(Math.max(0, match.index - 20), match.index + 20),
				},
			),
		);
	}

	return {
		file: options.file,
		source: text,
		frontMatter,
		blocks,
		origins,
		prose,
		includes,
		disables,
		problems,
	};
}

/**
 * Removes HTML comments, recording the suppressions among them.
 *
 * A comment becomes a blank line rather than disappearing, so every line number below it
 * is still the line number in the file. Suppression comments are what `maxDisables`
 * counts and what the lint runner applies to the line below, and every other comment is
 * authoring noise that must not reach a published page.
 *
 * A comment this parser will not strip is refused rather than tracked, and there are two
 * of those: one that opens and does not close on the same line, and one that shares a
 * line with text. Either would have to be stripped out of the middle of a block, and the
 * version that gets that subtly wrong publishes half of it. Refusing them by name is what
 * keeps "no authoring comment reaches a bundle" a property of the pipeline: the second
 * shape used to be neither stripped nor reported, so `Tap Write. <!-- ask design -->`
 * shipped the note as literal text on the page.
 */
function stripComments(
	lines: readonly SourceLine[],
	file: string,
	disables: DisableComment[],
	problems: RawFinding[],
): SourceLine[] {
	return lines.map((line) => {
		const whole = COMMENT_LINE.exec(line.text);
		if (whole === null) {
			// Anywhere on the line, not only at the start of it. Both patterns were anchored,
			// so `Tap Write. <!-- ask design about this -->` was neither stripped nor
			// reported: it stayed literal text, which put an internal note in a published
			// page and in the raw markdown, and the docblock above said the opposite. The
			// two shapes get the same message because they are the same problem to an
			// author: a comment this parser will not strip, sitting in text that ships.
			const opens = COMMENT_OPEN.exec(line.text);
			if (opens !== null) {
				problems.push(
					raw(
						'no-raw-html',
						{
							kind: 'file',
							file,
							line: line.line,
							column: line.column + opens.index,
						},
						null,
						line.text.includes('-->')
							? 'An HTML comment that is not the whole line.'
							: 'An HTML comment that does not close on the same line.',
						{
							remediation:
								'Put the whole comment on a line of its own. A comment sharing a line with text, or spanning blocks, would have to be stripped out of the middle of a paragraph, and the version that gets that wrong publishes half of it.',
							excerpt: line.text.trim(),
						},
					),
				);
			}
			return line;
		}

		const disable = DISABLE_COMMENT_PATTERN.exec(whole[1] as string);
		if (disable !== null) {
			disables.push({
				file,
				line: line.line,
				rule: disable[1] as string,
				reason: disable[2] as string,
				used: false,
			});
		}
		return { text: '', line: line.line, column: line.column };
	});
}
