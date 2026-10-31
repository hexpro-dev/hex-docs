/**
 * Inline markdown to `Inline[]`.
 *
 * It reads a `FoldedText` rather than a string, which is what lets every node and every
 * finding carry a line and a column: the folded text knows which source line each of
 * its characters came from, and the parser records the offsets it consumed.
 *
 * The subset is the one the corpus and the AST agree on, and anything outside it stays
 * literal text rather than becoming a node the renderer does not have. Two of those
 * omissions are worth naming because they look like bugs otherwise. There are no link
 * reference definitions (`[text][ref]` and the `[ref]: url` line at the foot of a
 * file): nothing in the corpus uses them, and a half-implemented version that resolved
 * some references and left others as literal brackets would be worse than none.
 * And there are no autolinks (`<https://example.com>`), because the angle bracket form
 * is what `no-raw-html` is looking for and supporting both would put the two in
 * competition over the same characters.
 *
 * The one place this parser is deliberately unlike CommonMark is the underscore. An
 * underscore only opens or closes emphasis when the character outside it is not
 * alphanumeric, so `FIXTURE_TAG_LOG` and `session(_:didConnect:)` stay literal. Full
 * CommonMark flanking rules already do most of this; stating it as a rule of its own
 * means a technical corpus does not depend on getting the subtle version exactly right.
 */

import {
	type Inline,
	type ImageNode,
	type Link,
	type TextNode,
} from '../../../../src/contracts/ast.js';
import {
	isContainerDirective,
	isTextDirective,
	statusAt,
	textDirectiveAt,
	TEXT_DIRECTIVE_NAMES,
	type StatusScope,
} from '../../../../src/contracts/source.js';

import {
	positionAt,
	raw,
	type FoldedText,
	type NodeOrigins,
	type ParseServices,
	type ProseKind,
	type RawFinding,
	type ResolvedDestination,
	type TextDirectiveRecord,
} from '../types.js';
import { BREAK_SENTINEL, sliceFolded } from './fold.js';

export interface InlineContext {
	/** Relative to `docs/site/`. */
	file: string;
	/**
	 * Where this text came from, for status glyph recognition.
	 *
	 * `cell` is the only scope in which the em dash spelling means "not applicable", and
	 * `statusAt` additionally requires it to be the whole of the text it was handed. That
	 * pair is what keeps the em dash from being a one-character way to write a character
	 * the house rules ban.
	 */
	scope: StatusScope;
	/**
	 * What kind of text this is, for the one construct whose legality depends on it.
	 *
	 * A `:more` folds text behind a button, and a heading is read somewhere a button cannot
	 * sit: the table of contents, the search results, the page outline. Refusing it there by
	 * kind is the only way to refuse it at all, because by the time the inline parser runs
	 * the text has no other trace of where it came from.
	 */
	kind: ProseKind;
	origins: NodeOrigins;
	services: ParseServices;
	/** Appended to, never replaced: one parse of a page reports every problem it found. */
	problems: RawFinding[];
}

export interface InlineResult {
	nodes: Inline[];
	/**
	 * What a reader reads: the text nodes' own spans, concatenated, with the positions
	 * carried across.
	 *
	 * Markup delimiters, inline code, link destinations and recognised status glyphs are
	 * all absent, which is precisely what the house-style rules must and must not see.
	 * A backslash escape contributes its escaped character and not the backslash, so the
	 * prose reads as the page reads. That costs nothing in accuracy because this is a
	 * list of source ranges rather than one flat slice: the range after an escape carries
	 * its own line and column, so every character following it still reports the column
	 * it was typed at.
	 */
	prose: FoldedText;
	/**
	 * Link and image titles, each as its own run rather than spliced into `prose`.
	 *
	 * A title is text a reader meets, through a tooltip and through a screen reader, so
	 * every house-style rule has to see it; it used to reach none of them. It is not part
	 * of the sentence around it, though, and splicing its range into the paragraph's prose
	 * joins it to whatever precedes the `](`: `See [the guide](x.md "The first scan").`
	 * folds to `See the guideThe first scan.`, an adjacency no author wrote, which a phrase
	 * rule can match across and a real phrase can be split by. Its own segment has neither
	 * problem and keeps the title's real line and column.
	 */
	titles: FoldedText[];
	/**
	 * Every destination that resolved to a page or an asset, with its source ranges.
	 *
	 * Only those two kinds. An external link, a `mailto:` and a same-page `#anchor` already
	 * mean the same thing from every address a page is served at, and a destination that
	 * did not resolve is a `link-resolves` error that stops the publish, so rewriting it
	 * would only disguise the literal the author needs to find.
	 */
	destinations: ResolvedDestination[];
	/** Every `:more[...]` accepted, with the markers the raw markdown removes. */
	directives: TextDirectiveRecord[];
}

/**
 * Where a `:more` is refused because of what kind of text it is in, and how to say so.
 *
 * Paragraphs, list items, quotations and table cells take one, and a heading does not:
 * its text is the table of contents entry, the search result's title and the page
 * outline's row, and none of those can hold a button. A caption, a callout title and a
 * step title cannot either, and need no entry here, because each is a directive's label
 * and a label holds no `]`. A `:more` written in one makes the line fail the container
 * pattern and arrive as a paragraph, which the directive-label refusal below answers.
 */
const MORE_REFUSED_IN: Partial<Record<ProseKind, string>> = {
	heading: 'a heading',
};

/**
 * The text a `:more` folds, short enough to quote in a finding.
 *
 * Folded text carries the break sentinel, which would print as U+0000 in a report.
 */
function excerptOf(text: string, from: number, to: number): string {
	return text.slice(from, Math.min(to, from + 60)).replaceAll(BREAK_SENTINEL, ' ');
}

/**
 * Where an inline parse is, for the two refusals that depend on what encloses it.
 *
 * Link text cannot hold a `:more`, because the control that reveals it is a button and a
 * button inside an `<a>` is invalid HTML that no browser or screen reader can operate as
 * either. Another `:more` cannot hold one, because text that unfolds into more folded text
 * asks a reader to click twice for one passage.
 */
type Within = 'top' | 'link' | 'more';

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\]/;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Whether the character flanking an emphasis delimiter run counts as whitespace.
 *
 * The empty string counts, deliberately: the flanking rule asks about the character
 * outside the run, and at the end of the text there is none. That answer is right for
 * the two flanking tests and catastrophic anywhere a cursor advances, because
 * `text[cursor] ?? ''` past the end is `''` forever and a loop written on this predicate
 * never terminates. Use `isBlank` to advance. The distinction is not cosmetic: three skip
 * loops in `readDestination` were written on this one, and `Press [Enter] now.` hung the
 * compiler with no output rather than failing.
 */
function isSpace(character: string): boolean {
	return character === '' || /\s/.test(character) || character === BREAK_SENTINEL;
}

/** As `isSpace`, except that the end of the text is not blank, so a skip loop stops. */
function isBlank(character: string | undefined): boolean {
	return character !== undefined && (/\s/.test(character) || character === BREAK_SENTINEL);
}

/**
 * The end of a backtick code span opened at `start`, or `undefined`.
 *
 * CommonMark's rule: the closing run must be exactly as long as the opening one, so
 * ``` ``a ` b`` ``` holds a literal backtick. Getting this wrong turns an error string
 * containing a backtick into unparsed markdown halfway down a page.
 */
function codeSpanEnd(text: string, start: number, length: number): number | undefined {
	let cursor = start + length;
	while (cursor < text.length) {
		if (text[cursor] !== '`') {
			cursor += 1;
			continue;
		}
		let run = 0;
		while (text[cursor + run] === '`') run += 1;
		if (run === length) return cursor;
		cursor += run;
	}
	return undefined;
}

/**
 * The index of the `]` matching the `[` at `open`, or `undefined`.
 *
 * Skips escaped brackets and whole code spans, because a link label can legitimately
 * contain both: the corpus links a heading that is entirely inline code.
 */
function closingBracket(text: string, open: number): number | undefined {
	let depth = 0;
	let cursor = open;
	while (cursor < text.length) {
		const character = text[cursor] as string;
		if (character === '\\') {
			cursor += 2;
			continue;
		}
		if (character === '`') {
			let run = 0;
			while (text[cursor + run] === '`') run += 1;
			const end = codeSpanEnd(text, cursor, run);
			cursor = end === undefined ? cursor + run : end + run;
			continue;
		}
		if (character === '[') depth += 1;
		if (character === ']') {
			depth -= 1;
			if (depth === 0) return cursor;
		}
		cursor += 1;
	}
	return undefined;
}

interface Destination {
	href: string;
	/** The `(` the destination opens with, which the raw form is written straight after. */
	open: number;
	/**
	 * Where the destination's own characters sit: after an opening `<` and before a
	 * closing `>` when it has them, and never including a title.
	 */
	hrefRange: [number, number];
	/** The closing `>` of the angle bracket spelling, when that is the spelling. */
	bracketClose: number | undefined;
	/**
	 * Where the fragment starts, when there is one: the `#` that `splitFragment` in
	 * `links.ts` will split `href` on, or the backslash in front of it when it was typed
	 * escaped, because the escape is resolved before that split and the split cannot tell.
	 * Recorded during the one scan that resolves escapes, since a second scan of the raw
	 * characters would have to agree with this one about every escape to find it.
	 */
	fragmentAt: number | undefined;
	title: string | undefined;
	/**
	 * Where the title's text sits, excluding the quotes.
	 *
	 * Carried so the caller can add it to the prose. A link title and an image title are
	 * both shown to a reader, by a tooltip and by a screen reader, and neither reached a
	 * prose segment: `[the guide](guide.md "Read this first \u2014 it is short")` shipped an
	 * em dash that `no-em-dash` could not see, in text the house rules govern.
	 */
	titleRange: [number, number] | undefined;
	end: number;
}

/**
 * Reads `(dest "title")` starting at the opening parenthesis, or `undefined`.
 *
 * The first line is the whole contract, and it used to be a precondition this comment
 * asserted and nothing established. Both callers pass the index straight after a `]`,
 * which is not necessarily a `(`: without the check, `Press [Enter] first-tag.md) and
 * stop.` published a link the author never wrote to a page they never named, and `The tag
 * ID (see [chip matrix] below) is printed` reported `"below" resolves to no page` and
 * refused to publish an ordinary sentence.
 *
 * Parentheses inside the destination are balanced rather than forbidden, because a real
 * documentation link points at Wikipedia eventually.
 */
function readDestination(text: string, open: number): Destination | undefined {
	if (text[open] !== '(') return undefined;

	let cursor = open + 1;
	while (isBlank(text[cursor])) cursor += 1;

	let href = '';
	let hrefRange: [number, number];
	let bracketClose: number | undefined;
	let fragmentAt: number | undefined;
	if (text[cursor] === '<') {
		const end = text.indexOf('>', cursor);
		if (end === -1) return undefined;
		href = text.slice(cursor + 1, end);
		hrefRange = [cursor + 1, end];
		bracketClose = end;
		const hash = href.indexOf('#');
		fragmentAt = hash === -1 ? undefined : cursor + 1 + hash;
		cursor = end + 1;
	} else {
		const start = cursor;
		let depth = 0;
		while (cursor < text.length) {
			const character = text[cursor] as string;
			if (character === '\\') {
				if (text[cursor + 1] === '#' && fragmentAt === undefined) fragmentAt = cursor;
				href += text[cursor + 1] ?? '';
				cursor += 2;
				continue;
			}
			if (isBlank(character)) break;
			if (character === '(') depth += 1;
			if (character === ')') {
				if (depth === 0) break;
				depth -= 1;
			}
			if (character === '#' && fragmentAt === undefined) fragmentAt = cursor;
			href += character;
			cursor += 1;
		}
		hrefRange = [start, cursor];
	}

	while (isBlank(text[cursor])) cursor += 1;

	let title: string | undefined;
	let titleRange: [number, number] | undefined;
	const quote = text[cursor];
	if (quote === '"' || quote === "'") {
		const end = text.indexOf(quote, cursor + 1);
		if (end === -1) return undefined;
		title = text.slice(cursor + 1, end);
		titleRange = [cursor + 1, end];
		cursor = end + 1;
		while (isBlank(text[cursor])) cursor += 1;
	}

	if (text[cursor] !== ')') return undefined;
	return { href, open, hrefRange, bracketClose, fragmentAt, title, titleRange, end: cursor + 1 };
}

/** The literal text of a label, with escapes resolved. Alt text is a string, not nodes. */
function literalText(text: string, start: number, end: number): string {
	let value = '';
	let cursor = start;
	while (cursor < end) {
		const character = text[cursor] as string;
		if (character === '\\' && PUNCTUATION.test(text[cursor + 1] ?? '')) {
			value += text[cursor + 1] as string;
			cursor += 2;
			continue;
		}
		value += character === BREAK_SENTINEL ? ' ' : character;
		cursor += 1;
	}
	return value;
}

export function parseInline(folded: FoldedText, context: InlineContext): InlineResult {
	const { text } = folded;
	const proseRanges: [number, number][] = [];
	const titles: FoldedText[] = [];
	const destinations: ResolvedDestination[] = [];
	const directives: TextDirectiveRecord[] = [];

	/**
	 * Records a resolved destination: where its raw form goes, and what the author's
	 * spelling of the path occupied.
	 *
	 * The raw form is written straight after the `(`, and everything from there to the end
	 * of the path is removed, with the closing `>` of the angle bracket spelling. That puts
	 * the token immediately after `](` in every spelling this parser accepts, which is the
	 * one pattern a site substitutes on (`RAW_PAGE_LINK` says so). Keeping the author's
	 * `<` or a space after the `(` would leave a token the substitution never finds, and it
	 * would be served to a reader as `hexdocs:page/...`. What survives after the path is a
	 * fragment and a title, byte for byte. Dropping the brackets is safe for the fragment
	 * because a fragment that needed them, one holding a space or a parenthesis, names no
	 * heading id, and `anchor-resolves` reports it, as an error unless a project lowered it.
	 *
	 * The removal goes through `sliceFolded`, the one function that already maps a folded
	 * range back to source lines, so a destination crossing a wrap gets a range per line
	 * rather than one range whose length runs off the end of the first. The insertion point
	 * is taken from the `(` itself rather than from the offset after it, because that
	 * offset can be a joiner, which `positionAt` places on the next line.
	 */
	const recordDestination = (
		destination: Destination,
		pathEnd: number,
		target: ResolvedDestination['target'],
	): void => {
		const paren = positionAt(folded, context.file, destination.open);
		const spans: [number, number][] = [[destination.open + 1, pathEnd]];
		if (destination.bracketClose !== undefined) {
			spans.push([destination.bracketClose, destination.bracketClose + 1]);
		}
		const remove = sliceFolded(folded, spans).runs.map((run) => ({
			line: run.line,
			column: run.column,
			length: run.length,
		}));
		destinations.push({ at: { line: paren.line, column: paren.column + 1 }, remove, target });
	};
	// One per call, because it is keyed by offsets into this `text` and nothing else.
	const emphasisCache: EmphasisCache = new Map();

	const at = (offset: number): { kind: 'file'; file: string; line: number; column: number } => {
		const position = positionAt(folded, context.file, offset);
		return { kind: 'file', file: position.file, line: position.line, column: position.column };
	};

	/**
	 * Parses `[start, end)`.
	 *
	 * Recursive rather than a delimiter stack. That is a real trade and this comment used
	 * to describe it as a free one, saying the stack exists for cases this subset does not
	 * have. It does not: bold italic and emphasis nested inside emphasis are both in the
	 * corpus, and the first version of this recursion published their delimiters as text.
	 * Two rules bring it back into agreement with the stack over the nesting a real page
	 * contains: a run of three is an emphasis wrapping a strong, and a run that declines to
	 * close is skipped by the whole span it opens rather than by its own width. What is
	 * still outside the subset, a run of four or more, is refused by name with a line.
	 * Recursion over a matched pair is checkable by reading it, which is what buys those
	 * two rules the right to be stated rather than derived.
	 */
	const parse = (start: number, end: number, within: Within = 'top'): Inline[] => {
		const nodes: Inline[] = [];
		let pending = '';
		let pendingRanges: [number, number][] = [];

		const take = (from: number, to: number): void => {
			if (to <= from) return;
			pending += text.slice(from, to);
			const last = pendingRanges.at(-1);
			if (last !== undefined && last[1] === from) last[1] = to;
			else pendingRanges.push([from, to]);
		};

		const flush = (): void => {
			if (pending === '') return;
			const node: TextNode = { type: 'text', value: pending };
			const first = pendingRanges[0] as [number, number];
			context.origins.set(node, positionAt(folded, context.file, first[0]));
			nodes.push(node);
			proseRanges.push(...pendingRanges);
			pending = '';
			pendingRanges = [];
		};

		const push = (node: Inline, offset: number): void => {
			flush();
			context.origins.set(node, positionAt(folded, context.file, offset));
			nodes.push(node);
		};

		let cursor = start;
		let textFrom = start;

		const literal = (upto: number): void => {
			take(textFrom, upto);
		};

		/**
		 * `:name[` at the cursor: a `:more` accepted, a `:more` refused with its words kept,
		 * or an unknown name refused and left literal. Returns whether it consumed anything,
		 * so the caller only advances past the colon when nothing was there.
		 */
		const textDirective = (): boolean => {
			const opening = textDirectiveAt(text, cursor);
			if (opening === undefined) return false;
			const refuse = (message: string, remediation: string): void => {
				context.problems.push(
					raw('unsupported-syntax', at(cursor), null, message, {
						remediation,
						excerpt: excerptOf(text, cursor, end),
					}),
				);
			};

			// An unknown name stays literal, colon and all, and the bracket after it is scanned
			// as it would have been, so a link inside it still parses. The page shows what was
			// typed, which is what the four-asterisk refusal does for the same reason.
			if (!isTextDirective(opening.name)) {
				refuse(
					`":${opening.name}[" is not an inline directive this AST major carries. The only one is ":${TEXT_DIRECTIVE_NAMES.join('[...]", ":')}[...]".`,
					isContainerDirective(opening.name)
						? `"${opening.name}" is a container: open it on a line of its own with three colons and close it with three.`
						: 'Check the spelling. If the colon is meant literally, escape it as "\\:" or put the text in backticks.',
				);
				cursor = opening.open;
				return true;
			}

			const close = closingBracket(text, opening.open);
			if (close === undefined || close >= end) {
				refuse(
					`A ":${opening.name}[" with no "]" to close it.`,
					'Close it with "]". A "]" inside it that is not the end of a link has to be escaped as "\\]".',
				);
				cursor = opening.open + 1;
				return true;
			}

			const body = text.slice(opening.open + 1, close).replaceAll(BREAK_SENTINEL, ' ');
			const where = MORE_REFUSED_IN[context.kind];
			let refused = true;
			// Whether the raw markdown drops the markers. It does for every `:more` whose words
			// the page keeps, refused or not, because that is what the payload holds and because
			// a refused one left in the text can come back: `:more[a :more[b] c]` lowers its outer
			// markers, and an inner `:more[b]` left as typed reads as an accepted one on the
			// reread. The one exception is the directive label, where removing them would write
			// the container line the label case exists to refuse.
			let lower = true;
			if (within === 'link') {
				refuse(
					`A ":${opening.name}[...]" inside link text.`,
					'Move it after the link. The control that reveals it is a button, and a button inside a link is two controls in one, which no browser or screen reader can operate as either.',
				);
			} else if (within === 'more') {
				refuse(
					`A ":${opening.name}[...]" inside another ":${opening.name}[...]".`,
					'Write the inner text plainly. Folded text that unfolds into more folded text asks the reader to click twice for one passage.',
				);
			} else if (where !== undefined) {
				refuse(
					`A ":${opening.name}[...]" inside ${where}.`,
					'Put it in the paragraph that follows. A heading is read as a label in places a button cannot sit: the table of contents, the search results and the page outline.',
				);
			} else if (context.kind === 'paragraph' && /^:{2,}[a-z]/.test(text)) {
				// `:::note[x :more[y]]` fails the container pattern, whose label holds no
				// bracket, and arrives here as a paragraph. Accepting the `:more` would lower to
				// `:::note[x y]`, which is a container, so the raw markdown would grow a
				// directive the page does not have. Refused by name instead of becoming a
				// paragraph that shows its own markers.
				refuse(
					`A ":${opening.name}[...]" inside a directive's label.`,
					'A label is plain text and holds no brackets, so neither a link nor a ":more" can sit in one. Put the folded text in the first paragraph inside the container.',
				);
				lower = false;
			} else if (body.trim() === '') {
				refuse(
					`An empty ":${opening.name}[]".`,
					'Put the folded text inside it, or delete it. An empty one draws a question mark that reveals nothing.',
				);
			} else if (text[close + 1] === '{') {
				refuse(
					`":${opening.name}[...]" takes no attributes.`,
					"Delete the {...}. remark-directive's attribute syntax is not part of this grammar: there is nothing an author could put in it that the page would honour.",
				);
			} else {
				refused = false;
			}

			literal(cursor);
			// Flushed before recursing, for the reason the link branch gives: the child parse
			// appends its own prose ranges, and a pending run flushed afterwards would arrive
			// out of order.
			flush();
			if (lower) {
				const colon = positionAt(folded, context.file, cursor);
				directives.push({
					kind: 'text',
					name: opening.name,
					at: { line: colon.line, column: colon.column },
					remove: sliceFolded(folded, [
						[cursor, opening.open + 1],
						[close, close + 1],
					]).runs.map((run) => ({ line: run.line, column: run.column, length: run.length })),
				});
			}
			if (refused) {
				// The words survive and the fold does not, the way an unresolved link keeps its
				// text. Parsed at the enclosing level, so a refusal is reported once rather than
				// again for every `:more` the refused one holds.
				nodes.push(...parse(opening.open + 1, close, within));
			} else {
				push({ type: 'more', children: parse(opening.open + 1, close, 'more') }, cursor);
			}
			cursor = close + 1;
			textFrom = cursor;
			return true;
		};

		while (cursor < end) {
			const character = text[cursor] as string;

			if (character === BREAK_SENTINEL) {
				literal(cursor);
				push({ type: 'break' }, cursor);
				cursor += 1;
				textFrom = cursor;
				continue;
			}

			if (character === '\\' && PUNCTUATION.test(text[cursor + 1] ?? '')) {
				literal(cursor);
				take(cursor + 1, cursor + 2);
				cursor += 2;
				textFrom = cursor;
				continue;
			}

			if (character === '`') {
				let run = 0;
				while (text[cursor + run] === '`') run += 1;
				const close = codeSpanEnd(text, cursor, run);
				if (close !== undefined && close < end) {
					literal(cursor);
					// A hard break inside a code span is a space: the span is one run of code
					// and a sentinel left in it would reach the renderer as U+0000.
					let value = text.slice(cursor + run, close).replaceAll(BREAK_SENTINEL, ' ');
					if (
						value.length > 2 &&
						value.startsWith(' ') &&
						value.endsWith(' ') &&
						value.trim() !== ''
					) {
						value = value.slice(1, -1);
					}
					push({ type: 'inlineCode', value }, cursor);
					cursor = close + run;
					textFrom = cursor;
					continue;
				}
				cursor += run;
				continue;
			}

			if (character === '!' && text[cursor + 1] === '[') {
				const close = closingBracket(text, cursor + 1);
				const destination = close === undefined ? undefined : readDestination(text, close + 1);
				if (close !== undefined && destination !== undefined && destination.end <= end) {
					literal(cursor);
					const alt = literalText(text, cursor + 2, close);
					const resolved = context.services.resolveImage(destination.href);
					if (resolved.ok) {
						const image: ImageNode = {
							type: 'image',
							src: resolved.src,
							alt,
							width: resolved.width,
							height: resolved.height,
							...(destination.title === undefined ? {} : { title: destination.title }),
						};
						push(image, cursor);
						recordDestination(destination, destination.hrefRange[1], {
							kind: 'asset',
							src: resolved.src,
						});
						// The alt text is prose a reader hears, so it is scanned like any other
						// prose. Its range is the label's, which is why it is added here rather
						// than by the text path that never sees it. The title is the same case,
						// one field along, and it was the one that got missed.
						proseRanges.push([cursor + 2, close]);
						if (destination.titleRange !== undefined) {
							titles.push(sliceFolded(folded, [destination.titleRange]));
						}
					} else {
						context.problems.push(
							raw('link-resolves', at(cursor), null, resolved.message, {
								remediation: resolved.remediation,
								excerpt: destination.href,
							}),
						);
						take(cursor + 2, close);
					}
					cursor = destination.end;
					textFrom = cursor;
					continue;
				}
				cursor += 1;
				continue;
			}

			if (character === ':') {
				if (!textDirective()) cursor += 1;
				continue;
			}

			if (character === '[') {
				const close = closingBracket(text, cursor);
				const destination = close === undefined ? undefined : readDestination(text, close + 1);
				if (close !== undefined && destination !== undefined && destination.end <= end) {
					literal(cursor);
					// Flushed before recursing, not after. The child parse appends its own text
					// ranges to the shared prose list, and `sliceFolded` refuses ranges that go
					// backwards, so a pending run flushed afterwards would arrive out of order
					// and take the whole page down with a range error.
					flush();
					const resolved = context.services.resolveLink(destination.href, destination.title);
					const children = parse(cursor + 1, close, 'link');
					if (resolved.ok) {
						const link = { ...resolved.link, children } as Link;
						push(link, cursor);
						if (resolved.link.kind === 'internal') {
							recordDestination(destination, destination.fragmentAt ?? destination.hrefRange[1], {
								kind: 'page',
								slug: resolved.link.slug,
							});
						}
					} else {
						context.problems.push(
							raw('link-resolves', at(cursor), null, resolved.message, {
								remediation: resolved.remediation,
								excerpt: destination.href,
							}),
						);
						// The words survive and the link does not. A bundle carrying an
						// unresolved link would publish a link to a 404 that renders as a link;
						// `link-resolves` is an error, so nothing publishes either way, and this
						// is what keeps the tree valid for the lint run that reports it.
						flush();
						nodes.push(...children);
					}
					if (destination.titleRange !== undefined) {
						titles.push(sliceFolded(folded, [destination.titleRange]));
					}
					cursor = destination.end;
					textFrom = cursor;
					continue;
				}
				cursor += 1;
				continue;
			}

			if (character === '*' || character === '_' || character === '~') {
				const emphasis = readEmphasis(text, cursor, end, character, emphasisCache);
				if (emphasis !== undefined) {
					literal(cursor);
					flush();
					const parsed = parse(emphasis.innerStart, emphasis.innerEnd, within);
					// Innermost first: a run of three is `emphasis[strong[...]]`, which is what
					// CommonMark makes of bold italic and what a reader expects `***x***` to be.
					const children: Inline[] =
						emphasis.inner === undefined ? parsed : [{ type: 'strong', children: parsed }];
					const node: Inline =
						emphasis.type === 'strong'
							? { type: 'strong', children }
							: emphasis.type === 'emphasis'
								? { type: 'emphasis', children }
								: { type: 'strikethrough', children };
					push(node, cursor);
					cursor = emphasis.end;
					textFrom = cursor;
					continue;
				}

				// A run of four or more opening here is refused by name rather than clamped.
				// The delimiters stay literal so the page shows what was typed, and the
				// finding carries the line, which is the whole difference between this and
				// the version that published a stray asterisk inside a bold span.
				const run = delimiterRun(text, cursor, character);
				if (run > 3 && character !== '~' && !isSpace(text[cursor + run] ?? '')) {
					context.problems.push(
						raw(
							'unsupported-syntax',
							at(cursor),
							null,
							`A run of ${run} "${character}" characters is not an emphasis spelling this AST major carries.`,
							{
								remediation:
									'Use one for emphasis, two for strong, or three for both. Four or more has no unambiguous reading, so it is refused rather than guessed at.',
								excerpt: text.slice(cursor, cursor + run + 10),
							},
						),
					);
					cursor += run;
					continue;
				}
				cursor += 1;
				continue;
			}

			const status = statusAt(text, cursor, context.scope);
			if (status !== undefined) {
				literal(cursor);
				push({ type: 'status', value: status.value }, cursor);
				cursor += status.length;
				textFrom = cursor;
				continue;
			}

			cursor += 1;
		}

		literal(end);
		flush();
		return nodes;
	};

	const nodes = parse(0, text.length);
	return { nodes, prose: sliceFolded(folded, proseRanges), titles, destinations, directives };
}

interface EmphasisMatch {
	type: 'emphasis' | 'strong' | 'strikethrough';
	/**
	 * Set only by a run of three, which CommonMark makes an emphasis wrapping a strong.
	 *
	 * Carried as one optional field rather than a list because three is the widest run
	 * this parser accepts: four or more is refused by name at the call site.
	 */
	inner?: 'strong';
	innerStart: number;
	innerEnd: number;
	end: number;
}

/** The length of the delimiter run starting at `start`. */
function delimiterRun(text: string, start: number, delimiter: string): number {
	let run = 0;
	while (text[start + run] === delimiter) run += 1;
	return run;
}

/**
 * One `parseInline` call's memo of `matchEmphasis`, keyed by its three varying arguments.
 *
 * Not an optimisation. `matchEmphasis` descends into every run that declines to close, so
 * without the memo a line of unmatched openers costs exponential time: `*a ` twenty times
 * took 49ms and forty times did not finish. Measured after adding it: twenty repeats
 * 0.6ms, four hundred repeats 12ms. A page is compiled once per locale in a publish
 * workflow with no output until it finishes, so a paragraph of stray asterisks has to
 * cost what a paragraph costs.
 */
type EmphasisCache = Map<string, EmphasisMatch | undefined>;

function readEmphasis(
	text: string,
	start: number,
	end: number,
	delimiter: string,
	cache: EmphasisCache,
): EmphasisMatch | undefined {
	const key = `${start}:${end}:${delimiter}`;
	// `has` rather than a truthiness test, because `undefined` is the answer worth caching
	// most: it is what every declined run returns and what the blowup recomputed.
	if (cache.has(key)) return cache.get(key);
	const match = matchEmphasis(text, start, end, delimiter, cache);
	cache.set(key, match);
	return match;
}

/**
 * Matches an emphasis, strong or strikethrough span opening at `start`.
 *
 * Strong is tried before emphasis, which is the whole of why `**bold**` is not an
 * emphasis containing an emphasised empty string. A run of three is bold italic, an
 * emphasis wrapping a strong, which is what CommonMark produces. Strikethrough is exactly
 * two tildes: one tilde is a literal character that appears in paths and in approximate
 * figures.
 *
 * A run of four or more returns `undefined` so the call site can refuse it by name. The
 * clamping version accepted it and compiled `****a****` to a strong whose text began with
 * a literal asterisk, which is the silent failure the refusal replaces.
 */
function matchEmphasis(
	text: string,
	start: number,
	end: number,
	delimiter: string,
	cache: EmphasisCache,
): EmphasisMatch | undefined {
	const run = delimiterRun(text, start, delimiter);

	const before = start === 0 ? '' : (text[start - 1] as string);
	const after = text[start + run] ?? '';
	if (isSpace(after)) return undefined;
	// An underscore between alphanumerics is a character in an identifier, not a
	// delimiter. Without this, `FIXTURE_TAG_LOG` in prose becomes emphasised text and the
	// underscores vanish from the page.
	if (delimiter === '_' && ALPHANUMERIC.test(before)) return undefined;

	if (delimiter === '~' && run !== 2) return undefined;
	if (delimiter !== '~' && run > 3) return undefined;
	const width = delimiter === '~' ? 2 : run;
	const type =
		delimiter === '~'
			? ('strikethrough' as const)
			: width === 2
				? ('strong' as const)
				: ('emphasis' as const);
	const inner = width === 3 ? ('strong' as const) : undefined;

	let cursor = start + width;
	while (cursor < end) {
		const character = text[cursor] as string;
		if (character === '\\') {
			cursor += 2;
			continue;
		}
		if (character === '`') {
			let ticks = 0;
			while (text[cursor + ticks] === '`') ticks += 1;
			const close = codeSpanEnd(text, cursor, ticks);
			cursor = close === undefined ? cursor + ticks : close + ticks;
			continue;
		}
		if (character !== delimiter) {
			cursor += 1;
			continue;
		}
		let closing = 0;
		while (text[cursor + closing] === delimiter) closing += 1;
		const previous = text[cursor - 1] as string;
		const following = text[cursor + closing] ?? '';
		const closes =
			closing >= width &&
			!isSpace(previous) &&
			(delimiter !== '_' || !ALPHANUMERIC.test(following)) &&
			cursor > start + width;
		if (closes) {
			return { type, inner, innerStart: start + width, innerEnd: cursor, end: cursor + width };
		}
		// A run that declines to close here is opening something of its own, and skipping
		// only the run leaves that span's closing delimiters in front of this scan to be
		// taken as its own. `*italic **and bold** here*` returned at the inner strong's
		// closing run, so the strong was lost, four delimiter characters were published as
		// text, and no finding said so. Skipping the whole span it opens is what makes the
		// recursion agree with CommonMark's delimiter stack on the nesting a real page has.
		const nested = readEmphasis(text, cursor, end, delimiter, cache);
		cursor = nested === undefined ? cursor + closing : nested.end;
	}
	return undefined;
}
