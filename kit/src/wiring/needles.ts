/**
 * Reading a consumer's source and configuration without a TypeScript compiler.
 *
 * Every function here is a text match, and that is the honest limit rather than a
 * shortcut. `apps/front/scripts/check-tools.mjs` has read its own registries this way
 * since before this package existed, and its comment at line 188 says the thing worth
 * repeating: renaming the local variable inside one of those `.map()` calls breaks the
 * check without breaking the code, and rearranging the expression around the identifier
 * breaks the code without breaking the check. `VerifyInstallReport.notCheckedHere`
 * carries that sentence to the reader rather than leaving it here.
 *
 * The alternative was considered and refused. Neither consumer's route table can be read
 * from node without executing a Vite module: `routes.ts` imports
 * `@react-router/dev/routes` and `app/lib/docs.ts` uses `import.meta.glob`. Loading a
 * TypeScript compiler into `kit/` to get an AST would be a dependency the whole package
 * is built to avoid, and it would still not evaluate the module.
 *
 * `stripComments` is ported from `check-tools.mjs:139-179` rather than rewritten, so the
 * two guards cannot form different opinions about what a comment is. Its limit is stated
 * there and holds here: it tracks the three string forms so the `//` in a `https://` URL
 * is not mistaken for a comment, and it does not recognise regular expression literals,
 * so a regex containing `//` or an unbalanced quote would confuse it. None of the files
 * read here contains one.
 */

export interface StrippedSource {
	readonly text: string;
	/**
	 * `origin[i]` is the index in the original source of `text[i]`.
	 *
	 * This is what lets a JSONC edit be an insertion into the original bytes rather than
	 * a parse and re-serialise. hex-web's `apps/front/tsconfig.json` carries thirteen
	 * lines of block comment inside its `paths` object and tab indentation throughout,
	 * and a round trip through `JSON.parse` plus `JSON.stringify` destroys both. The
	 * comments are that repository's actual documentation of why those entries exist.
	 */
	readonly origin: readonly number[];
}

/** Removes comments, leaving strings alone, and records where every surviving byte was. */
export function stripCommentsMapped(source: string): StrippedSource {
	let out = '';
	const origin: number[] = [];
	let i = 0;
	while (i < source.length) {
		const c = source[i] as string;
		const next = source[i + 1];

		if (c === '"' || c === "'" || c === '`') {
			const quote = c;
			out += c;
			origin.push(i);
			i += 1;
			while (i < source.length) {
				if (source[i] === '\\' && i + 1 < source.length) {
					out += source.slice(i, i + 2);
					origin.push(i, i + 1);
					i += 2;
					continue;
				}
				out += source[i];
				origin.push(i);
				i += 1;
				if (source[i - 1] === quote) break;
			}
			continue;
		}

		if (c === '/' && next === '/') {
			while (i < source.length && source[i] !== '\n') i += 1;
			continue;
		}

		if (c === '/' && next === '*') {
			i += 2;
			while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
			i += 2;
			continue;
		}

		out += c;
		origin.push(i);
		i += 1;
	}
	return { text: out, origin };
}

export function stripComments(source: string): string {
	return stripCommentsMapped(source).text;
}

/**
 * Collapses whitespace so a structural search survives a reformat.
 *
 * Byte for byte the shape `check-tools.mjs:192-196` uses, and for the same reason: the
 * assertions below are about shape, and shape is exactly what a formatter is allowed to
 * change. `pnpm format` in either consumer would otherwise turn every needle in this
 * package into a false failure.
 */
export function structural(source: string): string {
	return stripComments(source)
		.replace(/\s+/g, ' ')
		.replace(/\s*([(){}[\],=>:;])\s*/g, '$1')
		.trim();
}

export function derives(source: string, needle: string): boolean {
	return structural(source).includes(structural(needle));
}

/**
 * Where a needle sits in the structural form, or `-1`.
 *
 * Only ever compared against another index from the same source. The number itself means
 * nothing: whitespace collapsing moves it, which is the whole point of comparing two of
 * them rather than either one against a literal.
 */
export function structuralIndex(source: string, needle: string): number {
	return structural(source).indexOf(structural(needle));
}

/** `JSON.parse` over the comment-stripped text, or `null`. Never throws. */
export function parseJsonc(text: string): unknown {
	try {
		return JSON.parse(stripComments(text)) as unknown;
	} catch {
		return null;
	}
}

function escapeForPattern(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The bracketed value of a key that appears exactly once, as offsets into the original.
 *
 * Exactly once, and not "the first one". A `"paths"` that appears twice is a file this
 * check cannot see, and inserting into whichever one came first is how an edit lands in
 * a block the reader was not looking at. Every caller treats `null` as a refusal to act
 * rather than as an absence.
 */
export interface JsonBlock {
	/** Index of the opening `{` or `[` in the original text. */
	readonly open: number;
	/** Index of its matching close in the original text. */
	readonly close: number;
	readonly kind: 'object' | 'array';
}

export function soleBlock(source: string, key: string): JsonBlock | null {
	const stripped = stripCommentsMapped(source);
	const pattern = new RegExp(`"${escapeForPattern(key)}"\\s*:`, 'g');
	const matches = [...stripped.text.matchAll(pattern)];
	if (matches.length !== 1) return null;

	const first = matches[0];
	if (first?.index === undefined) return null;
	let cursor = first.index + first[0].length;
	while (cursor < stripped.text.length && /\s/.test(stripped.text[cursor] as string)) cursor += 1;
	const opener = stripped.text[cursor];
	if (opener !== '{' && opener !== '[') return null;

	const end = balancedEnd(stripped.text, cursor);
	if (end === -1) return null;

	const open = stripped.origin[cursor];
	const close = stripped.origin[end];
	if (open === undefined || close === undefined) return null;
	return { open, close, kind: opener === '{' ? 'object' : 'array' };
}

/**
 * The index of the bracket that closes the one at `open`, or `-1`.
 *
 * String aware, so a brace inside a string literal does not shift the depth. Nesting of
 * the other bracket kind is ignored, which is correct for JSON: a `}` can only appear
 * inside an array through an object, and that object increments the depth first.
 */
export function balancedEnd(text: string, open: number): number {
	const opener = text[open];
	if (opener !== '{' && opener !== '[') return -1;
	const closer = opener === '{' ? '}' : ']';
	let depth = 0;
	let i = open;
	while (i < text.length) {
		const c = text[i];
		if (c === '"' || c === "'" || c === '`') {
			const quote = c;
			i += 1;
			while (i < text.length) {
				if (text[i] === '\\') {
					i += 2;
					continue;
				}
				if (text[i] === quote) {
					i += 1;
					break;
				}
				i += 1;
			}
			continue;
		}
		if (c === opener) depth += 1;
		else if (c === closer) {
			depth -= 1;
			if (depth === 0) return i;
		}
		i += 1;
	}
	return -1;
}

/** The index of the first character of the line `offset` is on. */
export function lineStart(text: string, offset: number): number {
	const previous = text.lastIndexOf('\n', Math.max(0, offset - 1));
	return previous === -1 ? 0 : previous + 1;
}

/** The leading whitespace of the line `offset` is on, as written. */
export function indentAt(text: string, offset: number): string {
	const start = lineStart(text, offset);
	const match = /^[ \t]*/.exec(text.slice(start));
	return match === null ? '' : match[0];
}

/**
 * The indentation of the first entry inside a block, so an insert matches the file.
 *
 * Falls back to the block's own indentation plus the file's own unit, which is detected
 * rather than assumed to be a tab: every JSON file in both consumers is tab indented, and
 * a file that a formatter had rewritten with two spaces would otherwise gain one line of
 * mixed indentation in the middle of an array.
 */
export function entryIndent(text: string, block: JsonBlock): string {
	const inner = text.slice(block.open + 1, block.close);
	for (const line of inner.split('\n').slice(1)) {
		if (line.trim() === '') continue;
		const match = /^[ \t]*/.exec(line);
		if (match !== null && match[0] !== '') return match[0];
	}
	return `${indentAt(text, block.open)}${detectIndent(text)}`;
}

/**
 * The index just past the last non-blank character before `offset`, or `-1`.
 *
 * Used to put a comma on the entry an insert follows. A blank line or a comment line
 * between the last entry and the closing bracket is ordinary in both consumers, so the
 * scan skips whitespace rather than assuming the previous line is the previous entry.
 */
export function lastNonBlankBefore(text: string, offset: number): number {
	let i = offset - 1;
	while (i >= 0 && /\s/.test(text[i] as string)) i -= 1;
	return i;
}

/**
 * Inserts entries into a JSON block, preserving everything already in it.
 *
 * Two cases, and the second one was a real defect before it was separated out. A block
 * whose brackets are on one line, `"extra_dirs": {}` or `"front": []`, has its closing
 * bracket on the same line as its opening one, so "insert before the line the close sits
 * on" puts the entry *above the whole block*: a `"front": [...]` key landing outside
 * `extra_dirs` entirely, which parses, is silently ignored by the deploy, and leaves the
 * hash unchanged. That is exactly the failure the check exists for, manufactured by its
 * own fix. `install` catches it as a refusal because it re-runs the predicate over the
 * applier's output, and the two guards are worth having separately.
 *
 * Returns `null` when the entry an insert must follow cannot be found, rather than
 * producing a file with a missing comma that the consumer's own build reports as a syntax
 * error in a file this package edited.
 */
export function insertIntoBlock(
	text: string,
	block: JsonBlock,
	entries: readonly string[],
): string | null {
	if (entries.length === 0) return text;
	const closeLine = lineStart(text, block.close);

	if (closeLine <= block.open) {
		// One line. Expanded rather than kept on one, because the existing content is
		// carried through verbatim: splitting it on commas would be a second, weaker
		// parser that gets a nested array wrong.
		const outer = indentAt(text, block.open);
		const inner = `${outer}${detectIndent(text)}`;
		const existing = text.slice(block.open + 1, block.close).trim();
		const lines = [
			...(existing === '' ? [] : [existing.endsWith(',') ? existing : `${existing},`]),
			...entries.map((entry, index) => (index === entries.length - 1 ? entry : `${entry},`)),
		];
		const body = lines.map((line) => `${inner}${line}`).join('\n');
		return `${text.slice(0, block.open + 1)}\n${body}\n${outer}${text.slice(block.close)}`;
	}

	const indent = entryIndent(text, block);
	const previous = lastNonBlankBefore(text, closeLine);
	if (previous < 0) return null;

	const previousChar = text[previous];
	const needsComma = previousChar !== '{' && previousChar !== '[' && previousChar !== ',';
	const body = entries.map((entry) => `${indent}${entry}`).join(',\n');

	const head = needsComma ? `${text.slice(0, previous + 1)},` : text.slice(0, previous + 1);
	return `${head}${text.slice(previous + 1, closeLine)}${body}\n${text.slice(closeLine)}`;
}

/**
 * `soleBlock`, scoped to a region of the same text.
 *
 * Needed because a key that is unique inside its own object is rarely unique in the
 * file. `"front"` appears once inside `deploy.config.json`'s `hash.extra_dirs` and four
 * more times as a project key under `sites.*.projects`, so a whole-file search for it
 * finds five and refuses, and a search for the first one edits the wrong object.
 */
export function soleBlockIn(text: string, region: JsonBlock, key: string): JsonBlock | null {
	const inner = soleBlock(text.slice(region.open, region.close + 1), key);
	if (inner === null) return null;
	return { open: inner.open + region.open, close: inner.close + region.open, kind: inner.kind };
}

/** The indentation unit a JSON file uses, for a file that has to be re-serialised. */
export function detectIndent(text: string): string {
	const match = /\n([ \t]+)\S/.exec(text);
	return match?.[1] ?? '\t';
}
