/**
 * Import extraction for the runtime half's dependency gate.
 *
 * Hand-rolled rather than parsed, because this runs before anything is installed and
 * because it has to keep working when it is copied into a consumer repository as a
 * `prebuild` guard. Zero dependencies is the property it exists to defend, so it
 * cannot itself have one.
 *
 * The only correctness requirement is that it never blanks real code. Blanking a
 * comment it should have kept costs nothing; blanking an import statement it should
 * have seen would hide the exact failure this guard exists for.
 */

const IDENT_END = /[A-Za-z0-9_$)\]}'"`]/;

/**
 * Replaces comment bodies with spaces, preserving every offset so line numbers still
 * line up with the original source.
 *
 * String literals are left intact, because the specifiers this scanner is looking
 * for live inside them. A string that happens to contain `from 'react'` is therefore
 * a false positive. That is the right way round: the guard reports a file and a line,
 * a human looks, and nothing was let through.
 *
 * Regex literals are tracked for one reason. `/a\/*b/` contains the byte pair `/*`,
 * and treating that as the start of a block comment would blank everything up to the
 * next comment terminator, potentially swallowing a real import. A regex literal can
 * never begin with a slash-star pair, since an unescaped star has nothing to repeat,
 * so the ambiguity only ever arises inside one.
 *
 * @param {string} source
 * @returns {string} Same length as `source`, comments replaced by spaces.
 */
export function blankComments(source) {
	const out = source.split('');
	/** @type {'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex'} */
	let state = 'code';
	let lastSignificant = '';

	for (let i = 0; i < source.length; i += 1) {
		const char = source[i];
		const next = source[i + 1];

		switch (state) {
			case 'code': {
				if (char === '/' && next === '/') {
					state = 'line';
					out[i] = ' ';
					out[i + 1] = ' ';
					i += 1;
				} else if (char === '/' && next === '*') {
					state = 'block';
					out[i] = ' ';
					out[i + 1] = ' ';
					i += 1;
				} else if (char === "'") {
					state = 'single';
				} else if (char === '"') {
					state = 'double';
				} else if (char === '`') {
					state = 'template';
				} else if (char === '/' && !IDENT_END.test(lastSignificant)) {
					state = 'regex';
				}
				if (char !== undefined && char.trim() !== '') lastSignificant = char;
				break;
			}
			case 'line': {
				if (char === '\n') state = 'code';
				else out[i] = ' ';
				break;
			}
			case 'block': {
				if (char === '*' && next === '/') {
					out[i] = ' ';
					out[i + 1] = ' ';
					i += 1;
					state = 'code';
				} else if (char !== '\n') {
					out[i] = ' ';
				}
				break;
			}
			case 'single':
			case 'double':
			case 'template':
			case 'regex': {
				const closer =
					state === 'single' ? "'" : state === 'double' ? '"' : state === 'template' ? '`' : '/';
				if (char === '\\') {
					i += 1;
				} else if (char === closer) {
					state = 'code';
					lastSignificant = char === '/' ? ')' : char;
				} else if (char === '\n' && state !== 'template') {
					// An unterminated quote or an unmatched division. Recover rather than
					// blanking the rest of the file, which is the only outcome that could
					// hide an import.
					state = 'code';
				}
				break;
			}
		}
	}

	return out.join('');
}

/**
 * @typedef {object} ImportRecord
 * @property {string} specifier
 * @property {number} line 1-based.
 * @property {'static' | 'dynamic' | 'computed'} form  `computed` carries no specifier.
 */

// Backticks included: `await import(`./x.js`)` is ordinary code and the previous
// patterns did not see it, so a dynamic import written that way was invisible to the
// dependency gate.
//
// `(^|[^\w$.])` rather than `\b`, because a word boundary matches after a dot and
// `registry.import('./x.js')` is a method call, not an import. The scanner is allowed
// false positives inside string literals, where a human looks and nothing was let
// through, but a diagnostic about a line that contains no import is how a guard loses
// its reader.
const STATIC_FROM = /(?:^|[^\w$.])from\s*(['"`])((?:[^'"`\\]|\\.)*)\1/g;
const BARE_IMPORT = /(?:^|[^\w$.])import\s*(['"`])((?:[^'"`\\]|\\.)*)\1/g;

/**
 * Every `import(` call site, however its argument is written.
 *
 * Matching the call rather than a literal is the whole point. The previous version
 * matched a quoted specifier and, separately, a backtick with an interpolation in it,
 * which left two forms invisible: `import(name)` produced no record at all and passed
 * every check in the gate, and `import('./locales/' + locale + '.json')` was recorded
 * as the concrete specifier `./locales/`, surviving only because a trailing slash trips
 * the extension rule with a message about the wrong thing.
 *
 * `import.meta` is excluded by requiring the parenthesis.
 */
const CALL_SITE = /(?:^|[^\w$.])import\s*\(/g;

/**
 * The argument of an `import(` call, when it is one complete string literal.
 *
 * Returns the specifier, or `null` when the call is anything else: an identifier, a
 * concatenation, a conditional, a template with an interpolation, or a literal followed
 * by more expression. `null` is what makes the call site report as `computed`, and
 * reporting is the only honest answer for a specifier this scanner cannot resolve.
 *
 * Escapes are read rather than terminating the literal, so `import('./we\\'ird.js')`
 * yields `./we'ird.js` rather than the truncated `./we\\`, which used to be reported
 * against the extension rule with a message that did not describe the code.
 *
 * @param {string} code Comment-blanked source.
 * @param {number} start Offset just past the opening parenthesis.
 * @returns {string | null}
 */
function readArgument(code, start) {
	let i = start;
	while (i < code.length && /\s/.test(code[i] ?? '')) i += 1;
	const quote = code[i];
	if (quote !== "'" && quote !== '"' && quote !== '`') return null;

	let value = '';
	i += 1;
	while (i < code.length) {
		const char = code[i] ?? '';
		if (char === '\\') {
			value += code[i + 1] ?? '';
			i += 2;
			continue;
		}
		if (char === quote) break;
		// An interpolation means the specifier is built at runtime, whatever surrounds it.
		if (quote === '`' && char === '$' && code[i + 1] === '{') return null;
		if (char === '\n' && quote !== '`') return null;
		value += char;
		i += 1;
	}
	if (i >= code.length) return null;

	// The literal has to be the whole argument. `import('./a' + b)` is computed, and
	// reading it as `./a` is how a gate reports a path nothing ever loads.
	i += 1;
	while (i < code.length && /\s/.test(code[i] ?? '')) i += 1;
	return code[i] === ')' ? value : null;
}

/**
 * Every module specifier in a source file, with the line it sits on.
 *
 * @param {string} source
 * @returns {ImportRecord[]}
 */
export function scanImports(source) {
	const code = blankComments(source);

	/** @type {number[]} */
	const lineStarts = [0];
	for (let i = 0; i < code.length; i += 1) {
		if (code[i] === '\n') lineStarts.push(i + 1);
	}
	/** @param {number} offset */
	const lineOf = (offset) => {
		let low = 0;
		let high = lineStarts.length - 1;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if ((lineStarts[mid] ?? 0) <= offset) low = mid;
			else high = mid - 1;
		}
		return low + 1;
	};

	/** @type {Map<string, ImportRecord>} */
	const found = new Map();

	/**
	 * @param {RegExp} pattern
	 * @param {'static' | 'dynamic' | 'computed'} form
	 */
	const collect = (pattern, form) => {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(code)) !== null) {
			const specifier = match[2];
			if (specifier === undefined) continue;
			// A template with an interpolation is not a specifier. Left alone it reads as
			// an ordinary relative import and passes every check in the gate. Static
			// `from` cannot legally carry one, so this only ever fires on a false
			// positive inside a string, where dropping it is the right answer.
			if (specifier.includes('${')) continue;
			const line = lineOf(match.index);
			found.set(`${line}:${specifier}`, { specifier, line: line, form });
		}
	};

	collect(STATIC_FROM, 'static');
	collect(BARE_IMPORT, 'static');

	// Every `import(` call site. A record is emitted for all of them: one carrying the
	// specifier when the argument is a single complete literal, and one marked
	// `computed` otherwise. The second is the honest answer for an argument this
	// scanner cannot resolve, and it is what the gate refuses on.
	CALL_SITE.lastIndex = 0;
	let call;
	while ((call = CALL_SITE.exec(code)) !== null) {
		const open = call.index + call[0].length;
		const line = lineOf(open);
		const literal = readArgument(code, open);
		if (literal === null) {
			found.set(`${line}:computed`, { specifier: '', line, form: 'computed' });
		} else {
			found.set(`${line}:${literal}`, { specifier: literal, line, form: 'dynamic' });
		}
	}

	return [...found.values()].sort(
		(a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier),
	);
}

/**
 * Bare, relative or builtin. A specifier is bare when it names a package, which is
 * the only kind that has to exist in the consumer's `node_modules`.
 *
 * @param {string} specifier
 * @returns {'relative' | 'builtin' | 'bare' | 'absolute'}
 */
export function classifySpecifier(specifier) {
	if (specifier.startsWith('.')) return 'relative';
	if (specifier.startsWith('node:')) return 'builtin';
	if (specifier.startsWith('/')) return 'absolute';
	return 'bare';
}

/**
 * The package a bare specifier belongs to, so `react/jsx-runtime` is checked against
 * the allowlist as `react`.
 *
 * @param {string} specifier
 * @returns {string}
 */
export function packageOf(specifier) {
	const parts = specifier.split('/');
	if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
	return parts[0] ?? specifier;
}
