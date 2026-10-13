/**
 * Directive syntax, written out as the plain markdown it stands for.
 *
 * The markdown served at `<slug>.md`, and every page of it joined into `llms-full.txt`,
 * is read by agents and by anything else that speaks CommonMark or GitHub's dialect of
 * it. The source speaks a little more than that: remark-directive's containers for
 * procedures, callouts, figures and table captions, GitHub's alert marker, and `{#id}`
 * after a heading. None of those mean anything to a reader that is not this compiler,
 * and before this module they reached every agent that fetched a page verbatim: hex-nfc's
 * first bundle carried 378 lines of `:::` and eleven literal `{#id}` suffixes.
 *
 * What each one becomes, chosen so the plain text says what the rendered page shows:
 *
 * - `steps` is an ordered list. Each `step` is an item whose first line is its title in
 *   bold, with the step's body indented under it.
 * - A callout, in either spelling, is a quotation that opens with its label in bold, in
 *   the page's language: `> **Warning:**` running into the first paragraph when the
 *   callout has no title, and `> **Warning: Keep the password**` on a line of its own when
 *   it has one. The rendered page shows a title in place of the label. The label stays
 *   here because a model reading text has no colour and no icon to say which kind of
 *   callout it is inside, and a warning read as a note is the expensive mistake.
 * - A caption is a bold line where the rendered page puts it: before a table, and after a
 *   figure's image.
 * - `{#id}` goes from the end of its heading. The only way to keep the anchor in plain
 *   markdown would be an `<a id>` before the heading, and raw HTML is the one thing this
 *   package never publishes: the source refuses it with `no-raw-html`, and the raw
 *   markdown is held to the same rule. The anchor still exists on the rendered page, which
 *   is where a link with a fragment is followed.
 * - A container the parser refused, by name or by shape, loses its markers and keeps its
 *   contents, which is what the page payload does with it. The refusal is an
 *   `unsupported-syntax` error, which no project can lower, so that build fails anyway;
 *   what this decides is only that no `:::` reaches a bundle even on the way to failing.
 *
 * It works on the source lines, from the parser's own records of where each directive
 * sat, rather than by printing the tree. Printing the tree would be a second spelling of
 * every construct in the AST, and would rewrap every paragraph, respell every emphasis
 * and realign every table, where this changes the directive lines and the start of the
 * lines inside them and nothing else. The records are the parser's, for the reason the
 * link rewrite uses the parser's ranges: a second reading of the lines would disagree
 * with the first about fences, quotations and list items, and the disagreement would
 * publish.
 *
 * `assertLowered` is the last line of defence and it reads the result with that same
 * parser. Anything the parser would still take for a directive is a defect here, and it
 * stops the build rather than publishing.
 */

import type { Callout, CalloutKind, Step } from '../../../src/contracts/ast.js';
import type { Locale } from '../../../src/contracts/locales.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';
import {
	CALLOUT_ALERT_PATTERN,
	CONTAINER_DIRECTIVE_PATTERN,
	DIRECTIVE_CLOSE_PATTERN,
	EXPLICIT_HEADING_ID_PATTERN,
	LEAF_DIRECTIVE_PATTERN,
} from '../../../src/contracts/source.js';
import { calloutLabel } from '../../../src/ui/strings.js';

import { parseDocument } from './markdown/index.js';
import type {
	ContainerRecord,
	DirectiveRecord,
	NodeOrigins,
	ParseServices,
	SourcePoint,
} from './types.js';

/** What lowering one file needs besides its lines. */
export interface RawLowering {
	/** The page's language. A callout's default label is written in it, as the rendered page writes it. */
	locale: Locale;
	/** Relative to `docs/site/`. The file the records and the origins were taken from. */
	file: string;
	directives: readonly DirectiveRecord[];
	/** The parse's origins, which say where a table and a callout's first paragraph start. */
	origins: NodeOrigins;
	/**
	 * Snippet bodies by id, already raw and already lowered, for every `::include` the parse
	 * expanded. Empty for a snippet, which cannot include anything.
	 */
	snippetBodies: ReadonlyMap<string, string>;
}

/**
 * The colon after a callout's label, as each language punctuates one: full width with no
 * space after it in Chinese and Japanese, and after a no-break space in French.
 */
const LABEL_PUNCTUATION: Record<Locale, { colon: string; gap: string }> = {
	en: { colon: ':', gap: ' ' },
	zh: { colon: '\uff1a', gap: '' },
	ar: { colon: ':', gap: ' ' },
	es: { colon: ':', gap: ' ' },
	ja: { colon: '\uff1a', gap: '' },
	fr: { colon: '\u00a0:', gap: ' ' },
	'pt-BR': { colon: ':', gap: ' ' },
};

/** `**Warning:**`, or `**Warning: The title**`, in the page's language. */
export function calloutLead(locale: Locale, kind: CalloutKind, title?: string): string {
	const { colon, gap } = LABEL_PUNCTUATION[locale];
	const label = calloutLabel(locale, kind);
	return title === undefined ? `**${label}${colon}**` : `**${label}${colon}${gap}${title}**`;
}

/**
 * A line a directive writes, relative to the line it replaces: the text goes after
 * whatever the containers around that line put at its start, and `''` is a blank line in
 * that context, which is `>` inside a quotation.
 */
interface Written {
	text: string;
	/**
	 * A blank line this module added to keep two blocks apart. It is kept only where
	 * nothing else already does that: every lowered block is fenced with one on each side,
	 * because the parser lets a directive interrupt a paragraph and CommonMark does not let
	 * a bold line or an image do the same, and most of the time the author's own blank line
	 * makes it redundant.
	 */
	soft: boolean;
}

const line = (text: string): Written => ({ text, soft: false });
/** A blank line in the context of the line being replaced. */
const SEPARATOR: Written = { text: '', soft: true };
/** A blank line inside the quotation a callout is about to open. */
const QUOTE_SEPARATOR: Written = { text: '>', soft: true };

/**
 * What a container adds to the start of a line inside it, at the column its content
 * starts on that line.
 *
 * `floor` is the column the container's own content starts at, which is where the prefix
 * goes on a blank line. A blank line carries no indent to measure, and inside a list item
 * the parser hands a container a blank line at column one, so a quotation in a list item
 * would otherwise put its `>` at the margin and close the list. `rank` is the line the
 * container opened on, which puts an outer container's prefix before an inner one's at
 * the same column. A callout's label running into its first paragraph is ranked after
 * every container, because it is the start of the paragraph rather than a prefix to it.
 */
interface Prefix {
	column: number;
	floor: number;
	text: string;
	rank: number;
}

interface LinePlan {
	prefixes: Prefix[];
	/** The line's own content from `column` on, replaced. `shape` is what that content must be. */
	replace: { column: number; written: Written[]; shape: RegExp | undefined } | undefined;
	/** Lines written before this one, in its context. */
	before: { column: number; written: Written[] } | undefined;
	/** The heading's `{#id}` comes off the end. */
	stripId: boolean;
}

/**
 * `text` with every directive its parse recorded written out as plain markdown.
 *
 * `text` must be the text the records were taken from, with links already rewritten and
 * comments already blanked, line for line: every record is a line number and a column
 * into it. A record that does not fit its line is thrown over rather than applied, as
 * `rewriteDestinations` does, because it means the parse and the text disagree and
 * applying it would splice a list marker or a quotation into whatever is really there.
 */
export function lowerDirectives(text: string, firstLine: number, lowering: RawLowering): string {
	const plans = planLines(lowering);
	const lines = text.split('\n');
	const output: Written[] = [];

	for (const [index, source] of lines.entries()) {
		const number = firstLine + index;
		const plan = plans.get(number);
		if (plan === undefined) {
			output.push(line(source));
			continue;
		}
		plans.delete(number);
		output.push(...applyPlan(source, number, plan, lowering.file));
	}

	const [stray] = plans.keys();
	if (stray !== undefined) {
		throw new Error(
			`lowerDirectives: a directive recorded at line ${stray} of ${lowering.file} is outside the ${lines.length} lines it was handed, starting at line ${firstLine}. ` +
				'The raw markdown and the page payload would disagree about what this page holds.',
		);
	}
	return settle(output)
		.map((written) => written.text)
		.join('\n');
}

function planLines(lowering: RawLowering): Map<number, LinePlan> {
	const plans = new Map<number, LinePlan>();
	const planOf = (number: number): LinePlan => {
		let plan = plans.get(number);
		if (plan === undefined) {
			plan = { prefixes: [], replace: undefined, before: undefined, stripId: false };
			plans.set(number, plan);
		}
		return plan;
	};
	const replace = (at: SourcePoint, written: Written[], shape?: RegExp): void => {
		const plan = planOf(at.line);
		if (plan.replace !== undefined) {
			throw new Error(
				`lowerDirectives: two directives claim line ${at.line} of ${lowering.file}. The parser consumes a line once, so its records disagree with each other.`,
			);
		}
		plan.replace = { column: at.column, written, shape };
	};
	const prefix = (record: ContainerRecord, text: string): void => {
		const floor = record.open.column;
		const rank = record.open.line;
		const covered = new Set<number>();
		for (const point of record.inner) {
			covered.add(point.line);
			planOf(point.line).prefixes.push({ column: point.column, floor, text, rank });
		}
		// A run of blank lines inside a list item reaches the parser as one, so the others
		// are in no container's inner lines. They are inside this one all the same, and a
		// blank line with no `>` in the middle of a quotation ends it.
		const last = record.close?.line ?? (record.inner.at(-1)?.line ?? record.open.line) + 1;
		for (let number = record.open.line + 1; number < last; number += 1) {
			if (!covered.has(number)) {
				planOf(number).prefixes.push({ column: floor, floor, text, rank });
			}
		}
	};
	/**
	 * Puts an untitled callout's label at the start of its first paragraph, which is how
	 * "**Note:**" reads in plain markdown, and says whether it could. It cannot when the
	 * callout opens with a list, a fence or a table, which a label must not run into, or
	 * with a paragraph from a snippet, whose lines are not in this text.
	 */
	const leadInto = (callout: Callout, lead: string): boolean => {
		const first = callout.children[0];
		if (first?.type !== 'paragraph') return false;
		const origin = lowering.origins.get(first);
		if (origin === undefined || origin.file !== lowering.file) return false;
		// The space is not decoration. A closing `**` straight after a full-width colon and
		// before a letter is not a closing delimiter to CommonMark, so without it the
		// Chinese and Japanese labels would not be bold at all.
		planOf(origin.line).prefixes.push({
			column: origin.column,
			floor: origin.column,
			text: `${lead} `,
			rank: Number.POSITIVE_INFINITY,
		});
		return true;
	};

	// Every step's number, before any step is written.
	const ordinals = new Map<Step, number>();
	for (const record of lowering.directives) {
		if (record.kind !== 'container' || record.node?.type !== 'steps') continue;
		for (const [index, step] of record.node.children.entries()) ordinals.set(step, index + 1);
	}

	for (const record of lowering.directives) {
		switch (record.kind) {
			case 'container': {
				const node = record.node;
				const title = record.label?.trim() ?? '';
				const markers = (opening: Written[], closing: Written[]): void => {
					replace(record.open, opening, CONTAINER_DIRECTIVE_PATTERN);
					if (record.close !== undefined) replace(record.close, closing, DIRECTIVE_CLOSE_PATTERN);
				};
				if (node === undefined) {
					// Refused, by name or by shape. The contents stay as ordinary blocks, as they
					// do in the page payload, and the finding that refused it fails the build.
					markers([SEPARATOR], [SEPARATOR]);
					break;
				}
				switch (node.type) {
					case 'callout': {
						// `title` is only set when the label had something in it, which is also when
						// the rendered page shows it in place of the default label. A title is a
						// line of its own, as it is on the page; a bare label runs into the text.
						const titled = node.title !== undefined && title !== '';
						const lead = calloutLead(lowering.locale, node.kind, titled ? title : undefined);
						const ranInto = !titled && leadInto(node, lead);
						const opening = ranInto ? [SEPARATOR] : [SEPARATOR, line(`> ${lead}`), QUOTE_SEPARATOR];
						markers(opening, [SEPARATOR]);
						prefix(record, '> ');
						break;
					}
					case 'steps':
						// The list is the steps inside it. The container itself writes nothing.
						markers([SEPARATOR], [SEPARATOR]);
						break;
					case 'step': {
						const ordinal = ordinals.get(node);
						if (ordinal === undefined) {
							throw new Error(
								`lowerDirectives: the step at line ${record.open.line} of ${lowering.file} compiled to a step that no steps container holds.`,
							);
						}
						const marker = `${ordinal}.`;
						markers(
							[SEPARATOR, line(title === '' ? marker : `${marker} **${title}**`), SEPARATOR],
							[SEPARATOR],
						);
						// The body is indented to the item's content, which is the marker's width
						// and one space, so every block in it continues the list item.
						prefix(record, ' '.repeat(marker.length + 1));
						break;
					}
					case 'figure': {
						const caption =
							node.caption === undefined || title === ''
								? []
								: [SEPARATOR, line(`**${title}**`), SEPARATOR];
						// After the image, where the page puts its caption, unless there is no close
						// to put it at, which the parser has already reported.
						if (record.close === undefined) markers([SEPARATOR, ...caption], []);
						else markers([SEPARATOR], [...caption, SEPARATOR]);
						break;
					}
					case 'table': {
						markers([SEPARATOR], [SEPARATOR]);
						if (node.caption === undefined || title === '') break;
						const origin = lowering.origins.get(node);
						if (origin === undefined || origin.file !== lowering.file) {
							throw new Error(
								`lowerDirectives: the table captioned at line ${record.open.line} of ${lowering.file} has no position in it.`,
							);
						}
						// Before the table, where the page puts its caption.
						const plan = planOf(origin.line);
						plan.before = {
							column: origin.column,
							written: [SEPARATOR, line(`**${title}**`), SEPARATOR],
						};
						break;
					}
					default:
						return unhandled(node, lowering.file);
				}
				break;
			}
			case 'alert': {
				// The marker goes, and its label runs into the first paragraph or takes the
				// marker's line, inside the quotation the marker already opens.
				const lead = calloutLead(lowering.locale, record.node.kind);
				replace(
					record.at,
					leadInto(record.node, lead) ? [SEPARATOR] : [line(lead), SEPARATOR],
					CALLOUT_ALERT_PATTERN,
				);
				break;
			}
			case 'include': {
				if (!record.expanded) {
					replace(record.at, [SEPARATOR], LEAF_DIRECTIVE_PATTERN);
					break;
				}
				const body = lowering.snippetBodies.get(record.id);
				if (body === undefined) {
					throw new Error(
						`lowerDirectives: the parse expanded "${record.id}" at line ${record.at.line} of ${lowering.file} and there is no raw body for it. ` +
							'The raw markdown would be missing a fragment the page payload has.',
					);
				}
				replace(
					record.at,
					[SEPARATOR, ...body.split('\n').map(line), SEPARATOR],
					LEAF_DIRECTIVE_PATTERN,
				);
				break;
			}
			case 'dropped':
				replace(record.at, [SEPARATOR]);
				break;
			case 'headingId':
				planOf(record.line).stripId = true;
				break;
			default:
				return unhandled(record, lowering.file);
		}
	}
	return plans;
}

/**
 * The exhaustiveness check, at runtime as well as in the typecheck. A record or a node
 * this module has no lowering for would otherwise publish its syntax, so it stops the
 * build instead, naming what it met.
 */
function unhandled(value: never, file: string): never {
	const kind =
		(value as { kind?: unknown; type?: unknown }).kind ?? (value as { type?: unknown }).type;
	throw new Error(
		`lowerDirectives: ${file} holds a directive this toolchain has no plain markdown for (${String(kind)}). ` +
			'Write its lowering in kit/src/compile/lower.ts before publishing a page that uses it.',
	);
}

function applyPlan(source: string, number: number, plan: LinePlan, file: string): Written[] {
	const misfit = (what: string): Error =>
		new Error(
			`lowerDirectives: ${what} recorded at line ${number} of ${file} does not fit the text it was parsed from. ` +
				'The raw markdown and the page payload would disagree about what this line is.',
		);

	let text = source;
	if (plan.stripId) {
		if (!EXPLICIT_HEADING_ID_PATTERN.test(text)) throw misfit('a heading anchor');
		text = text.replace(EXPLICIT_HEADING_ID_PATTERN, '');
	}

	// Everything a container adds goes in before the line's own content starts, so the
	// line is cut there: the head takes the prefixes, the rest is kept or replaced.
	const cut = plan.replace?.column ?? plan.before?.column ?? text.length + 1;
	if (cut - 1 > text.length) throw misfit('a directive');
	let head = text.slice(0, cut - 1);
	const rest = text.slice(cut - 1);
	const blank = cut === text.length + 1 && isBlank(text);

	// Right to left, and at one column the inner container first, so each insertion leaves
	// the columns of the ones still to come where they were and the outermost prefix ends
	// up leftmost.
	const prefixes = plan.prefixes
		.map((prefix) => ({
			...prefix,
			column: blank ? Math.max(prefix.column, prefix.floor) : prefix.column,
		}))
		.sort((a, b) => b.column - a.column || b.rank - a.rank);
	for (const { column, text: inserted } of prefixes) {
		if (column - 1 > head.length) {
			// Only a blank line can be shorter than the column its prefix goes in at.
			if (!blank) throw misfit('a container prefix');
			head = head.padEnd(column - 1, ' ');
		}
		head = `${head.slice(0, column - 1)}${inserted}${head.slice(column - 1)}`;
	}

	const place = (written: Written): Written => ({
		text: written.text === '' ? head.trimEnd() : `${head}${written.text}`,
		soft: written.soft,
	});

	if (plan.replace !== undefined) {
		const { shape, written } = plan.replace;
		if (shape !== undefined && !shape.test(rest.trim())) throw misfit('a directive');
		return written.map(place);
	}

	const own = `${head}${rest}`;
	// A blank line inside a quotation is `>`, not `> `.
	const kept = line(isBlank(own) ? own.trimEnd() : own);
	return plan.before === undefined ? [kept] : [...plan.before.written.map(place), kept];
}

/** Blank in whatever context it is in: nothing but quotation markers and spaces. */
function isBlank(text: string): boolean {
	return /^[\s>]*$/.test(text);
}

/** Drops each separator that sits beside a blank line already, or at either end. */
function settle(output: readonly Written[]): Written[] {
	const kept: Written[] = [];
	for (const [index, written] of output.entries()) {
		if (written.soft) {
			const previous = kept[kept.length - 1];
			const next = output[index + 1];
			if (previous === undefined || next === undefined) continue;
			if (isBlank(previous.text) || isBlank(next.text)) continue;
		}
		kept.push(written);
	}
	return kept;
}

/** Services for reading the lowered text back, which resolves nothing. */
const REREAD: ParseServices = {
	resolveLink: () => ({ ok: false, message: '', remediation: null }),
	resolveImage: () => ({ ok: false, message: '', remediation: null }),
	resolveInclude: () => ({ ok: false, message: '', remediation: null }),
	highlight: () => ({ lines: [], highlighted: false }),
};

/**
 * Refuses raw markdown that the compiler's own parser would still read a directive in.
 *
 * Read with the parser rather than with a pattern, because only the parser knows which of
 * these lines are in a fence: a page documenting the directive syntax has `:::note` in a
 * code block, correctly, and a pattern over the lines would fail that page's build. A
 * record means a directive survived lowering, which is a defect in this module or in the
 * parser's records rather than in the page, so it throws with the line rather than
 * becoming a finding the author would be sent to fix.
 */
export function assertLowered(text: string, file: string, config: DocsProjectConfig): void {
	const reread = parseDocument(text, {
		file,
		config,
		services: REREAD,
		// Not zero, so an `::include` left in the text is recorded without being resolved.
		includeDepth: 1,
	});
	const [left] = reread.directives;
	if (left === undefined) return;
	const at =
		left.kind === 'headingId'
			? left.line
			: left.kind === 'container'
				? left.open.line
				: left.at.line;
	const shown = text.split('\n')[at - 1]?.trim() ?? '';
	throw new Error(
		`The raw markdown of ${file} still holds directive syntax after lowering, at its line ${at}: ${JSON.stringify(shown)}. ` +
			'This is a defect in kit/src/compile/lower.ts, not in the page: it would publish syntax no markdown reader knows to <slug>.md and llms-full.txt.',
	);
}
