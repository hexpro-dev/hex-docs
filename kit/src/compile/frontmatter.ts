/**
 * The compiler's front matter reader.
 *
 * This is a narrow reader over a documented subset, and it refuses everything else by
 * name. `fixtures/frontmatter.ts` says the compiler will use a real YAML parser and that
 * it is not it. That is no longer the plan, for two reasons worth writing down.
 *
 * The first is the diagnostic. A general parser hands the schema a boolean and the
 * schema answers "expected string, received boolean", which is a sentence about types
 * for somebody who already knows that YAML folded `yes` into `true`. A narrow reader
 * answers "`title: yes` is YAML's boolean true, quote it", which is the sentence the
 * author needs. Every refusal below names the construct and what YAML would have done
 * with it, because the author's next question is always what the parser thought they
 * meant.
 *
 * The second is that the toolchain half stays dependency-light. A YAML parser is a
 * transitive tree under a tool that runs in a publish workflow with a bucket write
 * behind it.
 *
 * The risk a general parser was protecting against is two readers that quietly
 * disagree: the fixture reader accepting front matter the compiler rejects, the fixture
 * suite passing, and the corpus teaching a shape the toolchain cannot read. What closes
 * that is `kit/test/compile/frontmatter.test.ts`, which reads every markdown file in the
 * corpus with both readers and asserts they agree on the key order, on every value and
 * on the body. Widening one reader and not the other fails there.
 *
 * The subset: `key: scalar`, and `key:` followed by indented `- item` lines. Scalars are
 * bare, double quoted, or the literals `true` and `false`. Nothing nested, no block
 * scalars, no flow collections, no anchors, no comments.
 *
 * Nothing here narrows a value's type. `frontMatterSchema` is the validator, and a
 * reader that decided `draft` had to be a boolean would be a second, weaker schema
 * sitting where nothing compares it against the first.
 */

import type { FindingLocation } from '../../../src/contracts/diagnostics.js';
import { FORBIDDEN_FRONT_MATTER_KEYS } from '../../../src/contracts/frontmatter.js';

import { raw } from './types.js';
import type { FrontMatterBlock, ProseSegment, RawFinding } from './types.js';

/** The line that opens the block and the line that closes it. */
const DELIMITER = '---';

/**
 * A key line and a list item.
 *
 * These are the patterns `fixtures/frontmatter.ts` uses, restated rather than imported.
 * The fixture reader is the independent second opinion the corpus sweep compares this
 * one against, and a shared pattern would make half of that comparison vacuous: both
 * readers would agree about what a key line is because there would only be one answer.
 */
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_]*):[ \t]*(.*)$/;
const LIST_ITEM = /^[ \t]+-[ \t]+(.*)$/;

interface ScalarRefusal {
	readonly pattern: RegExp;
	/** A predicate about the value, naming the construct and what YAML does with it. */
	readonly what: string;
	readonly remediation: string;
}

const QUOTE_IT = 'Wrap the value in double quotes, or rewrite it without that character.';

const WRITE_IT_OUT = 'Write the value out. This reader resolves nothing for you.';

/**
 * Everything a bare scalar may not contain, and what YAML would have made of it.
 *
 * The first match wins. A value that trips three of these has one mistake in it, and
 * three findings saying so in three ways is how a report stops being read.
 */
const BARE_SCALAR_REFUSALS: readonly ScalarRefusal[] = [
	{
		pattern: /^'/,
		what: 'is a single-quoted scalar, which YAML reads with its own doubling rule for a quote inside',
		remediation: 'Use a double-quoted scalar, which is the only quoting this reader implements.',
	},
	{
		pattern: /^\[/,
		what: 'opens a flow sequence, which YAML reads as an inline list',
		remediation: 'Write the list as indented `- item` lines under the key.',
	},
	{
		pattern: /^\{/,
		what: 'opens a flow mapping, which YAML reads as a nested map',
		remediation: 'Front matter is one level deep here. There is nowhere for a nested map to go.',
	},
	{
		pattern: /^&/,
		what: 'opens an anchor, which YAML records for a later alias to reuse',
		remediation: WRITE_IT_OUT,
	},
	{
		pattern: /^\*/,
		what: 'is an alias, which YAML replaces with the value of the anchor it names',
		remediation: WRITE_IT_OUT,
	},
	{
		pattern: /^[|>]/,
		what:
			'opens with a block scalar indicator, which YAML reads as a value carrying on over the ' +
			'lines below it',
		remediation: 'Write the value on one line.',
	},
	{
		pattern: /^[!%@`]/,
		what:
			'opens with a YAML indicator character, which YAML reserves for tags, directives and ' +
			'its own future use',
		remediation: QUOTE_IT,
	},
	{
		pattern: /:\s/,
		what: 'contains a colon followed by a space, which YAML reads as a nested mapping',
		remediation: QUOTE_IT,
	},
	{
		pattern: /^#/,
		what: 'opens with a #, which YAML reads as a comment, leaving the key with no value at all',
		remediation: QUOTE_IT,
	},
	{
		pattern: /\s#/,
		what: 'contains a # after whitespace, which YAML reads as a trailing comment and drops',
		remediation: QUOTE_IT,
	},
];

/**
 * One refusal.
 *
 * `locale` is null because the reader is handed a file and a string and nothing else.
 * The path carries the locale and the caller is the one that already parsed it, so
 * deriving it here would be a second implementation of route derivation living in the
 * front matter reader.
 */
function refuse(
	file: string,
	line: number,
	column: number | null,
	message: string,
	remediation: string,
	excerpt: string | null = null,
): RawFinding {
	const location: FindingLocation =
		column === null ? { kind: 'file', file, line } : { kind: 'file', file, line, column };
	return raw('front-matter-invalid', location, null, message, { remediation, excerpt });
}

/**
 * The 1-based column where a capture group's trimmed content starts.
 *
 * Both patterns capture to the end of the line, so the group's offset is the line length
 * less the group length, and the trim is added back on. Subtracting the trimmed length
 * instead would be one column out for any leading space the pattern did not consume,
 * which is the column a finding about a description would then report.
 */
function columnAt(line: string, tail: string): number {
	return line.length - tail.length + (tail.length - tail.trimStart().length) + 1;
}

type ScalarRead =
	{ ok: true; value: string | boolean; column: number } | { ok: false; problem: RawFinding };

/**
 * One scalar, with the column its text starts at.
 *
 * The returned column is where the value's first character is, past the opening quote
 * where there is one, because that column is what a finding about a phrase inside a
 * description has to be measured from.
 */
function readScalar(text: string, file: string, line: number, column: number): ScalarRead {
	if (text === 'true') return { ok: true, value: true, column };
	if (text === 'false') return { ok: true, value: false, column };

	if (text.startsWith('"')) {
		if (text.length < 2 || !text.endsWith('"')) {
			return {
				ok: false,
				problem: refuse(
					file,
					line,
					column,
					`${JSON.stringify(text)} is an unterminated double-quoted scalar. YAML carries on past ` +
						`the end of the line looking for the closing quote and takes the lines below it into ` +
						`the value.`,
					'Close the quote, or drop both quotes and write a bare scalar.',
					text,
				),
			};
		}
		const inner = text.slice(1, -1);
		if (inner.includes('"')) {
			return {
				ok: false,
				problem: refuse(
					file,
					line,
					column,
					`${JSON.stringify(text)} has a quote inside a double-quoted scalar. YAML needs it ` +
						`escaped, and this reader implements no escapes, so the two would disagree about ` +
						`the value.`,
					'Escape nothing and quote nothing: write the value bare, or reword it.',
					text,
				),
			};
		}
		if (inner.includes('\\')) {
			return {
				ok: false,
				problem: refuse(
					file,
					line,
					column,
					`${JSON.stringify(text)} has a backslash inside a double-quoted scalar. YAML expands ` +
						`escapes there and this reader does not, so the two would disagree about the value.`,
					'Write the value bare, where a backslash is a backslash.',
					text,
				),
			};
		}
		return { ok: true, value: inner, column: column + 1 };
	}

	for (const refusal of BARE_SCALAR_REFUSALS) {
		const at = refusal.pattern.exec(text);
		if (at === null) continue;
		return {
			ok: false,
			problem: refuse(
				file,
				line,
				column + at.index,
				`${JSON.stringify(text)} ${refusal.what}.`,
				refusal.remediation,
				text,
			),
		};
	}

	return { ok: true, value: text, column };
}

/**
 * The reason a key is refused by name, or undefined if it is not one of them.
 *
 * Read through `Object.hasOwn` rather than by indexing straight into the record, because
 * indexing hands back `Object.prototype.constructor` for a key named `constructor`: a
 * page declaring one would be refused, and the message would carry a function where the
 * owner of the fact should be.
 */
function forbiddenKeyReason(key: string): string | undefined {
	if (!Object.hasOwn(FORBIDDEN_FRONT_MATTER_KEYS, key)) return undefined;
	return FORBIDDEN_FRONT_MATTER_KEYS[key];
}

/**
 * Reads the front matter block at the top of a markdown file.
 *
 * Every problem in the block is reported rather than the first one: front matter that is
 * wrong in three ways should say so once. Recovery is per line, so a refused key takes
 * its own list items with it and nothing below it is read against a key that was never
 * accepted.
 */
export function readFrontMatter(source: string, file: string): FrontMatterBlock {
	const lines = source.split(/\r?\n/);
	const problems: RawFinding[] = [];
	const data: Record<string, unknown> = {};
	const keyLines: Record<string, number> = {};
	const prose: ProseSegment[] = [];

	if (lines[0] !== DELIMITER) {
		problems.push(
			refuse(
				file,
				1,
				null,
				`The file does not open with a ${DELIMITER} delimiter, so it has no front matter. YAML ` +
					`is read between the delimiters and nowhere else, so the page has no title and no ` +
					`description.`,
				'Open the file with a front matter block declaring at least a title and a description.',
			),
		);
		// The whole file is body. A page with no front matter still has prose worth
		// linting, and reading it as front matter would bury the one finding that says
		// what is actually wrong under one stray-line finding per paragraph.
		return { data, keyLines, prose, bodyLine: 1, body: source, problems };
	}

	const close = lines.indexOf(DELIMITER, 1);
	if (close === -1) {
		problems.push(
			refuse(
				file,
				1,
				null,
				`The front matter opens on line 1 and is never closed. YAML would read the rest of the ` +
					`file as front matter, so the page would be all header and no body.`,
				`Close the block with a ${DELIMITER} line.`,
			),
		);
		// No closing delimiter means there is no line that separates the two halves, so
		// there is no body to hand back. Guessing at one and reading the file as a block
		// anyway produces a stray-line finding for every paragraph in the document, which
		// is the noise that hides this finding.
		return { data, keyLines, prose, bodyLine: lines.length + 1, body: '', problems };
	}

	/**
	 * The list a `- item` line attaches to, when the key above it declared one.
	 *
	 * Kept beside `data` rather than read back out of it, so pushing an item is typed as
	 * pushing a string. A key present in `current` and absent from `lists` is a key with
	 * a scalar value, which is what the list-under-a-scalar refusal tests.
	 */
	const lists = new Map<string, string[]>();
	let current: string | undefined;
	let refusedKey = false;

	for (let index = 1; index < close; index += 1) {
		const line = lines[index] as string;
		const lineNumber = index + 1;
		if (line.trim() === '') continue;

		const item = LIST_ITEM.exec(line);
		if (item !== null) {
			// The key above was already refused, so the items under it are part of the same
			// mistake. Reporting each of them again says nothing the first finding did not.
			if (refusedKey) continue;
			if (current === undefined) {
				problems.push(
					refuse(
						file,
						lineNumber,
						null,
						`${JSON.stringify(line.trim())} is a list item with no key above it. YAML reads a ` +
							`sequence where the block expects a mapping key, and refuses the document.`,
						'Put the item under a key, indented beneath it.',
						line.trim(),
					),
				);
				continue;
			}
			const list = lists.get(current);
			if (list === undefined) {
				problems.push(
					refuse(
						file,
						lineNumber,
						null,
						`\`${current}\` already has a scalar value, so the list item below it has nothing ` +
							`to attach to. YAML refuses a mapping whose value is a scalar and a sequence at ` +
							`once.`,
						`Either give \`${current}\` a scalar or give it a list, not both.`,
						line.trim(),
					),
				);
				continue;
			}
			const tail = item[1] as string;
			const read = readScalar(tail.trim(), file, lineNumber, columnAt(line, tail));
			if (!read.ok) {
				problems.push(read.problem);
				continue;
			}
			// A list is `string[]`, so a bare `true` in one is the string. That is what the
			// fixture reader does with it, and the corpus sweep is only worth anything while
			// the two readers agree on values as well as on keys.
			list.push(String(read.value));
			continue;
		}

		const entry = KEY_LINE.exec(line);
		if (entry === null) {
			problems.push(
				refuse(
					file,
					lineNumber,
					null,
					`${JSON.stringify(line)} is neither a \`key: value\` line nor a \`- item\` line. YAML ` +
						`would either fold it into the value above it as a plain scalar carrying on over ` +
						`several lines, or refuse the document, and this reader guesses at neither.`,
					'Write it as a key with a value, or indent it as an item under the key above.',
					line.trim(),
				),
			);
			continue;
		}

		const key = entry[1] as string;
		const tail = entry[2] as string;
		const text = tail.trim();
		const column = columnAt(line, tail);

		// `Object.hasOwn` rather than `in` or a bare index, so a page whose first key is
		// `constructor` is not reported as declaring it twice: `in` finds it on the
		// prototype, and indexing hands back a function where a line number should be.
		const declaredAt = Object.hasOwn(keyLines, key) ? keyLines[key] : undefined;
		if (declaredAt !== undefined) {
			problems.push(
				refuse(
					file,
					lineNumber,
					null,
					`\`${key}\` is declared twice, on line ${declaredAt} and here. YAML ` +
						`forbids a duplicate key, and the parsers that allow one keep the last and ` +
						`silently discard the first.`,
					'Delete one of them.',
					line.trim(),
				),
			);
			// The first declaration is the one kept, and the second is refused whole: taking
			// the last, as a permissive YAML parser does, would mean the finding says one
			// thing and the value says the other.
			current = undefined;
			refusedKey = true;
			continue;
		}
		// Recorded before any refusal below, because `keyLines` answers where a key is
		// declared and a caller with a finding about a key needs an answer for a key this
		// reader would not read.
		keyLines[key] = lineNumber;

		const owner = forbiddenKeyReason(key);
		if (owner !== undefined) {
			problems.push(
				refuse(
					file,
					lineNumber,
					null,
					`\`${key}\` is not a key a page may declare. ${owner}`,
					`Delete \`${key}\`. The fact already has an owner, and two owners for one fact is ` +
						`how a page ends up routable and unpublished.`,
					line.trim(),
				),
			);
			// Kept out of `data` on purpose. Handing it to the strict schema as well would
			// report the same mistake a second time as an unrecognised key, and that message
			// is the worse of the two.
			current = undefined;
			refusedKey = true;
			continue;
		}

		if (text === '') {
			const next = lines.slice(index + 1, close).find((candidate) => candidate.trim() !== '');
			if (next === undefined || LIST_ITEM.exec(next) === null) {
				problems.push(
					refuse(
						file,
						lineNumber,
						null,
						`\`${key}\` has no value and no list under it. YAML reads that as null, and this ` +
							`reader will not guess between null and an empty list.`,
						`Give \`${key}\` a value, or indented \`- item\` lines, or delete it.`,
						line.trim(),
					),
				);
				current = undefined;
				refusedKey = true;
				continue;
			}
			const list: string[] = [];
			lists.set(key, list);
			data[key] = list;
			current = key;
			refusedKey = false;
			continue;
		}

		const read = readScalar(text, file, lineNumber, column);
		if (!read.ok) {
			problems.push(read.problem);
			current = undefined;
			refusedKey = true;
			continue;
		}

		data[key] = read.value;
		current = key;
		refusedKey = false;

		if (typeof read.value === 'string') {
			// Every string value, not the two a lint rule is most likely to want. A rule that
			// only saw `title` and `description` would let a banned phrase through in a
			// `navTitle`, and the sidebar is where it would be read most.
			prose.push({
				file,
				kind: 'frontMatter',
				folded: {
					text: read.value,
					runs: [{ offset: 0, length: read.value.length, line: lineNumber, column: read.column }],
				},
			});
		}
	}

	const after = lines.slice(close + 1);
	// One blank line after the closing delimiter is the convention every file in the
	// corpus follows, and it is not part of the body. Removing exactly one keeps a
	// deliberate blank second line, which is what separates a page opening on a heading
	// from one opening on a paragraph after a gap.
	const blank = after[0] === '';
	const body = (blank ? after.slice(1) : after).join('\n');

	return {
		data,
		keyLines,
		prose,
		// The closing delimiter is on line `close + 1`, so the first body line is the one
		// after it, or the one after that when a blank line was dropped. Absolute, because a
		// finding measured from the start of the body would point at the wrong line on every
		// page whose front matter is not exactly six lines long.
		bodyLine: close + (blank ? 3 : 2),
		body,
		problems,
	};
}
