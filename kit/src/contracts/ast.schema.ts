/**
 * The Zod mirror of the HexDoc AST.
 *
 * The TypeScript in `src/contracts/ast.ts` is the canonical declaration, because the
 * runtime is the only party that has to read a bundle it did not write and therefore
 * whatever it can parse *is* the format. This file is what validates that a bundle
 * about to be published actually conforms, and `drift.ts` asserts the two agree
 * exactly, field by field, in both directions.
 *
 * Three separate things keep this honest, and only two of them are the type system.
 *
 * **Field drift** is caught by `drift.ts`: every node's own fields are compared
 * invariantly against its hand-written twin, which is where drift actually happens.
 *
 * **Completeness** is caught by the registries below. A union missing a member is
 * still assignable to `z.ZodType<Inline>`, so the annotation alone would let a node
 * type quietly stop being validated. `satisfies Record<BlockType, …>` means a node
 * type added in `src/` and not here fails the typecheck, and the unions are built from
 * the registries so the two cannot disagree.
 *
 * **The recursion seam is caught by tests, and by nothing else.** `inlineArray()` and
 * `blockArray()` are typed by annotation, so `z.any()` in either of them typechecks,
 * passes all 327 tests as they stood before this was found, and leaves the entire tree
 * below the top node unvalidated: a paragraph whose children are a string, or an
 * `html` node carrying a script, both parse. The seam-identity and rejected-child
 * tests in `kit/test/contracts/ast.schema.test.ts` are the guard. Do not delete them
 * believing the annotations have this.
 */

import { z } from 'zod';

import type { AssertExactUnion, Expect } from '../../../src/contracts/exact.js';
import { slugSchema } from './primitives.js';
import {
	CALLOUT_KINDS,
	CODE_SCOPES,
	HEADING_ID_SOURCES,
	STATUS_VALUES,
	type Block,
	type BlockType,
	type ChildNode,
	type Inline,
	type InlineType,
} from '../../../src/contracts/ast.js';

// ---------------------------------------------------------------------------
// Forward declarations
// ---------------------------------------------------------------------------

/**
 * Zod does not export a name for "a thing discriminatedUnion accepts", so it is
 * recovered from the function's own signature. The cast is confined to this alias:
 * the completeness guarantee comes from `satisfies Record<BlockType, ...>` on the
 * registries below, not from the shape of this array.
 */
type UnionOptions = Parameters<typeof z.discriminatedUnion>[1];

const inlineArray = (): z.ZodType<Inline[]> => z.array(inlineSchema);
const blockArray = (): z.ZodType<Block[]> => z.array(blockSchema);

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

export const textSchema = z.strictObject({
	type: z.literal('text'),
	value: z.string(),
});

export const emphasisSchema = z.strictObject({
	type: z.literal('emphasis'),
	get children() {
		return inlineArray();
	},
});

export const strongSchema = z.strictObject({
	type: z.literal('strong'),
	get children() {
		return inlineArray();
	},
});

export const strikethroughSchema = z.strictObject({
	type: z.literal('strikethrough'),
	get children() {
		return inlineArray();
	},
});

export const inlineCodeSchema = z.strictObject({
	type: z.literal('inlineCode'),
	value: z.string(),
});

/**
 * A heading or step anchor: what goes after the `#`.
 *
 * Constrained rather than merely non-empty, because it is written into an `id`
 * attribute and into a URL fragment. The `_top` sentinel the search index uses for a
 * page's opening section is allowed, which is why the leading underscore is.
 *
 * **Letters in any script, not ASCII.** This was `[a-z0-9]` until the compiler ran over
 * the fixture corpus and every heading on every Chinese, Japanese and Arabic page was
 * refused. An id derived from heading text is locale-dependent by construction, which
 * `ast.ts` says outright and which `aliases` exists to cope with, so an ASCII-only
 * anchor is not a stricter version of the same rule: it is a rule that cannot be
 * satisfied in four of the seven languages.
 *
 * The alternative considered and rejected was a positional fallback, `section-3` for any
 * heading whose text is not Latin. It produces ASCII ids and it makes every anchor below
 * an inserted heading change, which breaks the stability the ids exist for: a deep link
 * pasted into a support reply has to keep working after somebody adds a section above it.
 *
 * Upper case is still refused, in every script that has case, because the compiler lower
 * cases what it derives and two spellings of one anchor is two ids for one section.
 */
const anchorSchema = z
	.string()
	.regex(
		/^_?[\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+)*$/u,
		'An anchor is lower case, hyphenated, and has no spaces.',
	);

/** Bundle-relative asset reference: `assets/<sha256>.<ext>`. */
const assetSrcSchema = z
	.string()
	.regex(/^assets\/[0-9a-f]{64}\.(png|jpg|webp|avif|svg)$/, 'Expected assets/<sha256>.<ext>.');

export const linkSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		type: z.literal('link'),
		kind: z.literal('internal'),
		// The one link kind that used to accept any non-empty string, in a field that
		// becomes a URL path. Every other slug in the bundle goes through slugSchema.
		slug: slugSchema,
		anchor: anchorSchema.optional(),
		title: z.string().optional(),
		get children() {
			return inlineArray();
		},
	}),
	z.strictObject({
		type: z.literal('link'),
		kind: z.literal('anchor'),
		anchor: anchorSchema,
		title: z.string().optional(),
		get children() {
			return inlineArray();
		},
	}),
	z.strictObject({
		type: z.literal('link'),
		kind: z.literal('external'),
		// https only, matching hex-web's own safeHref. The corpus has no plaintext link
		// and widening here would put the two gates out of step.
		href: z.string().regex(/^https:\/\/\S+$/, 'External links must be absolute https:.'),
		title: z.string().optional(),
		get children() {
			return inlineArray();
		},
	}),
	z.strictObject({
		type: z.literal('link'),
		kind: z.literal('mailto'),
		// An allowlist grammar, not a denylist. The previous pattern only required "no
		// whitespace and exactly one literal @", which admits a whole mailto query
		// string: `support@hexpro.dev?bcc=attacker%40evil.com` has one literal @ because
		// the second address is percent-encoded, and the reader sees a plain support
		// address while the mail client silently adds a header they cannot see.
		address: z.string().regex(
			// Each label is bounded at both ends, so a hyphen can neither lead nor
			// trail one. `a@-b.com` is not a domain and a link to it goes nowhere.
			/^[A-Za-z0-9._+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/,
			'A bare address. Query parameters are refused: a mailto query is a mail header the reader cannot see.',
		),
		title: z.string().optional(),
		get children() {
			return inlineArray();
		},
	}),
]);

export const imageSchema = z.strictObject({
	type: z.literal('image'),
	src: assetSrcSchema,
	alt: z.string(),
	width: z.int().min(1),
	height: z.int().min(1),
	title: z.string().optional(),
});

export const breakSchema = z.strictObject({ type: z.literal('break') });

export const statusSchema = z.strictObject({
	type: z.literal('status'),
	value: z.enum(STATUS_VALUES),
});

/**
 * Keyed by discriminant so a node type added to `Inline` without a schema is a
 * missing key here, which `satisfies` reports by name.
 */
export const INLINE_SCHEMAS = {
	text: textSchema,
	emphasis: emphasisSchema,
	strong: strongSchema,
	strikethrough: strikethroughSchema,
	inlineCode: inlineCodeSchema,
	link: linkSchema,
	image: imageSchema,
	break: breakSchema,
	status: statusSchema,
} as const satisfies Record<InlineType, z.ZodType>;

/**
 * Built from the registry rather than from a second hand-written list, so the union
 * and the registry cannot disagree about which node types are validated.
 *
 * The cast past Zod's erased option type is safe because of the assertion beneath it:
 * that is an invariant equality between the union of every registered schema's output
 * and `Inline` itself, so a missing member, an extra member or a member whose fields
 * drifted all fail the typecheck by name. The `z.ZodType<Inline>` annotation alone
 * would not, because a union missing a member is still assignable to it.
 */
export const inlineSchema = z.discriminatedUnion(
	'type',
	Object.values(INLINE_SCHEMAS) as unknown as UnionOptions,
) as unknown as z.ZodType<Inline>;

type InlineFromRegistry = z.infer<(typeof INLINE_SCHEMAS)[keyof typeof INLINE_SCHEMAS]>;
type _inlineRegistryExact = Expect<AssertExactUnion<InlineFromRegistry, Inline>>;

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

export const codeTokenSchema = z.strictObject({
	text: z.string(),
	scope: z.enum(CODE_SCOPES).optional(),
});

export const codeLineSchema = z.strictObject({
	tokens: z.array(codeTokenSchema),
});

// ---------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------

export const paragraphSchema = z.strictObject({
	type: z.literal('paragraph'),
	get children() {
		return inlineArray();
	},
});

export const headingSchema = z.strictObject({
	type: z.literal('heading'),
	depth: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
	id: anchorSchema,
	idSource: z.enum(HEADING_ID_SOURCES),
	aliases: z.array(anchorSchema).optional(),
	get children() {
		return inlineArray();
	},
});

export const listItemSchema = z.strictObject({
	type: z.literal('listItem'),
	checked: z.boolean().optional(),
	get children() {
		return blockArray();
	},
});

export const listSchema = z.strictObject({
	type: z.literal('list'),
	style: z.union([z.literal('bullet'), z.literal('ordered')]),
	start: z.int().optional(),
	tight: z.boolean(),
	get children() {
		return z.array(listItemSchema);
	},
});

export const codeSchema = z.strictObject({
	type: z.literal('code'),
	lang: z.string().min(1).optional(),
	langLabel: z.string().min(1).optional(),
	highlighted: z.boolean(),
	filename: z.string().min(1).optional(),
	lines: z.array(codeLineSchema),
	showLineNumbers: z.boolean(),
	startLine: z.int().min(1).optional(),
	highlight: z.array(z.int().min(1)).optional(),
	wrap: z.boolean().optional(),
});

export const blockquoteSchema = z.strictObject({
	type: z.literal('blockquote'),
	get children() {
		return blockArray();
	},
});

export const calloutSchema = z.strictObject({
	type: z.literal('callout'),
	kind: z.enum(CALLOUT_KINDS),
	get title() {
		return inlineArray().optional();
	},
	get children() {
		return blockArray();
	},
});

export const tableCellSchema = z.strictObject({
	type: z.literal('tableCell'),
	get children() {
		return inlineArray();
	},
});

export const tableSchema = z.strictObject({
	type: z.literal('table'),
	get caption() {
		return inlineArray().optional();
	},
	align: z.array(z.union([z.literal('left'), z.literal('center'), z.literal('right'), z.null()])),
	header: z.array(tableCellSchema),
	rows: z.array(z.array(tableCellSchema)),
});

export const figureSchema = z.strictObject({
	type: z.literal('figure'),
	image: imageSchema,
	get caption() {
		return inlineArray().optional();
	},
});

export const thematicBreakSchema = z.strictObject({ type: z.literal('thematicBreak') });

export const stepSchema = z.strictObject({
	type: z.literal('step'),
	id: anchorSchema,
	get title() {
		return inlineArray();
	},
	get children() {
		return blockArray();
	},
});

export const stepsSchema = z.strictObject({
	type: z.literal('steps'),
	get children() {
		return z.array(stepSchema);
	},
});

export const BLOCK_SCHEMAS = {
	paragraph: paragraphSchema,
	heading: headingSchema,
	list: listSchema,
	code: codeSchema,
	blockquote: blockquoteSchema,
	callout: calloutSchema,
	table: tableSchema,
	figure: figureSchema,
	thematicBreak: thematicBreakSchema,
	steps: stepsSchema,
} as const satisfies Record<BlockType, z.ZodType>;

export const blockSchema = z.discriminatedUnion(
	'type',
	Object.values(BLOCK_SCHEMAS) as unknown as UnionOptions,
) as unknown as z.ZodType<Block>;

type BlockFromRegistry = z.infer<(typeof BLOCK_SCHEMAS)[keyof typeof BLOCK_SCHEMAS]>;
type _blockRegistryExact = Expect<AssertExactUnion<BlockFromRegistry, Block>>;

export const CHILD_SCHEMAS = {
	listItem: listItemSchema,
	tableCell: tableCellSchema,
	step: stepSchema,
} as const satisfies Record<ChildNode['type'], z.ZodType>;

type ChildFromRegistry = z.infer<(typeof CHILD_SCHEMAS)[keyof typeof CHILD_SCHEMAS]>;
type _childRegistryExact = Expect<AssertExactUnion<ChildFromRegistry, ChildNode>>;

/** Every node schema, for the coverage test that iterates `AST_NODE_TYPES`. */
export const NODE_SCHEMAS = {
	...BLOCK_SCHEMAS,
	...INLINE_SCHEMAS,
	...CHILD_SCHEMAS,
} as const;
