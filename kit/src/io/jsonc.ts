/**
 * Editing JSON files that a person also edits, without reformatting them.
 *
 * Every file this package changes in a consumer repository is hand-maintained. hex-web's
 * `apps/front/tsconfig.json` is JSON with comments, and its `paths` entries carry twenty
 * lines of prose explaining why each submodule resolves to source. `deploy.config.json`
 * is strict JSON and hand-packed: line 245 puts three directory names on one line and the
 * two long ones on their own. Neither repository has prettier installed, so nothing would
 * put that formatting back.
 *
 * So nothing here parses and reserialises. Every function is an insert or a replacement
 * located in the original text, and everything it does not touch keeps its bytes,
 * including comments, packing and the trailing newline.
 *
 * **Every function returns `null` when its anchor is missing or is not unique.** Without
 * a marker convention, "this file was hand-edited" is not knowable, but "I cannot find
 * exactly one place to put this" is, and for every practical purpose it is the same
 * condition. A guess here writes into somebody's build configuration.
 */

/** A half-open character range in the original text: `[start, end)`. */
export interface JsonSpan {
	readonly start: number;
	readonly end: number;
}

/**
 * Comments blanked out, leaving strings alone and **leaving the length unchanged**.
 *
 * Two callers need two different things from this and the blanking is what serves both.
 * `check-tools.mjs:479` reads hex-web's tsconfig as `JSON.parse(stripComments(text))`, so
 * the result has to parse; and every scanner below locates a span in the stripped text
 * and then slices the original, which is only sound because index `i` means the same
 * character in both. Deleting the comment bytes instead, which is what the original in
 * `check-tools.mjs` does, moves every index after the first comment and silently
 * relocates every edit in a commented file.
 *
 * The three string forms are tracked so that the `//` in a URL is not read as a comment,
 * which is the mistake a plain replace makes. It does **not** recognise regular
 * expression literals: `/` is ordinary unless it opens a comment, so a regex containing
 * `//` or an unbalanced quote would confuse it. No JSON file contains one, and this is
 * the honest limit rather than an attempt to reimplement a lexer.
 */
export function stripComments(text: string): string {
	const out: string[] = new Array<string>(text.length);
	const blank = (from: number, to: number): void => {
		for (let k = from; k < to; k += 1) out[k] = text.charAt(k) === '\n' ? '\n' : ' ';
	};

	let i = 0;
	while (i < text.length) {
		const c = text.charAt(i);
		const next = text.charAt(i + 1);

		if (c === '"' || c === "'" || c === '`') {
			out[i] = c;
			i += 1;
			while (i < text.length) {
				if (text.charAt(i) === '\\') {
					out[i] = text.charAt(i);
					if (i + 1 < text.length) out[i + 1] = text.charAt(i + 1);
					i += 2;
					continue;
				}
				out[i] = text.charAt(i);
				i += 1;
				if (text.charAt(i - 1) === c) break;
			}
			continue;
		}

		if (c === '/' && next === '/') {
			const start = i;
			while (i < text.length && text.charAt(i) !== '\n') i += 1;
			blank(start, i);
			continue;
		}

		if (c === '/' && next === '*') {
			const start = i;
			i += 2;
			while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) i += 1;
			// An unterminated block comment blanks to the end of the file. It is malformed
			// either way, and blanking is what makes the JSON.parse below report it.
			i = Math.min(i + 2, text.length);
			blank(start, i);
			continue;
		}

		out[i] = c;
		i += 1;
	}
	return out.join('');
}

/**
 * The file's own indentation unit: one tab, or the run of spaces one level deep.
 *
 * Read from the comment-stripped text so that the single leading space on a ` *`
 * continuation line inside a block comment cannot be mistaken for a one-space indent.
 * A file with no indented line at all defaults to a tab, which is what every JSON file in
 * this estate and both consumer repositories use.
 */
export function detectIndent(text: string): string {
	for (const line of stripComments(text).split('\n')) {
		const match = /^([\t ]+)\S/.exec(line);
		if (match === null) continue;
		const indent = match[1] ?? '';
		return indent.startsWith('\t') ? '\t' : indent;
	}
	return '\t';
}

/** The newline this file already uses, so an insert does not mix the two. */
function newlineOf(text: string): string {
	return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * The leading whitespace of the line `index` sits on, which is where a new line goes.
 *
 * Exported because a caller rendering a multi-line value has to indent its continuation
 * lines to the same depth, and a second copy of this in a command is how the two come to
 * disagree about a file indented with spaces.
 */
export function lineIndentAt(text: string, index: number): string {
	const lineStart = text.lastIndexOf('\n', Math.max(index - 1, 0)) + 1;
	const match = /^[\t ]*/.exec(text.slice(lineStart, index));
	return match === null ? '' : match[0];
}

/** The index just past the end of the line `index` sits on, excluding the newline. */
function lineEndAt(text: string, index: number): number {
	const found = text.indexOf('\n', index);
	return found === -1 ? text.length : found;
}

/**
 * Whether a comment lives in this range.
 *
 * The stripped text is the same length as the original, so a range that differs between
 * them contains something that was blanked, and the only thing this blanks is a comment.
 * Used to refuse rather than to write a comma inside somebody's note, or to delete one.
 */
function containsComment(text: string, scan: string, from: number, to: number): boolean {
	return text.slice(from, to) !== scan.slice(from, to);
}

function endOfString(scan: string, start: number): number | null {
	let i = start + 1;
	while (i < scan.length) {
		const c = scan.charAt(i);
		if (c === '\\') {
			i += 2;
			continue;
		}
		if (c === '"') return i + 1;
		i += 1;
	}
	return null;
}

/**
 * The index just past the value starting at `start`, or `null` if it does not close.
 *
 * Bracket depth with strings skipped whole, so a `}` inside a string cannot close an
 * object. A closing bracket of the wrong kind returns `null` rather than accepting the
 * value: `{ "a": [1 }` is not an object this may edit.
 */
function endOfValue(scan: string, start: number): number | null {
	const first = scan.charAt(start);
	if (first === '"') return endOfString(scan, start);

	if (first === '{' || first === '[') {
		const close = first === '{' ? '}' : ']';
		let depth = 0;
		let i = start;
		while (i < scan.length) {
			const c = scan.charAt(i);
			if (c === '"') {
				const end = endOfString(scan, i);
				if (end === null) return null;
				i = end;
				continue;
			}
			if (c === '{' || c === '[') depth += 1;
			else if (c === '}' || c === ']') {
				depth -= 1;
				if (depth === 0) return c === close ? i + 1 : null;
				if (depth < 0) return null;
			}
			i += 1;
		}
		return null;
	}

	// A number, `true`, `false` or `null`: it ends at the first character that cannot be
	// part of one. An empty run means there was no value here at all.
	let i = start;
	while (i < scan.length && /[^\s,}\]]/.test(scan.charAt(i))) i += 1;
	return i === start ? null : i;
}

interface JsonMember {
	readonly key: string;
	readonly keySpan: JsonSpan;
	readonly valueSpan: JsonSpan;
}

/** The members of the object at `span`, in document order, or `null` if it is not one. */
function membersOf(scan: string, span: JsonSpan): JsonMember[] | null {
	if (scan.charAt(span.start) !== '{') return null;
	const members: JsonMember[] = [];
	let i = span.start + 1;
	while (i < span.end) {
		const c = scan.charAt(i);
		if (/\s/.test(c) || c === ',') {
			i += 1;
			continue;
		}
		if (c === '}') return members;
		if (c !== '"') return null;

		const keyEnd = endOfString(scan, i);
		if (keyEnd === null) return null;
		let key: string;
		try {
			key = JSON.parse(scan.slice(i, keyEnd)) as string;
		} catch {
			return null;
		}

		let j = keyEnd;
		while (j < span.end && /\s/.test(scan.charAt(j))) j += 1;
		if (scan.charAt(j) !== ':') return null;
		j += 1;
		while (j < span.end && /\s/.test(scan.charAt(j))) j += 1;

		const valueEnd = endOfValue(scan, j);
		if (valueEnd === null) return null;
		members.push({
			key,
			keySpan: { start: i, end: keyEnd },
			valueSpan: { start: j, end: valueEnd },
		});
		i = valueEnd;
	}
	return null;
}

/** The whole document, as a span. `null` when the file is not a JSON object. */
export function rootSpan(text: string): JsonSpan | null {
	const scan = stripComments(text);
	let i = 0;
	while (i < scan.length && /\s/.test(scan.charAt(i))) i += 1;
	if (scan.charAt(i) !== '{') return null;
	const end = endOfValue(scan, i);
	return end === null ? null : { start: i, end };
}

/**
 * The span of the value at a dotted path, searched inside `within` or from the root.
 *
 * A segment that names no member, or names more than one, returns `null`: a file with the
 * same key twice is a file this cannot edit without choosing which one the reader meant.
 * A key containing a dot cannot be addressed, which is stated rather than worked around
 * because no path any caller here needs has one.
 */
export function findValue(text: string, path: string, within?: JsonSpan): JsonSpan | null {
	const scan = stripComments(text);
	let span = within ?? rootSpan(text);
	if (span === null) return null;
	if (path === '') return span;

	for (const segment of path.split('.')) {
		const members = membersOf(scan, span);
		if (members === null) return null;
		const matches = members.filter((member) => member.key === segment);
		const [only] = matches;
		if (only === undefined || matches.length !== 1) return null;
		span = only.valueSpan;
	}
	return span;
}

/** The spans of an array's elements, in order, or `null` if `span` is not an array. */
export function arrayElements(text: string, span: JsonSpan): JsonSpan[] | null {
	const scan = stripComments(text);
	if (scan.charAt(span.start) !== '[') return null;
	const elements: JsonSpan[] = [];
	let i = span.start + 1;
	while (i < span.end) {
		const c = scan.charAt(i);
		if (/\s/.test(c) || c === ',') {
			i += 1;
			continue;
		}
		if (c === ']') return elements;
		const end = endOfValue(scan, i);
		if (end === null) return null;
		elements.push({ start: i, end });
		i = end;
	}
	return null;
}

export interface SetOptions {
	/**
	 * Put a new member immediately before this one, rather than last.
	 *
	 * It exists so a writer can match a key order that already exists somewhere: the
	 * checked-in `fixtures/site/fixture-app.docs.json` carries `hidden` above `pages`, and
	 * a command that appended it below would produce a file that differs from the one
	 * example of its own output. The named member not being there is not an error; the new
	 * member then goes last, which is what happens with no option at all.
	 *
	 * The limit worth knowing: a comment on the lines above the named member ends up above
	 * the new member instead, because the insert is at the named member's key. No file any
	 * caller here edits with this has comments, and refusing on one would be the stricter
	 * choice if that changes.
	 */
	readonly before?: string;
}

/**
 * Sets one member of the object at `span`, replacing its value or adding it.
 *
 * `valueText` is inserted verbatim, so it is the caller's JSON: build it with
 * `JSON.stringify` or with a renderer that knows the file's indentation. Replacing an
 * existing member touches only its value, so a comment above the key, the key's own
 * spelling and every other member survive unchanged.
 *
 * A new member goes after the last one by default, on its own line, at the last member's
 * indentation. That is where `digest` belongs in a version entry. It refuses when a
 * comment follows the last member on that line, because the comma would land inside the
 * comment.
 */
export function setMember(
	text: string,
	span: JsonSpan,
	key: string,
	valueText: string,
	options: SetOptions = {},
): string | null {
	const scan = stripComments(text);
	const members = membersOf(scan, span);
	if (members === null) return null;

	const matches = members.filter((member) => member.key === key);
	if (matches.length > 1) return null;
	const [existing] = matches;
	if (existing !== undefined) {
		return text.slice(0, existing.valueSpan.start) + valueText + text.slice(existing.valueSpan.end);
	}

	const newline = newlineOf(text);

	if (options.before !== undefined) {
		const targets = members.filter((member) => member.key === options.before);
		if (targets.length > 1) return null;
		const [target] = targets;
		if (target !== undefined) {
			const indent = lineIndentAt(text, target.keySpan.start);
			const insertion = `${JSON.stringify(key)}: ${valueText},${newline}${indent}`;
			return text.slice(0, target.keySpan.start) + insertion + text.slice(target.keySpan.start);
		}
	}

	const last = members[members.length - 1];
	if (last === undefined) {
		const indent = lineIndentAt(text, span.start);
		const body = `{${newline}${indent}${detectIndent(text)}${JSON.stringify(key)}: ${valueText}${newline}${indent}}`;
		return text.slice(0, span.start) + body + text.slice(span.end);
	}

	if (containsComment(text, scan, last.valueSpan.end, lineEndAt(text, last.valueSpan.end))) {
		return null;
	}
	const indent = lineIndentAt(text, last.keySpan.start);
	const insertion = `,${newline}${indent}${JSON.stringify(key)}: ${valueText}`;
	return text.slice(0, last.valueSpan.end) + insertion + text.slice(last.valueSpan.end);
}

/**
 * Removes one member of the object at `span`, with the comma that joins it.
 *
 * A member that is not there is not an error: removal is a statement about the end state,
 * and returning the text unchanged is that end state. Two members with the same key, or a
 * comment inside the range that would be cut, both return `null` rather than deleting
 * something nobody asked to delete.
 */
export function removeMember(text: string, span: JsonSpan, key: string): string | null {
	const scan = stripComments(text);
	const members = membersOf(scan, span);
	if (members === null) return null;

	const matching = members.filter((member) => member.key === key);
	if (matching.length > 1) return null;
	const index = members.findIndex((member) => member.key === key);
	if (index === -1) return text;
	const member = members[index];
	if (member === undefined) return null;

	const previous = members[index - 1];
	const next = members[index + 1];
	const cut: JsonSpan =
		previous !== undefined
			? { start: previous.valueSpan.end, end: member.valueSpan.end }
			: next !== undefined
				? { start: member.keySpan.start, end: next.keySpan.start }
				: { start: span.start + 1, end: span.end - 1 };

	if (containsComment(text, scan, cut.start, cut.end)) return null;
	return text.slice(0, cut.start) + text.slice(cut.end);
}

export interface InsertOptions {
	/**
	 * Put a comma on the last value before the insertion point.
	 *
	 * Off by default, because the same function inserts into `pnpm-workspace.yaml`, where
	 * a comma would be part of the string. It is a request rather than a deduction for
	 * exactly that reason: only the caller knows whether this file is JSON.
	 *
	 * It refuses when that line carries a comment, and "comment" here means `//` and
	 * `/* *\/` and nothing else. A `#` comment in a YAML file is invisible to it, which is
	 * one more reason this option belongs to the JSON and JSONC callers.
	 */
	readonly commaBefore?: true;
}

/**
 * Inserts lines immediately before the one line that matches, or `null` if that line is
 * not unique.
 *
 * A string matcher compares trimmed content, which makes `"docs/public"` match whatever
 * it is indented by; a `RegExp` is tested against the raw line, which is how a caller
 * pins the indentation of one closing brace among many. `lines` are inserted verbatim:
 * this function has no idea how deep the caller's content belongs, and guessing would
 * reindent a block that was already right.
 */
export function insertBefore(
	text: string,
	closingLine: string | RegExp,
	lines: readonly string[],
	options: InsertOptions = {},
): string | null {
	const newline = newlineOf(text);
	const all = text.split(newline);
	const stripped = stripComments(text).split(newline);

	const matched: number[] = [];
	all.forEach((line, index) => {
		const hit =
			typeof closingLine === 'string' ? line.trim() === closingLine.trim() : closingLine.test(line);
		if (hit) matched.push(index);
	});
	const [at] = matched;
	if (at === undefined || matched.length !== 1) return null;

	if (options.commaBefore === true) {
		let k = at - 1;
		while (k >= 0 && (stripped[k] ?? '').trim() === '') k -= 1;
		const previous = all[k];
		if (previous === undefined) return null;
		// A comment on that line would swallow the comma, and the value it documents would
		// then be the last one without a separator. Refusing is the only honest answer:
		// putting the comma before the comment is a guess about which of them the author
		// meant to keep beside the value.
		if ((stripped[k] ?? '') !== previous) return null;
		const kept = previous.trimEnd();
		if (!(kept.endsWith(',') || kept.endsWith('[') || kept.endsWith('{'))) {
			all[k] = kept + ',' + previous.slice(kept.length);
		}
	}

	all.splice(at, 0, ...lines);
	return all.join(newline);
}

/**
 * Appends one element to the array at a dotted path, on its own line.
 *
 * `entry` is inserted verbatim, so a string element is `JSON.stringify(value)` and not
 * the bare value. The result is parsed before it is returned and a result that is not
 * JSON is refused, which is what makes a verbatim entry safe to offer.
 *
 * It appends unconditionally. Whether the entry is already there is the caller's
 * question, because the caller is the one that knows what "already there" means: for
 * `deploy.config.json` it is an exact quoted token, and `grep docs` would answer yes on a
 * file carrying only `"docs/public"`.
 */
export function appendToArray(text: string, arrayPath: string, entry: string): string | null {
	const scan = stripComments(text);
	const span = findValue(text, arrayPath);
	if (span === null || scan.charAt(span.start) !== '[') return null;
	const elements = arrayElements(text, span);
	if (elements === null) return null;

	const newline = newlineOf(text);
	const last = elements[elements.length - 1];
	let next: string;
	if (last === undefined) {
		const indent = lineIndentAt(text, span.start);
		const body = `[${newline}${indent}${detectIndent(text)}${entry}${newline}${indent}]`;
		next = text.slice(0, span.start) + body + text.slice(span.end);
	} else {
		if (containsComment(text, scan, last.end, lineEndAt(text, last.end))) return null;
		// The last element's own line indent, not the array's. `deploy.config.json` packs
		// three entries on one line and puts the two long ones on their own, so the line
		// the last element starts on is the only thing that says how deep an entry sits.
		next =
			text.slice(0, last.end) +
			`,${newline}${lineIndentAt(text, last.start)}${entry}` +
			text.slice(last.end);
	}

	try {
		JSON.parse(stripComments(next));
	} catch {
		return null;
	}
	return next;
}
