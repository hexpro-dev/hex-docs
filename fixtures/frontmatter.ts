/**
 * A front matter reader for the fixture corpus, and nothing else.
 *
 * It understands exactly the subset the corpus uses and **refuses everything else by
 * name**. That refusal is what stops it becoming a second implementation that quietly
 * disagrees with the compiler's. A permissive reader here would accept front matter the
 * compiler rejects, the fixture suite would pass, and the corpus would be teaching a
 * shape the toolchain cannot read.
 *
 * This comment used to say the compiler would use a real YAML parser. It does not, and
 * the decision is recorded in `kit/src/compile/frontmatter.ts`: a general parser plus a
 * schema error says "expected string, received boolean" where a narrow reader says
 * "`title: yes` is YAML's boolean true, quote it". What now closes the two-readers risk
 * is not a shared implementation but a test: `kit/test/compile/frontmatter.test.ts`
 * asserts the two readers agree on every file in the corpus, in the values and in the
 * refusals.
 *
 * The subset: `key: scalar` and `key:` followed by indented `- item` lines. Scalars are
 * bare, or double quoted, or `true`. Nothing nested, no block scalars, no flow
 * collections, no anchors, no comments.
 *
 * It lives in the fixture rather than in `src/` because a website never reads markdown.
 */

export type FrontMatterValue = string | boolean | string[];

export interface FrontMatterResult {
	data: Record<string, FrontMatterValue>;
	/** Everything after the closing delimiter, with the leading blank line removed. */
	body: string;
	/** Key order as written, so a test can check a file rather than an object. */
	keys: string[];
}

const KEY_LINE = /^([A-Za-z][A-Za-z0-9_]*):[ \t]*(.*)$/;
const LIST_ITEM = /^[ \t]+-[ \t]+(.*)$/;

/**
 * Everything a plain scalar may not contain, and what YAML would do with it.
 *
 * Refusing by name is the whole contract of this file. The version this replaces used
 * `(.*)` and kept whatever it captured, so `title: a: b` came back as the string
 * "a: b" although YAML errors on it, and `title: x # y` kept the comment although YAML
 * drops it. Both made the corpus pass while teaching a shape the compiler's parser
 * would reject, which is the exact failure the header warns about.
 */
const BARE_SCALAR_REFUSALS: readonly { pattern: RegExp; what: string }[] = [
	{ pattern: /:\s/, what: 'a colon followed by a space, which YAML reads as a nested mapping' },
	{ pattern: /^#/, what: 'a leading #, which YAML reads as a comment' },
	{ pattern: /\s#/, what: 'a # after whitespace, which YAML reads as a trailing comment' },
	{ pattern: /^[|>]/, what: 'a block scalar indicator' },
	{ pattern: /^[*!%@`]/, what: 'a YAML indicator character' },
];

function scalar(raw: string, where: string): FrontMatterValue {
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	if (raw.startsWith('"')) {
		if (!raw.endsWith('"') || raw.length < 2) {
			throw new Error(`${where}: unterminated quoted scalar ${raw}.`);
		}
		const inner = raw.slice(1, -1);
		if (inner.includes('"')) {
			throw new Error(
				`${where}: ${raw} has a quote inside a quoted scalar. YAML needs it escaped, and this ` +
					`reader does not implement escapes, so it would strip the outer quotes off something ` +
					`YAML refuses.`,
			);
		}
		if (inner.includes('\\')) {
			throw new Error(
				`${where}: ${raw} contains a backslash. YAML expands escapes in a double-quoted scalar ` +
					`and this reader does not, so the two would disagree about the value.`,
			);
		}
		return inner;
	}
	if (raw.startsWith("'") || raw.startsWith('[') || raw.startsWith('{') || raw.startsWith('&')) {
		throw new Error(
			`${where}: ${raw[0]} starts a YAML construct this fixture reader does not implement. ` +
				`Widen the corpus to use it only after the compiler's parser is the one being tested.`,
		);
	}
	for (const refusal of BARE_SCALAR_REFUSALS) {
		if (refusal.pattern.test(raw)) {
			throw new Error(
				`${where}: ${JSON.stringify(raw)} contains ${refusal.what}. Quote it, or keep the corpus ` +
					`inside the subset this reader implements.`,
			);
		}
	}
	return raw;
}

/**
 * Splits a source file into its front matter and its body.
 *
 * Throws on anything outside the subset, naming the file and the line, because a
 * fixture the reader half understands is worse than one it refuses.
 */
export function parseFixtureFrontMatter(source: string, where: string): FrontMatterResult {
	const lines = source.split(/\r?\n/);
	if (lines[0] !== '---') {
		throw new Error(`${where}: no front matter. Every page and every snippet must declare one.`);
	}
	const close = lines.indexOf('---', 1);
	if (close === -1) throw new Error(`${where}: front matter is never closed.`);

	const data: Record<string, FrontMatterValue> = {};
	const keys: string[] = [];
	let current: string | undefined;

	for (let index = 1; index < close; index += 1) {
		const line = lines[index] as string;
		if (line.trim() === '') continue;

		const item = LIST_ITEM.exec(line);
		if (item !== null) {
			if (current === undefined) {
				throw new Error(`${where}:${index + 1}: a list item with no key above it.`);
			}
			const existing = data[current];
			if (!Array.isArray(existing)) {
				throw new Error(`${where}:${index + 1}: "${current}" already has a scalar value.`);
			}
			existing.push(String(scalar((item[1] as string).trim(), `${where}:${index + 1}`)));
			continue;
		}

		const entry = KEY_LINE.exec(line);
		if (entry === null) {
			throw new Error(
				`${where}:${index + 1}: ${JSON.stringify(line)} is not "key: value" or a list item.`,
			);
		}
		const key = entry[1] as string;
		// `Object.hasOwn` rather than `in`, so a key named `constructor` or `toString` is
		// not reported as a duplicate of something on the prototype.
		if (Object.hasOwn(data, key)) {
			throw new Error(`${where}:${index + 1}: "${key}" is declared twice.`);
		}
		const raw = (entry[2] as string).trim();
		keys.push(key);
		current = key;

		if (raw === '') {
			// `key:` with nothing after it is a list header here, and YAML would call it
			// null. The two readings differ, so this one insists the list is really there
			// rather than quietly inventing an empty array.
			const next = lines.slice(index + 1, close).find((candidate) => candidate.trim() !== '');
			if (next === undefined || LIST_ITEM.exec(next) === null) {
				throw new Error(
					`${where}:${index + 1}: "${key}" has no value and no list under it. YAML would read ` +
						`that as null; this reader will not guess between null and an empty list.`,
				);
			}
			data[key] = [];
			continue;
		}
		data[key] = scalar(raw, `${where}:${index + 1}`);
	}

	const body = lines.slice(close + 1).join('\n');
	return { data, keys, body: body.startsWith('\n') ? body.slice(1) : body };
}
