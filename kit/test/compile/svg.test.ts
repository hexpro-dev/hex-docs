/**
 * The SVG allowlist, attacked with the shapes that got past the denylist it replaced.
 *
 * The first block is the step 8 review's payload and its variations. The denylist this
 * module replaced passed every one of them, and headless Chrome ran the first one's
 * `srcdoc` script with access to the consuming site's origin, so each of those is a
 * regression case rather than a hypothetical. The rest pin each arm of the walk by the
 * clause it produces, because a clause that stopped firing leaves a file that publishes
 * with nothing red anywhere.
 *
 * Every expected list is written out whole rather than matched loosely. A refusal that
 * also names a construct it should have allowed is a file somebody cannot publish for a
 * reason that is not true, and a loose match would not see it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { REJECTED_ROOT } from '../../../fixtures/index.js';
import { SVG_ELEMENTS, svgFileProblems, svgProblems } from '../../src/compile/svg.js';

const SVG = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';
const XLINK = 'http://www.w3.org/1999/xlink';

/** A document in the SVG namespace around a body. */
const doc = (body: string, attributes = ''): string =>
	`<svg xmlns="${SVG}"${attributes}>${body}</svg>`;

/** The clause the walk ends with when it stops. */
const stopped = (why: string): string => `XML this check cannot reason about (${why})`;

// ---------------------------------------------------------------------------
// What got past the denylist
// ---------------------------------------------------------------------------

describe('the shapes the denylist passed', () => {
	test('the review payload, an XHTML iframe with srcdoc, is refused naming the namespace and the attribute', () => {
		// `fixtures/rejected/srcdoc-iframe.svg`, in the shape it was measured in. Served as
		// `image/svg+xml` with no Content-Security-Policy and navigated to, it set the site's
		// document title from inside the frame.
		const payload = readFileSync(join(REJECTED_ROOT, 'srcdoc-iframe.svg'));
		expect(svgFileProblems(payload)).toEqual([
			`namespace declarations other than SVG and XLink ("${XHTML}")`,
			`elements outside the SVG namespace (iframe in ${XHTML})`,
			'attributes the allowlist does not name (srcdoc)',
		]);
	});

	test('the same iframe written in the SVG namespace is refused by name', () => {
		expect(svgProblems(doc('<iframe srcdoc="x"/>'))).toEqual([
			'elements the SVG allowlist does not name (iframe)',
			'attributes the allowlist does not name (srcdoc)',
		]);
	});

	test('a prefix bound to XHTML is XHTML, whatever it is called', () => {
		expect(
			svgProblems(
				doc('<h:iframe srcdoc="x"/><svg:rect/>', ` xmlns:h="${XHTML}" xmlns:svg="${XHTML}"`),
			),
		).toEqual([
			`namespace declarations other than SVG and XLink (h "${XHTML}", svg "${XHTML}")`,
			`elements outside the SVG namespace (iframe in ${XHTML}, rect in ${XHTML})`,
			'attributes the allowlist does not name (srcdoc)',
		]);
	});

	test('a prefix bound to SVG is SVG, so an allowlisted name under it passes', () => {
		expect(svgProblems(doc('<s:rect width="1"/>', ` xmlns:s="${SVG}"`))).toEqual([]);
	});

	test('a default namespace redeclared on a child moves everything under it', () => {
		// `rect` is on the allowlist, and it is refused here, because it is not an SVG rect.
		// A check that compared local names without resolving the scope would pass it.
		expect(svgProblems(doc(`<g xmlns="${XHTML}"><rect/></g>`))).toEqual([
			`namespace declarations other than SVG and XLink ("${XHTML}")`,
			`elements outside the SVG namespace (g in ${XHTML}, rect in ${XHTML})`,
		]);
	});

	test('a document with no namespace at all is refused, element by element', () => {
		expect(svgProblems('<svg width="1"><rect/></svg>')).toEqual([
			'elements outside the SVG namespace (svg in no namespace, rect in no namespace)',
		]);
		expect(svgProblems(doc('<g xmlns=""/>'))).toEqual([
			'namespace declarations other than SVG and XLink ("")',
			'elements outside the SVG namespace (g in no namespace)',
		]);
	});

	test('embedding elements in XHTML are refused', () => {
		expect(
			svgProblems(
				doc(
					`<object xmlns="${XHTML}" data="https://example.com/x"/><embed xmlns="${XHTML}" src="x.swf"/>`,
				),
			),
		).toEqual([
			`namespace declarations other than SVG and XLink ("${XHTML}")`,
			`elements outside the SVG namespace (object in ${XHTML}, embed in ${XHTML})`,
			'attributes the allowlist does not name (data, src)',
		]);
	});
});

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/** Elements that run, embed, link, load or animate, none of which may be on the list. */
const REFUSED_ELEMENTS = [
	'script',
	'foreignObject',
	'a',
	'image',
	'feImage',
	'set',
	'animate',
	'animateMotion',
	'animateTransform',
	'mpath',
	'discard',
	'switch',
	'view',
	'cursor',
	'font',
	'glyph',
	'iframe',
	'handler',
	'listener',
];

describe('elements', () => {
	test('the allowlist carries none of the elements that run, embed, link, load or animate', () => {
		expect(REFUSED_ELEMENTS.filter((name) => SVG_ELEMENTS.has(name))).toEqual([]);
	});

	test.each(REFUSED_ELEMENTS)('%s is refused by name', (name) => {
		expect(svgProblems(doc(`<${name}/>`))).toEqual([
			`elements the SVG allowlist does not name (${name})`,
		]);
	});

	test('names are compared as XML compares them, so a capital is a different element', () => {
		expect(svgProblems(doc('<Rect/><SCRIPT/>'))).toEqual([
			'elements the SVG allowlist does not name (Rect, SCRIPT)',
		]);
	});

	test('an animation that would rewrite an href is refused along with its attributes', () => {
		expect(
			svgProblems(doc('<use href="#a"><set attributeName="href" to="javascript:alert(1)"/></use>')),
		).toEqual([
			'elements the SVG allowlist does not name (set)',
			'attributes the allowlist does not name (attributeName, to)',
		]);
	});

	test('every drawing element on the list passes', () => {
		const body = [...SVG_ELEMENTS]
			.filter((name) => name !== 'svg' && name !== 'style')
			.map((name) => `<${name}/>`)
			.join('');
		expect(svgProblems(doc(body))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

describe('attributes', () => {
	test('an event handler is its own clause, in any case', () => {
		expect(svgProblems(doc('<rect onload="x()" OnClick="y()" onbegin="z()"/>'))).toEqual([
			'event handler attributes (onload, OnClick, onbegin)',
		]);
	});

	test('anything not on the list is refused, data attributes and xml:base included', () => {
		expect(
			svgProblems(doc('<rect data-x="1" xml:base="https://example.com/" tabindex="0"/>')),
		).toEqual(['attributes the allowlist does not name (data-x, xml:base, tabindex)']);
	});

	test('editor metadata in its own namespace is refused, declaration and attribute both', () => {
		const inkscape = 'http://www.inkscape.org/namespaces/inkscape';
		expect(
			svgProblems(doc('<g inkscape:label="Layer 1"/>', ` xmlns:inkscape="${inkscape}"`)),
		).toEqual([
			`namespace declarations other than SVG and XLink (inkscape "${inkscape}")`,
			'attributes the allowlist does not name (inkscape:label)',
		]);
	});

	test('the xml prefix may be declared only as itself', () => {
		expect(
			svgProblems(
				doc('', ' xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:space="preserve"'),
			),
		).toEqual([]);
		expect(svgProblems(doc('', ` xmlns:xml="${XHTML}"`))).toEqual([
			`namespace declarations other than SVG and XLink (xml "${XHTML}")`,
		]);
	});

	test('geometry, presentation, ARIA, role and the two xml attributes pass', () => {
		expect(
			svgProblems(
				doc(
					'<rect x="1" y="2" width="3" height="4" rx="1" fill="#fff" stroke="currentColor" ' +
						'stroke-width="2" aria-hidden="true" role="presentation" class="a b" id="r" ' +
						'xml:lang="en"/>',
					' viewBox="0 0 4 4" xml:space="preserve"',
				),
			),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

describe('references', () => {
	test('an href to anything but a fragment is refused, relative paths included', () => {
		expect(
			svgProblems(
				doc(
					'<use href="https://example.com/a.svg#x"/><use href="//example.com/a"/>' +
						'<use href="data:image/svg+xml;base64,AA"/><use href="tile.svg#x"/><use href="?a=1"/>',
				),
			),
		).toEqual([
			'references to something other than a fragment of this file (href "https://example.com/a.svg#x", href "//example.com/a", href "data:image/svg+xml;base64,AA", href "tile.svg#x", href "?a=1")',
		]);
	});

	test('a scheme spelled with character references is decoded before it is read', () => {
		expect(
			svgProblems(
				doc(
					'<use href="&#106;avascript:a()"/><use href="&#X6A;avascript:b()"/><use href="java&#9;script:c()"/>',
				),
			),
		).toEqual([
			`references to something other than a fragment of this file (href "javascript:a()", href "javascript:b()", href "java\\tscript:c()")`,
		]);
	});

	test('xlink:href is held to the same rule under whatever prefix XLink is bound to', () => {
		expect(
			svgProblems(
				doc(
					'<use xlink:href="https://example.com/a#b"/><use l:href="#ok"/><use l:title="x"/>',
					` xmlns:xlink="${XLINK}" xmlns:l="${XLINK}"`,
				),
			),
		).toEqual([
			'attributes the allowlist does not name (l:title)',
			'references to something other than a fragment of this file (xlink:href "https://example.com/a#b")',
		]);
	});

	test('a fragment passes, with the whitespace a URL parser removes around it', () => {
		expect(
			svgProblems(
				doc(
					`<use href="#a"/><use xlink:href="  #b"/><use href="&#10;#c"/>`,
					` xmlns:xlink="${XLINK}"`,
				),
			),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

describe('CSS', () => {
	test('a url() to anything but a fragment is refused in a presentation attribute and in style', () => {
		expect(
			svgProblems(
				doc(
					'<rect fill="url(https://example.com/p.svg#p)"/><rect style="filter: URL( \'//x/f\' )"/>' +
						'<rect cursor="url(x.png), auto"/>',
				),
			),
		).toEqual([
			'CSS that can reach outside the file (fill: a url() to "https://example.com/p.svg#p", style: a url() to "//x/f", cursor: a url() to "x.png")',
		]);
	});

	test('an escape, image-set, src() and attr() are refused, because none needs url( to load', () => {
		expect(
			svgProblems(
				doc(
					'<rect style="fill:\\75 rl(https://x/p)"/><rect style="mask-image:-webkit-image-set(\'x.png\' 1x)"/>' +
						'<rect style="mask:src(\'x\')"/><rect style="fill:attr(data-x type(&lt;url&gt;))"/>',
				),
			),
		).toEqual([
			'CSS that can reach outside the file (style: a CSS escape, style: a function that takes a URL as text)',
		]);
	});

	test('a stylesheet is read for at-rules and urls, after references and CDATA are unwrapped', () => {
		expect(svgProblems(doc('<style>@import url(https://example.com/a.css);</style>'))).toEqual([
			'CSS that can reach outside the file (style element: an at-rule)',
		]);
		expect(svgProblems(doc('<style>&#64;font-face{src:x}</style>'))).toEqual([
			'CSS that can reach outside the file (style element: an at-rule)',
		]);
		expect(svgProblems(doc('<style><![CDATA[.a{fill:url(https://x/p)}]]></style>'))).toEqual([
			'CSS that can reach outside the file (style element: a url() to "https://x/p")',
		]);
	});

	test('a stylesheet that only draws passes, and a comment inside it is not part of it', () => {
		expect(
			svgProblems(
				doc(
					'<style type="text/css"><![CDATA[.st0{fill:url(#g)}]]>.st1{stroke:#000}' +
						'<!-- @import url(https://example.com/a.css); --></style><rect class="st0" fill="url( \'#g\' )"/>',
				),
			),
		).toEqual([]);
	});

	test('an element inside a style element stops the walk', () => {
		expect(svgProblems(doc('<style><rect/></style>'))).toEqual([
			stopped('an element inside a style element'),
		]);
	});
});

// ---------------------------------------------------------------------------
// XML that cannot be reasoned about
// ---------------------------------------------------------------------------

describe('XML the check refuses to reason about', () => {
	test.each([
		[
			'a stylesheet processing instruction',
			`<?xml-stylesheet type="text/xsl" href="data:x"?>${doc('')}`,
			'a processing instruction, which can attach a stylesheet or a transform to the file',
		],
		[
			'an XML declaration that is not first',
			`\n<?xml version="1.0"?>${doc('')}`,
			'a processing instruction, which can attach a stylesheet or a transform to the file',
		],
		['an unclosed XML declaration', '<?xml version="1.0"', 'an XML declaration that is not closed'],
		[
			'an internal subset',
			`<!DOCTYPE svg [<!ENTITY x "&#60;script&#62;">]>${doc('&x;')}`,
			'a DOCTYPE with an internal subset, which can declare entities',
		],
		['an unclosed DOCTYPE', '<!DOCTYPE svg PUBLIC "a', 'a DOCTYPE that is not closed'],
		['a DOCTYPE after the root', `${doc('')}<!DOCTYPE svg>`, 'a DOCTYPE after the root element'],
		[
			'a markup declaration in the body',
			doc('<!ENTITY x "y">'),
			'a markup declaration outside a DOCTYPE',
		],
		[
			'an entity XML does not define',
			doc('<title>a&nbsp;b</title>'),
			'the entity reference "&nbsp;", which XML does not define without a DTD',
		],
		[
			'an entity in an attribute',
			doc('<rect id="a&copy;"/>'),
			'the entity reference "&copy;", which XML does not define without a DTD',
		],
		[
			'a bare ampersand',
			doc('<title>a & b</title>'),
			'an ampersand that does not start a reference',
		],
		[
			'an unterminated reference',
			doc('<title>&amp</title>'),
			'an ampersand that does not start a reference',
		],
		[
			'a reference to a forbidden code point',
			doc('<title>&#0;</title>'),
			'a character reference to a code point XML does not allow, "&#0;"',
		],
		[
			'a reference past Unicode',
			doc('<title>&#x110000;</title>'),
			'a character reference to a code point XML does not allow, "&#x110000;"',
		],
		[
			'a declared encoding that is not UTF-8',
			`<?xml version="1.0" encoding="ISO-2022-JP"?>${doc('')}`,
			'the declared encoding "ISO-2022-JP": every check here reads the file as UTF-8, and a browser would read it as that',
		],
		['an unquoted value', doc('<rect width=10/>'), 'the unquoted value of width'],
		['an attribute with no value', doc('<rect hidden/>'), 'the attribute hidden with no value'],
		[
			'attributes that are not separated',
			doc('<rect x="1"y="2"/>'),
			'attributes on <rect> that are not separated',
		],
		['a "<" inside a value', doc('<rect id="a<b"/>'), 'a "<" inside the value of id'],
		[
			'an attribute written twice',
			doc('<rect x="1" x="2"/>'),
			'the attribute x written twice on <rect>',
		],
		[
			'xlink:href written twice under two prefixes',
			`<svg xmlns="${SVG}" xmlns:a="${XLINK}" xmlns:b="${XLINK}"><use a:href="#x" b:href="https://x/"/></svg>`,
			'the attribute b:href written twice on <use>',
		],
		['an undeclared element prefix', doc('<q:rect/>'), 'the undeclared prefix "q"'],
		['an undeclared attribute prefix', doc('<rect q:x="1"/>'), 'the undeclared prefix "q"'],
		['an element name with two colons', doc('<a:b:c/>'), 'the element name "a:b:c"'],
		['an attribute name that is not a name', doc('<rect 1x="1"/>'), 'the attribute name "1x"'],
		['a "<" that opens nothing', doc('< rect/>'), 'a "<" that does not open a tag'],
		[
			'a file that ends inside a tag',
			`<svg xmlns="${SVG}" width="10" height=`,
			'the file ends inside a tag',
		],
		[
			'a file that ends inside a value',
			`<svg xmlns="${SVG}" width="10`,
			'the file ends inside a tag',
		],
		[
			'a file that ends after an attribute name',
			`<svg xmlns="${SVG}" width`,
			'the file ends inside a tag',
		],
		['a file that ends after a value', `<svg xmlns="${SVG}"`, 'the file ends inside a tag'],
		['an equals sign with no name', doc('<rect ="1"/>'), 'the attribute name ""'],
		[
			'a slash that does not close the tag',
			doc('<rect/ >'),
			'attributes on <rect> that are not separated',
		],
		[
			'a second bad reference after the first',
			doc('<title>&nbsp;&copy;</title>'),
			'the entity reference "&nbsp;", which XML does not define without a DTD',
		],
		[
			'a file that ends inside an element',
			`<svg xmlns="${SVG}"><g>`,
			'the file ends inside an element',
		],
		[
			'a closing tag that does not match',
			doc('<g></rect>'),
			'a closing tag that does not match the element it closes',
		],
		[
			'a closing tag with nothing open',
			`${doc('')}</svg>`,
			'a closing tag that does not match the element it closes',
		],
		['a second root', `${doc('')}<svg xmlns="${SVG}"/>`, 'a second root element'],
		['text after the root', `${doc('')}trailing`, 'text outside the root element'],
		[
			'CDATA outside the root',
			`<![CDATA[x]]>${doc('')}`,
			'a CDATA section outside the root element',
		],
		['an unclosed CDATA section', doc('<![CDATA[x'), 'a CDATA section that is not closed'],
		['an unclosed comment', doc('<!-- x'), 'a comment that is not closed'],
		['no root element at all', '<!-- nothing -->', 'no root element'],
	])('%s', (_name, source, why) => {
		expect(svgProblems(source)).toEqual([stopped(why)]);
	});

	test('a declared encoding of UTF-8 in any case passes, and so does no declaration', () => {
		expect(svgProblems(`<?xml version="1.0" encoding="utf-8"?>\n${doc('')}`)).toEqual([]);
		expect(svgProblems(`<?xml version='1.0' encoding='UTF-8' standalone='no'?>${doc('')}`)).toEqual(
			[],
		);
		expect(svgProblems(`<?xml version="1.0"?>${doc('')}`)).toEqual([]);
	});

	test('the clauses found before the walk stopped are still reported', () => {
		expect(svgProblems(doc('<script/><title>&nbsp;</title>'))).toEqual([
			'elements the SVG allowlist does not name (script)',
			stopped('the entity reference "&nbsp;", which XML does not define without a DTD'),
		]);
	});

	test('bytes that are not UTF-8 are refused rather than read through replacement characters', () => {
		const bytes = new TextEncoder().encode(doc('<title>x</title>'));
		const broken = new Uint8Array([...bytes.subarray(0, 40), 0xc3, 0x28, ...bytes.subarray(40)]);
		expect(svgFileProblems(broken)).toEqual([stopped('bytes that are not valid UTF-8')]);
	});
});

// ---------------------------------------------------------------------------
// What passes
// ---------------------------------------------------------------------------

describe('what passes', () => {
	test('an ordinary editor export with a declaration, a public DOCTYPE and a stylesheet', () => {
		const exported =
			'<?xml version="1.0" encoding="utf-8"?>\n' +
			'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
			`<svg version="1.1" id="Layer_1" xmlns="${SVG}" xmlns:xlink="${XLINK}" x="0px" y="0px" ` +
			'viewBox="0 0 24 24" style="enable-background:new 0 0 24 24;" xml:space="preserve">\n' +
			'<style type="text/css">\n\t.st0{fill:#0B76D9;}\n</style>\n' +
			'<defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/></linearGradient>' +
			'<filter id="f"><feGaussianBlur in="SourceGraphic" stdDeviation="1"/></filter></defs>\n' +
			'<path class="st0" d="M0 0h24v24H0z" fill="url(#g)" filter="url(#f)"/>\n' +
			'<use xlink:href="#p" x="2"/><text x="1" y="12">A &amp; B &#x2192; C</text>\n' +
			'</svg>\n';
		expect(svgProblems(exported)).toEqual([]);
	});

	test('script inside a comment or a CDATA section of text is text, not markup', () => {
		expect(
			svgProblems(
				doc('<!-- <script>alert(1)</script> --><title><![CDATA[<script>]]>&lt;script&gt;</title>'),
			),
		).toEqual([]);
	});

	test('whitespace around an equals sign and single quotes are ordinary XML', () => {
		expect(svgProblems(doc("<rect x = '1'\n\twidth\t=\n'2'/>"))).toEqual([]);
	});

	test('a byte order mark is removed, as a browser removes it', () => {
		const withMark = new Uint8Array([
			0xef,
			0xbb,
			0xbf,
			...new TextEncoder().encode(doc('<rect/>')),
		]);
		expect(svgFileProblems(withMark)).toEqual([]);
	});
});

describe('the messages', () => {
	test('a clause lists six names and counts the rest', () => {
		const body = ['a', 'b', 'c', 'd', 'e', 'f', 'h', 'i'].map((name) => `<x${name}/>`).join('');
		expect(svgProblems(doc(body))).toEqual([
			'elements the SVG allowlist does not name (xa, xb, xc, xd, xe, xf and 2 more)',
		]);
	});

	test('a long value is cut before it is quoted', () => {
		const long = `https://example.com/${'a'.repeat(80)}`;
		expect(svgProblems(doc(`<use href="${long}"/>`))).toEqual([
			`references to something other than a fragment of this file (href "${long.slice(0, 60)}...")`,
		]);
	});
});
