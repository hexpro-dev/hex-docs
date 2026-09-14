/**
 * Whether an SVG is inert, decided by an allowlist over a real reading of its XML.
 *
 * **Why an allowlist.** This used to be a denylist: a `script` element, a
 * `foreignObject`, an anchor with an `href`, a scheme in an `href` or a `src`, and any
 * `on*` attribute. An XHTML-namespaced `iframe` carrying `srcdoc` tripped none of those,
 * and a consuming site serves a bundle's SVG as a same-origin static file with no
 * Content-Security-Policy, so navigating to the asset ran the `srcdoc` script with access
 * to the site's origin. That was measured in headless Chrome against the real prefetched
 * file. A denylist is a list of the attacks somebody thought of, and the next one is an
 * element nobody listed. The question this module answers instead is whether every
 * construct in the file is one that is known to draw and nothing else.
 *
 * **What is allowed.** Elements in the SVG namespace whose local name is in
 * `SVG_ELEMENTS`: structure, shapes, text, gradients, patterns, clipping, masks, markers,
 * filter primitives and `style`. Attributes with no namespace that are geometry, a
 * presentation attribute, `id`, `class`, `role` or ARIA, plus `xml:space`, `xml:lang`
 * and `xlink:href`. Namespace declarations for SVG and XLink and nothing else. Every
 * `href` has to point at a fragment of this file, and every `url()` in a presentation
 * attribute, a `style` attribute or a `style` element has to as well.
 *
 * **What is refused, and why each one is not on the list.** Script, foreign content and
 * anything in another namespace run or embed a document. Links, `image` and `feImage`
 * exist to load something, and nothing they load is reachable through the `img` element
 * the renderer uses anyway. Animation (`set`, `animate` and the rest) changes attribute
 * values after load, so a check over the values as written cannot see what they become:
 * `<set attributeName="href" to="javascript:...">` is the known shape. Editor metadata in
 * an Inkscape or Illustrator namespace is inert in a browser and refused anyway, because
 * "another namespace is fine when it is that one" is exactly the judgement the denylist
 * got wrong.
 *
 * **The XML is read, not pattern matched**, because namespaces are scoped and a name
 * means nothing without its scope. `<svg:iframe>` is SVG only if `svg` is bound to the SVG
 * namespace where it is used, and a default namespace redeclared on a `g` moves every
 * element under it into that vocabulary. So this walks the document once with a stack of
 * scopes, the way a namespace-aware parser does.
 *
 * **What cannot be reasoned about is refused, and the walk stops there.** A processing
 * instruction other than the XML declaration, because `xml-stylesheet` attaches CSS or an
 * XSLT transform that can write script into the result. A DOCTYPE with an internal
 * subset, because it can define entities whose text becomes markup. A named entity
 * reference XML does not define without one. An encoding other than UTF-8, because every
 * check here reads the bytes as UTF-8 and a browser honouring the declaration would read
 * different characters out of them. And anything that is not well-formed: an unquoted or
 * repeated attribute, an undeclared prefix, a closing tag that does not match, a file that
 * ends inside a tag. A browser stops at the first fatal error, so each of those is inert in
 * practice, but a scan that carried on past a place it had misread would be reporting on a
 * document the browser never sees.
 *
 * Comments and CDATA outside `style` are skipped honestly rather than scanned for words.
 * A `<script>` inside a comment is text, and refusing it would be a rule about spelling
 * rather than about what runs.
 */

/** The only namespace an element may be in. */
export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
export const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
/** Bound to `xml` by the Namespaces in XML recommendation; no document declares it. */
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

/**
 * Element local names, compared case sensitively, as XML compares them.
 *
 * `image`, `feImage`, `a`, `foreignObject`, `script`, every animation element, `switch`,
 * `view`, `cursor` and the SVG font elements are absent on purpose, for the reasons at the
 * head of this module. `use` is present because its `href` is held to a fragment like
 * every other one.
 */
export const SVG_ELEMENTS: ReadonlySet<string> = new Set([
	// structure
	'svg',
	'g',
	'defs',
	'symbol',
	'use',
	'title',
	'desc',
	'metadata',
	'style',
	// shapes
	'path',
	'rect',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon',
	// text
	'text',
	'tspan',
	'textPath',
	// paint servers
	'linearGradient',
	'radialGradient',
	'stop',
	'pattern',
	// clipping, masking and markers
	'clipPath',
	'mask',
	'marker',
	// filters, with no feImage
	'filter',
	'feBlend',
	'feColorMatrix',
	'feComponentTransfer',
	'feComposite',
	'feConvolveMatrix',
	'feDiffuseLighting',
	'feDisplacementMap',
	'feDistantLight',
	'feDropShadow',
	'feFlood',
	'feFuncA',
	'feFuncB',
	'feFuncG',
	'feFuncR',
	'feGaussianBlur',
	'feMerge',
	'feMergeNode',
	'feMorphology',
	'feOffset',
	'fePointLight',
	'feSpecularLighting',
	'feSpotLight',
	'feTile',
	'feTurbulence',
]);

/**
 * Attributes with no namespace whose value is never parsed as CSS.
 *
 * Geometry, units, filter parameters and the text layout attributes. None of them can
 * name a resource, which is why none of them is read for a `url()`.
 */
const PLAIN_ATTRIBUTES: ReadonlySet<string> = new Set([
	'id',
	'class',
	'role',
	'lang',
	'version',
	'baseProfile',
	'viewBox',
	'preserveAspectRatio',
	'x',
	'y',
	'width',
	'height',
	'x1',
	'y1',
	'x2',
	'y2',
	'cx',
	'cy',
	'r',
	'rx',
	'ry',
	'fx',
	'fy',
	'fr',
	'd',
	'points',
	'pathLength',
	'transform',
	'gradientUnits',
	'gradientTransform',
	'spreadMethod',
	'offset',
	'patternUnits',
	'patternContentUnits',
	'patternTransform',
	'clipPathUnits',
	'maskUnits',
	'maskContentUnits',
	'markerWidth',
	'markerHeight',
	'markerUnits',
	'refX',
	'refY',
	'orient',
	'dx',
	'dy',
	'rotate',
	'textLength',
	'lengthAdjust',
	'startOffset',
	'method',
	'spacing',
	'side',
	'filterUnits',
	'primitiveUnits',
	'in',
	'in2',
	'result',
	'stdDeviation',
	'mode',
	'type',
	'values',
	'operator',
	'k1',
	'k2',
	'k3',
	'k4',
	'order',
	'kernelMatrix',
	'divisor',
	'bias',
	'targetX',
	'targetY',
	'edgeMode',
	'preserveAlpha',
	'surfaceScale',
	'diffuseConstant',
	'specularConstant',
	'specularExponent',
	'kernelUnitLength',
	'scale',
	'xChannelSelector',
	'yChannelSelector',
	'radius',
	'baseFrequency',
	'numOctaves',
	'seed',
	'stitchTiles',
	'azimuth',
	'elevation',
	'z',
	'pointsAtX',
	'pointsAtY',
	'pointsAtZ',
	'limitingConeAngle',
	'tableValues',
	'slope',
	'intercept',
	'amplitude',
	'exponent',
	'media',
]);

/**
 * Attributes whose value a browser parses as CSS: the presentation attributes and `style`.
 *
 * Separate from the plain ones because CSS is where a value can load something. `fill`,
 * `filter`, `clip-path`, `mask`, the markers and `cursor` all take a `url()`, and Firefox
 * fetches an external document for one. So each of these is read by `cssProblem`.
 */
const CSS_ATTRIBUTES: ReadonlySet<string> = new Set([
	'style',
	'alignment-baseline',
	'baseline-shift',
	'clip',
	'clip-path',
	'clip-rule',
	'color',
	'color-interpolation',
	'color-interpolation-filters',
	'color-rendering',
	'cursor',
	'direction',
	'display',
	'dominant-baseline',
	'enable-background',
	'fill',
	'fill-opacity',
	'fill-rule',
	'filter',
	'flood-color',
	'flood-opacity',
	'font',
	'font-family',
	'font-size',
	'font-size-adjust',
	'font-stretch',
	'font-style',
	'font-variant',
	'font-weight',
	'glyph-orientation-horizontal',
	'glyph-orientation-vertical',
	'image-rendering',
	'isolation',
	'kerning',
	'letter-spacing',
	'lighting-color',
	'marker',
	'marker-end',
	'marker-mid',
	'marker-start',
	'mask',
	'mask-type',
	'mix-blend-mode',
	'opacity',
	'overflow',
	'paint-order',
	'pointer-events',
	'shape-rendering',
	'stop-color',
	'stop-opacity',
	'stroke',
	'stroke-dasharray',
	'stroke-dashoffset',
	'stroke-linecap',
	'stroke-linejoin',
	'stroke-miterlimit',
	'stroke-opacity',
	'stroke-width',
	'text-anchor',
	'text-decoration',
	'text-rendering',
	'transform-origin',
	'unicode-bidi',
	'vector-effect',
	'visibility',
	'white-space',
	'word-spacing',
	'writing-mode',
]);

const ARIA_ATTRIBUTE = /^aria-[a-z]+$/;

/**
 * An XML name with at most one colon, in ASCII.
 *
 * Narrower than XML allows, which admits letters in any script. Nothing on either list is
 * spelled outside ASCII, so a wider name could only ever be refused, and refusing it here
 * as unreadable is the same answer with a clearer reason. Two colons is a namespace error
 * a browser stops on.
 */
const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?$/;

/** The five references XML defines without a DTD. */
const PREDEFINED_ENTITIES = new Map([
	['amp', '&'],
	['lt', '<'],
	['gt', '>'],
	['quot', '"'],
	['apos', "'"],
]);

/** Built rather than written as an escape, so this file carries no control character. */
const TAB_NEWLINE_RETURN = new RegExp(`[${String.fromCharCode(9, 10, 13)}]`, 'g');

/** Longest a quoted value may be in a message before it is cut. */
const SHOWN_VALUE = 60;

/** Most names one clause lists before it says how many more there are. */
const SHOWN_NAMES = 6;

/**
 * A value with every reference decoded, or the reason it cannot be.
 *
 * A browser resolves `&#106;avascript:` before it reads the scheme, and `&#64;import`
 * before the CSS parser sees an at-rule, so every check below runs on the decoded text.
 * A reference to a code point XML forbids, a named reference XML does not define, and a
 * bare ampersand are all fatal errors a browser stops at, and all of them are refused
 * rather than guessed at.
 */
function decodeReferences(text: string): { text: string } | { why: string } {
	let why: string | undefined;
	const decoded = text.replace(/&([^;&\s<]*);?/g, (whole, body: string) => {
		if (why !== undefined) return '';
		if (!whole.endsWith(';') || body === '') {
			why = 'an ampersand that does not start a reference';
			return '';
		}
		const numeric = /^#(?:[xX]([0-9a-fA-F]+)|([0-9]+))$/.exec(body);
		if (numeric !== null) {
			const code =
				numeric[1] !== undefined
					? Number.parseInt(numeric[1], 16)
					: Number.parseInt(numeric[2] as string, 10);
			const allowed =
				code === 0x9 ||
				code === 0xa ||
				code === 0xd ||
				(code >= 0x20 && code <= 0xd7ff) ||
				(code >= 0xe000 && code <= 0xfffd) ||
				(code >= 0x10000 && code <= 0x10ffff);
			if (!allowed) {
				why = `a character reference to a code point XML does not allow, "${whole}"`;
				return '';
			}
			return String.fromCodePoint(code);
		}
		const named = PREDEFINED_ENTITIES.get(body);
		if (named === undefined) {
			why = `the entity reference "${whole}", which XML does not define without a DTD`;
			return '';
		}
		return named;
	});
	return why === undefined ? { text: decoded } : { why };
}

/** A value short enough to put in a sentence, quoted. */
function shown(value: string): string {
	return JSON.stringify(value.length > SHOWN_VALUE ? `${value.slice(0, SHOWN_VALUE)}...` : value);
}

/**
 * Whether an `href` points at a fragment of this file, as a browser resolves it.
 *
 * Tab, newline and carriage return are removed rather than trimmed, because the URL
 * parser removes them anywhere and `java&#9;script:` is `javascript:` to it. What is left
 * has to start with `#`. A relative path is refused as well as a scheme: an SVG drawn
 * through an `img` loads nothing, so a relative reference does nothing useful there, and
 * navigated to directly it is a request on the site's own origin that nobody reviewed.
 */
function isFragment(value: string): boolean {
	return value.replace(TAB_NEWLINE_RETURN, '').trim().startsWith('#');
}

/**
 * What a CSS value can do that a drawing does not need, or `undefined`.
 *
 * Four things, each closing a way a stylesheet reaches outside the file.
 *
 * A backslash, because a CSS escape is decoded before the tokeniser decides what an
 * identifier is: `\75 rl(` is `url(`, and no pattern over the written text sees it.
 * Refusing the character is cheaper and more certain than decoding escapes a second time.
 *
 * A `url()` whose argument does not start with `#`. Case and whitespace before the
 * parenthesis are folded, which is wider than CSS, so `url (x)` is refused although it is
 * not a function. That is the direction to be wrong in.
 *
 * `image-set()`, `src()` and `attr()`, which take a URL as a bare string or out of an
 * attribute, with no `url(` to find.
 *
 * In a `style` element only, an at sign, which is `@import` and `@font-face`. A style
 * attribute holds declarations and has no at-rules to refuse.
 */
function cssProblem(css: string, sheet: boolean): string | undefined {
	if (css.includes('\\')) return 'a CSS escape';
	if (sheet && css.includes('@')) return 'an at-rule';
	if (/(?:image-set|\bsrc|\battr)\s*\(/i.test(css)) return 'a function that takes a URL as text';
	for (const match of css.matchAll(/url\s*\(\s*(["']?)\s*([^"')]*)/gi)) {
		// The second group always takes part in a match, empty or not.
		const target = match[2] as string;
		if (!isFragment(target)) return `a url() to ${shown(target.trim())}`;
	}
	return undefined;
}

type Scope = ReadonlyMap<string, string>;

interface OpenElement {
	readonly qname: string;
	readonly scope: Scope;
	/** An SVG `style` element, whose text is a stylesheet. */
	readonly sheet: boolean;
}

interface Attribute {
	readonly name: string;
	/** Normalised and decoded, which is what a browser hands the DOM. */
	readonly value: string;
}

type Tag =
	| {
			readonly name: string;
			readonly attributes: readonly Attribute[];
			readonly selfClosing: boolean;
			readonly end: number;
	  }
	| { readonly why: string };

function isSpace(char: string | undefined): boolean {
	return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/**
 * One start tag, from the `<` to just past its `>`.
 *
 * XML's own syntax and nothing looser. A value has to be quoted, may not contain `<`, and
 * has its literal tab, newline and carriage return turned into spaces before references
 * are decoded, which is the attribute-value normalisation a parser applies. Attributes
 * have to be separated by whitespace. Every departure is a fatal error in a browser and a
 * refusal here.
 */
function readTag(source: string, start: number): Tag {
	const opened = /^<([^\s/>]+)/.exec(source.slice(start, start + 256));
	if (opened === null) return { why: 'a "<" that does not open a tag' };
	const name = opened[1] as string;
	if (!XML_NAME.test(name)) return { why: `the element name ${shown(name)}` };

	const attributes: Attribute[] = [];
	let at = start + opened[0].length;
	for (;;) {
		const before = at;
		while (isSpace(source[at])) at += 1;
		if (at >= source.length) return { why: 'the file ends inside a tag' };
		if (source.startsWith('/>', at)) {
			return { name, attributes, selfClosing: true, end: at + 2 };
		}
		if (source[at] === '>') return { name, attributes, selfClosing: false, end: at + 1 };
		if (at === before) return { why: `attributes on <${name}> that are not separated` };

		const named = /^[^\s=/>]+/.exec(source.slice(at, at + 256));
		const attribute = named?.[0] ?? '';
		if (!XML_NAME.test(attribute)) return { why: `the attribute name ${shown(attribute)}` };
		at += attribute.length;
		while (isSpace(source[at])) at += 1;
		if (source[at] !== '=') {
			return at >= source.length
				? { why: 'the file ends inside a tag' }
				: { why: `the attribute ${attribute} with no value` };
		}
		at += 1;
		while (isSpace(source[at])) at += 1;
		if (at >= source.length) return { why: 'the file ends inside a tag' };
		const quote = source[at];
		if (quote !== '"' && quote !== "'") {
			return { why: `the unquoted value of ${attribute}` };
		}
		const close = source.indexOf(quote, at + 1);
		if (close === -1) return { why: 'the file ends inside a tag' };
		const literal = source.slice(at + 1, close);
		if (literal.includes('<')) return { why: `a "<" inside the value of ${attribute}` };
		const decoded = decodeReferences(literal.replace(TAB_NEWLINE_RETURN, ' '));
		if ('why' in decoded) return { why: decoded.why };
		attributes.push({ name: attribute, value: decoded.text });
		at = close + 1;
	}
}

/** The prefix and the local part of a qualified name. */
function split(qname: string): { prefix: string | null; local: string } {
	const colon = qname.indexOf(':');
	return colon === -1
		? { prefix: null, local: qname }
		: { prefix: qname.slice(0, colon), local: qname.slice(colon + 1) };
}

/** Distinct entries in the order they were first met, cut to a readable length. */
function listed(entries: ReadonlySet<string>): string {
	const all = [...entries];
	const head = all.slice(0, SHOWN_NAMES).join(', ');
	return all.length > SHOWN_NAMES ? `${head} and ${all.length - SHOWN_NAMES} more` : head;
}

/**
 * The index just past a DOCTYPE, or the reason it is refused.
 *
 * Quoted public and system identifiers are stepped over, because either may contain a `>`
 * or a `[`. An internal subset is refused, since it is where entities are declared, and
 * an external one is not: no browser fetches an external DTD for an SVG document, so the
 * identifiers name nothing that is read.
 */
function readDoctype(source: string, start: number): { end: number } | { why: string } {
	let at = start + '<!DOCTYPE'.length;
	while (at < source.length) {
		const char = source[at];
		if (char === '"' || char === "'") {
			const close = source.indexOf(char, at + 1);
			if (close === -1) break;
			at = close + 1;
			continue;
		}
		if (char === '[') {
			return { why: 'a DOCTYPE with an internal subset, which can declare entities' };
		}
		if (char === '>') return { end: at + 1 };
		at += 1;
	}
	return { why: 'a DOCTYPE that is not closed' };
}

interface Clauses {
	readonly elements: Set<string>;
	readonly foreign: Set<string>;
	readonly declarations: Set<string>;
	readonly handlers: Set<string>;
	readonly attributes: Set<string>;
	readonly references: Set<string>;
	readonly css: Set<string>;
}

function report(clauses: Clauses): string[] {
	const problems: string[] = [];
	if (clauses.declarations.size > 0) {
		problems.push(
			`namespace declarations other than SVG and XLink (${listed(clauses.declarations)})`,
		);
	}
	if (clauses.elements.size > 0) {
		problems.push(`elements the SVG allowlist does not name (${listed(clauses.elements)})`);
	}
	if (clauses.foreign.size > 0) {
		problems.push(`elements outside the SVG namespace (${listed(clauses.foreign)})`);
	}
	if (clauses.handlers.size > 0) {
		problems.push(`event handler attributes (${listed(clauses.handlers)})`);
	}
	if (clauses.attributes.size > 0) {
		problems.push(`attributes the allowlist does not name (${listed(clauses.attributes)})`);
	}
	if (clauses.references.size > 0) {
		problems.push(
			`references to something other than a fragment of this file (${listed(clauses.references)})`,
		);
	}
	if (clauses.css.size > 0) {
		problems.push(`CSS that can reach outside the file (${listed(clauses.css)})`);
	}
	return problems;
}

/**
 * What stops an SVG being published, one string per clause.
 *
 * One per clause rather than one per occurrence, and each clause lists every distinct
 * offender, so an author fixes the whole file in one pass instead of publishing five
 * times. An empty array means every construct in the file is on the allowlist.
 *
 * When the walk meets XML it cannot reason about, it stops, and the last string says what
 * and where it stopped. The clauses found before that point are still reported.
 */
export function svgProblems(source: string): string[] {
	const clauses: Clauses = {
		elements: new Set(),
		foreign: new Set(),
		declarations: new Set(),
		handlers: new Set(),
		attributes: new Set(),
		references: new Set(),
		css: new Set(),
	};
	const stop = (why: string): string[] => [
		...report(clauses),
		`XML this check cannot reason about (${why})`,
	];

	const base: Scope = new Map([['xml', XML_NAMESPACE]]);
	const stack: OpenElement[] = [];
	let sheet = '';
	let rootSeen = false;
	let at = 0;

	// The XML declaration, which is the one processing instruction allowed, and only first.
	if (/^<\?xml[\s?]/.test(source)) {
		const end = source.indexOf('?>');
		if (end === -1) return stop('an XML declaration that is not closed');
		const encoding = /\sencoding\s*=\s*(["'])([^"']*)\1/.exec(source.slice(0, end))?.[2];
		if (encoding !== undefined && !/^utf-8$/i.test(encoding)) {
			return stop(
				`the declared encoding ${shown(encoding)}: every check here reads the file as UTF-8, and a browser would read it as that`,
			);
		}
		at = end + 2;
	}

	while (at < source.length) {
		const lt = source.indexOf('<', at);
		const textEnd = lt === -1 ? source.length : lt;
		if (textEnd > at) {
			const text = source.slice(at, textEnd);
			const top = stack.at(-1);
			if (top === undefined) {
				if (text.trim() !== '') return stop('text outside the root element');
			} else {
				const decoded = decodeReferences(text);
				if ('why' in decoded) return stop(decoded.why);
				if (top.sheet) sheet += decoded.text;
			}
		}
		if (lt === -1) break;
		at = lt;

		if (source.startsWith('<!--', at)) {
			const end = source.indexOf('-->', at + 4);
			if (end === -1) return stop('a comment that is not closed');
			at = end + 3;
			continue;
		}
		if (source.startsWith('<![CDATA[', at)) {
			const top = stack.at(-1);
			if (top === undefined) return stop('a CDATA section outside the root element');
			const end = source.indexOf(']]>', at);
			if (end === -1) return stop('a CDATA section that is not closed');
			if (top.sheet) sheet += source.slice(at + '<![CDATA['.length, end);
			at = end + 3;
			continue;
		}
		if (source.startsWith('<?', at)) {
			return stop(
				'a processing instruction, which can attach a stylesheet or a transform to the file',
			);
		}
		if (source.startsWith('<!DOCTYPE', at)) {
			if (rootSeen) return stop('a DOCTYPE after the root element');
			const doctype = readDoctype(source, at);
			if ('why' in doctype) return stop(doctype.why);
			at = doctype.end;
			continue;
		}
		if (source.startsWith('<!', at)) return stop('a markup declaration outside a DOCTYPE');

		if (source.startsWith('</', at)) {
			const closing = /^<\/([^\s>]+)\s*>/.exec(source.slice(at, at + 256));
			const open = stack.pop();
			if (closing === null || open === undefined || open.qname !== closing[1]) {
				return stop('a closing tag that does not match the element it closes');
			}
			if (open.sheet) {
				const problem = cssProblem(sheet, true);
				if (problem !== undefined) clauses.css.add(`style element: ${problem}`);
				sheet = '';
			}
			at += closing[0].length;
			continue;
		}

		const tag = readTag(source, at);
		if ('why' in tag) return stop(tag.why);
		if (rootSeen && stack.length === 0) return stop('a second root element');
		if (stack.at(-1)?.sheet === true) return stop('an element inside a style element');
		rootSeen = true;

		// Declarations first, because a declaration on an element is in scope for that
		// element's own name and its own attributes.
		const scope = new Map(stack.at(-1)?.scope ?? base);
		for (const { name, value } of tag.attributes) {
			if (name === 'xmlns') {
				if (value !== SVG_NAMESPACE) clauses.declarations.add(shown(value));
				scope.set('', value);
			} else if (name.startsWith('xmlns:')) {
				const prefix = name.slice('xmlns:'.length);
				const allowed =
					prefix === 'xml'
						? value === XML_NAMESPACE
						: value === SVG_NAMESPACE || value === XLINK_NAMESPACE;
				if (!allowed) clauses.declarations.add(`${prefix} ${shown(value)}`);
				scope.set(prefix, value);
			}
		}

		const element = split(tag.name);
		const namespace = scope.get(element.prefix ?? '');
		if (element.prefix !== null && namespace === undefined) {
			return stop(`the undeclared prefix "${element.prefix}"`);
		}
		const isSvg = namespace === SVG_NAMESPACE;
		if (!isSvg) {
			const where = namespace === undefined || namespace === '' ? 'no namespace' : namespace;
			clauses.foreign.add(`${element.local} in ${where}`);
		} else if (!SVG_ELEMENTS.has(element.local)) {
			clauses.elements.add(element.local);
		}

		const seen = new Set<string>();
		for (const { name, value } of tag.attributes) {
			if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
			const attribute = split(name);
			let attributeNamespace: string | null = null;
			if (attribute.prefix !== null) {
				const bound = scope.get(attribute.prefix);
				if (bound === undefined) return stop(`the undeclared prefix "${attribute.prefix}"`);
				attributeNamespace = bound;
			}
			// Compared expanded, so `xlink:href` and `x:href` bound to the same namespace are
			// the one attribute written twice.
			const expanded = `${attributeNamespace ?? ''} ${attribute.local}`;
			if (seen.has(expanded)) return stop(`the attribute ${name} written twice on <${tag.name}>`);
			seen.add(expanded);

			if (attributeNamespace !== null) {
				if (attributeNamespace === XLINK_NAMESPACE && attribute.local === 'href') {
					if (!isFragment(value)) clauses.references.add(`${name} ${shown(value)}`);
				} else if (
					attributeNamespace !== XML_NAMESPACE ||
					(attribute.local !== 'space' && attribute.local !== 'lang')
				) {
					clauses.attributes.add(name);
				}
				continue;
			}
			if (/^on/i.test(name)) {
				clauses.handlers.add(name);
			} else if (name === 'href') {
				if (!isFragment(value)) clauses.references.add(`href ${shown(value)}`);
			} else if (CSS_ATTRIBUTES.has(name)) {
				const problem = cssProblem(value, false);
				if (problem !== undefined) clauses.css.add(`${name}: ${problem}`);
			} else if (!PLAIN_ATTRIBUTES.has(name) && !ARIA_ATTRIBUTE.test(name)) {
				clauses.attributes.add(name);
			}
		}

		if (!tag.selfClosing) {
			stack.push({ qname: tag.name, scope, sheet: isSvg && element.local === 'style' });
		}
		at = tag.end;
	}

	if (stack.length > 0) return stop('the file ends inside an element');
	if (!rootSeen) return stop('no root element');
	return report(clauses);
}

/** Strict, so a byte sequence that is not UTF-8 is a refusal rather than a replacement. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * `svgProblems` over the bytes of a file.
 *
 * Decoded strictly. A replacing decoder turns a malformed sequence into U+FFFD, and a
 * check that reads the replacement is reading characters the file does not contain. A
 * leading byte order mark is still removed, as a browser removes it.
 */
export function svgFileProblems(bytes: Uint8Array): string[] {
	let source: string;
	try {
		source = STRICT_UTF8.decode(bytes);
	} catch {
		return ['XML this check cannot reason about (bytes that are not valid UTF-8)'];
	}
	return svgProblems(source);
}
