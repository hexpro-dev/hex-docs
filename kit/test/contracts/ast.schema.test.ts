import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
	AST_NODE_TYPES,
	BLOCK_TYPES,
	CHILD_TYPES,
	INLINE_TYPES,
	type AstNodeType,
} from '../../../src/contracts/ast.js';
import {
	BLOCK_SCHEMAS,
	CHILD_SCHEMAS,
	INLINE_SCHEMAS,
	NODE_SCHEMAS,
	blockquoteSchema,
	blockSchema,
	calloutSchema,
	emphasisSchema,
	figureSchema,
	headingSchema,
	inlineSchema,
	linkSchema,
	listItemSchema,
	paragraphSchema,
	stepSchema,
	strikethroughSchema,
	strongSchema,
	tableCellSchema,
	tableSchema,
} from '../../src/contracts/ast.schema.js';

const ASSET = `assets/${'a'.repeat(64)}.png`;

const text = { type: 'text', value: 'Scanning a tag' };

/**
 * One valid instance of every node type.
 *
 * `satisfies Record<AstNodeType, unknown>` is the point: adding a node type to the
 * union and not to this table fails the typecheck, so the coverage below cannot
 * silently examine one case fewer than the AST has.
 */
const FIXTURES = {
	text,
	emphasis: { type: 'emphasis', children: [text] },
	strong: { type: 'strong', children: [text] },
	strikethrough: { type: 'strikethrough', children: [text] },
	inlineCode: { type: 'inlineCode', value: 'NTAG424' },
	link: { type: 'link', kind: 'internal', slug: 'guide/first-tag', children: [text] },
	image: { type: 'image', src: ASSET, alt: 'The scan screen', width: 750, height: 1334 },
	break: { type: 'break' },
	status: { type: 'status', value: 'partial' },

	paragraph: { type: 'paragraph', children: [text] },
	heading: { type: 'heading', depth: 2, id: 'writing-a-tag', idSource: 'slug', children: [text] },
	list: {
		type: 'list',
		style: 'bullet',
		tight: true,
		children: [{ type: 'listItem', children: [{ type: 'paragraph', children: [text] }] }],
	},
	code: {
		type: 'code',
		lang: 'swift',
		langLabel: 'Swift',
		highlighted: true,
		showLineNumbers: false,
		lines: [{ tokens: [{ text: 'let', scope: 'keyword' }, { text: ' tag' }] }],
	},
	blockquote: { type: 'blockquote', children: [{ type: 'paragraph', children: [text] }] },
	callout: {
		type: 'callout',
		kind: 'warning',
		children: [{ type: 'paragraph', children: [text] }],
	},
	table: {
		type: 'table',
		align: ['left', null],
		header: [
			{ type: 'tableCell', children: [text] },
			{ type: 'tableCell', children: [text] },
		],
		rows: [
			[
				{ type: 'tableCell', children: [text] },
				{ type: 'tableCell', children: [{ type: 'status', value: 'yes' }] },
			],
		],
	},
	figure: {
		type: 'figure',
		image: { type: 'image', src: ASSET, alt: 'A tag', width: 10, height: 10 },
		caption: [text],
	},
	thematicBreak: { type: 'thematicBreak' },
	steps: {
		type: 'steps',
		children: [
			{
				type: 'step',
				id: 'open-the-app',
				title: [text],
				children: [{ type: 'paragraph', children: [text] }],
			},
		],
	},

	listItem: { type: 'listItem', children: [{ type: 'paragraph', children: [text] }] },
	tableCell: { type: 'tableCell', children: [text] },
	step: {
		type: 'step',
		id: 'open-the-app',
		title: [text],
		children: [{ type: 'paragraph', children: [text] }],
	},
} as const satisfies Record<AstNodeType, unknown>;

describe('schema coverage moves with the union, not with whoever remembered', () => {
	test('every node type has a schema', () => {
		expect(Object.keys(NODE_SCHEMAS).sort()).toEqual([...AST_NODE_TYPES].sort());
		expect(AST_NODE_TYPES.length).toBeGreaterThan(0);
	});

	test('every node type has a fixture', () => {
		expect(Object.keys(FIXTURES).length).toBe(AST_NODE_TYPES.length);
	});

	test('the discriminated unions carry exactly one option per node type', () => {
		expect((blockSchema as unknown as { options: unknown[] }).options.length).toBe(
			BLOCK_TYPES.length,
		);
		expect((inlineSchema as unknown as { options: unknown[] }).options.length).toBe(
			INLINE_TYPES.length,
		);
		expect(Object.keys(CHILD_SCHEMAS).length).toBe(CHILD_TYPES.length);
		expect(Object.keys(BLOCK_SCHEMAS).length).toBe(BLOCK_TYPES.length);
		expect(Object.keys(INLINE_SCHEMAS).length).toBe(INLINE_TYPES.length);
	});
});

describe.each(AST_NODE_TYPES)('%s', (type) => {
	const schema = NODE_SCHEMAS[type];
	const fixture = FIXTURES[type];

	test('parses its own fixture', () => {
		const result = schema.safeParse(fixture);
		expect(result.success, JSON.stringify(result.success ? '' : result.error.issues)).toBe(true);
	});

	test('refuses an unrecognised key', () => {
		expect(schema.safeParse({ ...(fixture as object), unexpected: true }).success).toBe(false);
	});

	test('refuses a wrong discriminant', () => {
		expect(schema.safeParse({ ...(fixture as object), type: 'not-a-node' }).success).toBe(false);
	});
});

describe('the unions accept exactly what belongs in them', () => {
	test.each(BLOCK_TYPES)('%s parses as a block', (type) => {
		expect(blockSchema.safeParse(FIXTURES[type]).success).toBe(true);
	});

	test.each(INLINE_TYPES)('%s parses as an inline', (type) => {
		expect(inlineSchema.safeParse(FIXTURES[type]).success).toBe(true);
	});

	test.each(INLINE_TYPES)('%s is refused as a block', (type) => {
		expect(blockSchema.safeParse(FIXTURES[type]).success).toBe(false);
	});

	test.each(CHILD_TYPES)('%s is refused as a block and as an inline', (type) => {
		expect(blockSchema.safeParse(FIXTURES[type]).success).toBe(false);
		expect(inlineSchema.safeParse(FIXTURES[type]).success).toBe(false);
	});
});

describe('the sanitised edges', () => {
	test('an http external link is refused, matching hex-web’s own safeHref', () => {
		expect(
			inlineSchema.safeParse({ type: 'link', kind: 'external', href: 'http://x.dev', children: [] })
				.success,
		).toBe(false);
		expect(
			inlineSchema.safeParse({
				type: 'link',
				kind: 'external',
				href: 'https://x.dev',
				children: [],
			}).success,
		).toBe(true);
	});

	test.each(['javascript:alert(1)', 'data:text/html,x', '//evil.example', 'vbscript:x'])(
		'%s is refused as an external href',
		(href) => {
			expect(
				inlineSchema.safeParse({ type: 'link', kind: 'external', href, children: [] }).success,
			).toBe(false);
		},
	);

	test('an image src must be a bundle-relative content-addressed asset', () => {
		for (const src of ['foo.png', '/abs.png', 'https://x.dev/a.png', 'assets/notahash.png']) {
			expect(
				inlineSchema.safeParse({ type: 'image', src, alt: 'a', width: 1, height: 1 }).success,
			).toBe(false);
		}
		expect(
			inlineSchema.safeParse({ type: 'image', src: ASSET, alt: 'a', width: 1, height: 1 }).success,
		).toBe(true);
	});

	test('a heading may not be depth 1: the title is front matter', () => {
		expect(blockSchema.safeParse({ ...FIXTURES.heading, depth: 1 }).success).toBe(false);
		expect(blockSchema.safeParse({ ...FIXTURES.heading, depth: 6 }).success).toBe(true);
	});

	test('a deferred node type is refused rather than passed through', () => {
		for (const type of ['mathBlock', 'diagram', 'details', 'footnoteReference', 'html']) {
			expect(blockSchema.safeParse({ type, children: [] }).success).toBe(false);
		}
	});

	test('nesting works to arbitrary depth through the recursion points', () => {
		let node: unknown = { type: 'paragraph', children: [text] };
		for (let i = 0; i < 12; i += 1) node = { type: 'blockquote', children: [node] };
		expect(blockSchema.safeParse(node).success).toBe(true);
	});
});

/**
 * The recursion seam.
 *
 * `inlineArray()` and `blockArray()` are typed by a `z.ZodType<T>` annotation, so the
 * type system cannot tell `z.array(inlineSchema)` from `z.any()`. Replacing either
 * with `z.any()` typechecks, passes every other test in this file, and leaves the
 * whole tree below the top node unvalidated: a paragraph whose children are a bare
 * string parses, and so does one carrying a node type the AST does not have.
 *
 * These are the only guard. Two independent kinds, because each catches a mutation the
 * other misses: identity pins what a container is wired to, and the rejections pin
 * what it actually refuses.
 */
describe('the recursion seam', () => {
	/** Unwraps `.optional()` and reads an array schema's element schema. */
	const elementOf = (field: unknown): unknown => {
		const inner =
			field instanceof z.ZodOptional ? (field as z.ZodOptional<z.ZodType>).unwrap() : field;
		return (inner as z.ZodArray<z.ZodType>).element;
	};

	const INLINE_CONTAINERS: [string, unknown][] = [
		['paragraph.children', paragraphSchema.shape.children],
		['heading.children', headingSchema.shape.children],
		['emphasis.children', emphasisSchema.shape.children],
		['strong.children', strongSchema.shape.children],
		['strikethrough.children', strikethroughSchema.shape.children],
		['tableCell.children', tableCellSchema.shape.children],
		['callout.title', calloutSchema.shape.title],
		['table.caption', tableSchema.shape.caption],
		['figure.caption', figureSchema.shape.caption],
		['step.title', stepSchema.shape.title],
	];

	const BLOCK_CONTAINERS: [string, unknown][] = [
		['listItem.children', listItemSchema.shape.children],
		['blockquote.children', blockquoteSchema.shape.children],
		['callout.children', calloutSchema.shape.children],
		['step.children', stepSchema.shape.children],
	];

	test('every container is wired to a shared union schema, not to a placeholder', () => {
		expect(INLINE_CONTAINERS.length + BLOCK_CONTAINERS.length).toBeGreaterThan(12);
	});

	test.each(INLINE_CONTAINERS)('%s holds the inline union by reference', (_name, field) => {
		expect(elementOf(field)).toBe(inlineSchema);
	});

	test.each(BLOCK_CONTAINERS)('%s holds the block union by reference', (_name, field) => {
		expect(elementOf(field)).toBe(blockSchema);
	});

	test('every link variant carries the inline union too', () => {
		const options = (linkSchema as unknown as { options: z.ZodObject<z.ZodRawShape>[] }).options;
		expect(options.length).toBe(4);
		for (const option of options) expect(elementOf(option.shape['children'])).toBe(inlineSchema);
	});

	test.each([
		[
			'a node type the AST does not have',
			{ type: 'paragraph', children: [{ type: 'html', value: '<script>alert(1)</script>' }] },
		],
		[
			'a bare string where inline nodes belong',
			{ type: 'paragraph', children: 'not even an array' },
		],
		['a string inside a block container', { type: 'blockquote', children: ['x'] }],
		[
			'a block node in an inline position',
			{ type: 'paragraph', children: [{ type: 'thematicBreak' }] },
		],
		['an inline node in a block position', { type: 'blockquote', children: [text] }],
		[
			'an unsafe href one level down',
			{
				type: 'heading',
				depth: 2,
				id: 'x',
				idSource: 'slug',
				children: [{ type: 'link', kind: 'external', href: 'javascript:alert(1)', children: [] }],
			},
		],
		[
			'a bad child three levels down',
			{
				type: 'blockquote',
				children: [
					{ type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'html' }] }] },
				],
			},
		],
		[
			'a child list item that is not a list item',
			{
				type: 'list',
				style: 'bullet',
				tight: true,
				children: [{ type: 'paragraph', children: [text] }],
			},
		],
		[
			'a table row cell that is not a cell',
			{
				type: 'table',
				align: [null],
				header: [{ type: 'tableCell', children: [] }],
				rows: [[{ type: 'paragraph', children: [] }]],
			},
		],
		[
			'a step that is not a step',
			{ type: 'steps', children: [{ type: 'paragraph', children: [text] }] },
		],
	])('a container refuses %s', (_name, node) => {
		expect(blockSchema.safeParse(node).success).toBe(false);
	});
});

describe('mailto addresses', () => {
	const mailto = (address: string) =>
		inlineSchema.safeParse({ type: 'link', kind: 'mailto', address, children: [text] }).success;

	test('a bare address passes', () => {
		for (const address of ['support@hex.pro', 'security@hex.pro', 'a.b+c@sub.example.co.uk']) {
			expect(mailto(address)).toBe(true);
		}
	});

	test('a query string is refused: a mailto header is one the reader cannot see', () => {
		// The percent-encoded second address means there is only one literal @, which
		// is all the previous pattern required.
		expect(mailto('support@hex.pro?bcc=attacker%40evil.example')).toBe(false);
		expect(mailto('support@hex.pro?subject=x&body=y')).toBe(false);
	});

	test.each([
		'x"><svg/onload=alert(1)>@a.b',
		'a@b',
		'a@b.',
		'@b.c',
		'a@.c',
		'a b@c.d',
		'a@b..c',
		// A label may not start or end with a hyphen. Neither is a domain.
		'a@-b.com',
		'a@b-.com',
	])('%p is refused', (address) => {
		expect(mailto(address)).toBe(false);
	});
});

describe('anchors and internal slugs', () => {
	const internal = (slug: string, anchor?: string) =>
		inlineSchema.safeParse({
			type: 'link',
			kind: 'internal',
			slug,
			...(anchor === undefined ? {} : { anchor }),
			children: [text],
		}).success;

	test('an internal link is validated like every other slug in the bundle', () => {
		expect(internal('guide/first-tag')).toBe(true);
		for (const slug of ['../../../etc/passwd', '/absolute', 'Guide/First', 'a b', '']) {
			expect(internal(slug)).toBe(false);
		}
	});

	test('an anchor is what goes after the hash, not an arbitrary string', () => {
		expect(internal('index', 'writing-a-tag')).toBe(true);
		expect(internal('index', '_top')).toBe(true);
		for (const anchor of ['Writing A Tag', 'a b', 'x#y', '../x', '']) {
			expect(internal('index', anchor)).toBe(false);
		}
	});

	test('a heading id and its aliases use the same grammar', () => {
		const heading = (id: string, aliases?: string[]) =>
			blockSchema.safeParse({
				type: 'heading',
				depth: 2,
				id,
				idSource: 'slug',
				...(aliases === undefined ? {} : { aliases }),
				children: [text],
			}).success;
		expect(heading('writing-a-tag')).toBe(true);
		expect(heading('writing-a-tag', ['section-4'])).toBe(true);
		expect(heading('Writing A Tag')).toBe(false);
		expect(heading('ok', ['Not Ok'])).toBe(false);
	});
});
