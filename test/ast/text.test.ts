/**
 * Flattening the tree back to text.
 *
 * Four callers need this and none of them can share a walk with the renderer: a table of
 * contents entry, the search index's per-section body, the reading estimate's word count
 * and `llms.txt`. Each wants something different from the same tree, which is why the
 * options exist and why every one of them is asserted here rather than assumed.
 *
 * The sweep at the foot is the one that stops this rotting: a node type added to the AST
 * without a case in either walk falls into `unhandledNode` and contributes nothing, and
 * a table of contents entry that quietly lost a word is not something anybody notices.
 */

import { describe, expect, test } from 'vitest';

import { inlineText, blockText } from '../../src/ast/text.js';
import {
	AST_NODE_TYPES,
	BLOCK_TYPES,
	INLINE_TYPES,
	STATUS_VALUES,
	resetUnhandledNodeWarnings,
	type Block,
	type Inline,
} from '../../src/contracts/ast.js';

const text = (value: string): Inline => ({ type: 'text', value });

describe('inline', () => {
	test('a run of text is itself', () => {
		expect(inlineText([text('Hold the tag still.')])).toBe('Hold the tag still.');
	});

	test('emphasis, strong and strikethrough contribute their children and no markers', () => {
		expect(
			inlineText([
				text('Writing is '),
				{ type: 'emphasis', children: [text('destructive')] },
				text('. Tap '),
				{ type: 'strong', children: [text('Write')] },
				text('. '),
				{ type: 'strikethrough', children: [text('read only')] },
			]),
		).toBe('Writing is destructive. Tap Write. read only');
	});

	test('inline code is content, because an error string is what a reader searches for', () => {
		expect(inlineText([{ type: 'inlineCode', value: 'Tag is permanently locked' }])).toBe(
			'Tag is permanently locked',
		);
	});

	test('a link contributes its text and never its destination', () => {
		const linked = inlineText([
			{
				type: 'link',
				kind: 'internal',
				slug: 'reference/chip-support',
				children: [text('Chip support matrix')],
			},
		]);
		expect(linked).toBe('Chip support matrix');
		expect(linked).not.toContain('reference');
	});

	test('a hard break is a space, so two lines do not run together', () => {
		expect(inlineText([text('iPhone 7'), { type: 'break' }, text('iOS 16')])).toBe(
			'iPhone 7 iOS 16',
		);
	});

	test('an image contributes nothing unless a caller asks for its alt text', () => {
		const image: Inline = {
			type: 'image',
			src: `assets/${'a'.repeat(64)}.png`,
			alt: 'The Scan sheet',
			width: 10,
			height: 10,
		};
		// The default is the table of contents' default, because it has the strictest
		// requirement: an entry that rendered an image is not an entry.
		expect(inlineText([text('See '), image])).toBe('See ');
		expect(inlineText([text('See '), image], { image: (node) => node.alt })).toBe(
			'See The Scan sheet',
		);
	});

	test('a status glyph contributes nothing unless a caller supplies a label', () => {
		const status: Inline = { type: 'status', value: 'yes' };
		expect(inlineText([status])).toBe('');
		// The search index is the caller that supplies one, in the locale's own language.
		// A search for "supported" that matched no row is the failure the status node exists
		// to fix, and this module has no locale, so the label comes from outside.
		expect(inlineText([status], { status: (value) => value.toUpperCase() })).toBe('YES');
	});

	test('an unknown node is skipped rather than throwing', () => {
		// This half is the one that reads a bundle it did not write, so an unknown node
		// means a newer toolchain. Losing one word out of a heading is a better outcome
		// than a 500 on a page that is otherwise fine.
		resetUnhandledNodeWarnings();
		const unknown = { type: 'footnote', children: [] } as unknown as Inline;
		expect(inlineText([text('Before '), unknown, text('after')])).toBe('Before after');
	});
});

describe('blocks', () => {
	const page: Block[] = [
		{ type: 'heading', depth: 2, id: 'errors', idSource: 'slug', children: [text('Errors')] },
		{ type: 'paragraph', children: [text('The reader retries once.')] },
		{
			type: 'list',
			style: 'bullet',
			tight: true,
			children: [
				{ type: 'listItem', children: [{ type: 'paragraph', children: [text('One')] }] },
				{ type: 'listItem', children: [{ type: 'paragraph', children: [text('Two')] }] },
			],
		},
		{ type: 'thematicBreak' },
	];

	test('every block contributes on its own line', () => {
		expect(blockText(page)).toBe('Errors\nThe reader retries once.\nOne\nTwo');
	});

	test('a code fence is counted only when a caller asks for it', () => {
		const code: Block[] = [
			{
				type: 'code',
				lang: 'swift',
				highlighted: true,
				showLineNumbers: false,
				lines: [{ tokens: [{ text: 'let session = TagSession()' }] }],
			},
		];
		// The reading estimate says no: a two hundred line listing is not four hundred words
		// of reading. The search index says yes: a developer looks for a symbol that appears
		// in a fence and nowhere else.
		expect(blockText(code)).toBe('');
		expect(blockText(code, { code: true })).toBe('let session = TagSession()');
	});

	test('a table contributes its caption, its header and every row', () => {
		const table: Block[] = [
			{
				type: 'table',
				caption: [text('Core NFC support')],
				align: [null, null],
				header: [
					{ type: 'tableCell', children: [text('Chip')] },
					{ type: 'tableCell', children: [text('Read')] },
				],
				rows: [
					[
						{ type: 'tableCell', children: [text('NTAG213')] },
						{ type: 'tableCell', children: [{ type: 'status', value: 'yes' }] },
					],
				],
			},
		];
		expect(blockText(table)).toBe('Core NFC support\nChip Read\nNTAG213 ');
		expect(blockText(table, { status: () => 'Supported' })).toContain('NTAG213 Supported');
	});

	test('a callout, a blockquote and a figure each contribute their own parts', () => {
		const blocks: Block[] = [
			{
				type: 'callout',
				kind: 'note',
				title: [text('Background scanning')],
				children: [{ type: 'paragraph', children: [text('Only a URL record.')] }],
			},
			{
				type: 'blockquote',
				children: [{ type: 'paragraph', children: [text('A tag that fails to write.')] }],
			},
			{
				type: 'figure',
				image: {
					type: 'image',
					src: `assets/${'b'.repeat(64)}.png`,
					alt: 'Sheet',
					width: 1,
					height: 1,
				},
				caption: [text('The Scan sheet')],
			},
		];
		expect(blockText(blocks)).toBe(
			'Background scanning\nOnly a URL record.\nA tag that fails to write.\nThe Scan sheet',
		);
	});

	test('a steps container contributes each step title and its body', () => {
		const blocks: Block[] = [
			{
				type: 'steps',
				children: [
					{
						type: 'step',
						id: 'open-the-scan-sheet',
						title: [text('Open the Scan sheet')],
						children: [{ type: 'paragraph', children: [text('Tap the large circle.')] }],
					},
				],
			},
		];
		expect(blockText(blocks)).toBe('Open the Scan sheet\nTap the large circle.');
	});

	test('an unknown block is skipped rather than throwing', () => {
		resetUnhandledNodeWarnings();
		const unknown = { type: 'mermaid', value: 'graph TD' } as unknown as Block;
		expect(blockText([...page, unknown])).toBe('Errors\nThe reader retries once.\nOne\nTwo');
	});
});

describe('coverage of the unions', () => {
	/**
	 * A minimal node of every type, and what its text should be.
	 *
	 * `null` means the type legitimately contributes nothing, with the reason beside it.
	 * Everything else must come back non-empty, which is what makes this a test of the two
	 * walks rather than of the arrays they were built from.
	 */
	const SAMPLES: Readonly<Record<string, { node: unknown; text: string | null; why?: string }>> = {
		paragraph: { node: { type: 'paragraph', children: [text('Body.')] }, text: 'Body.' },
		heading: {
			node: { type: 'heading', depth: 2, id: 'a', idSource: 'slug', children: [text('Errors')] },
			text: 'Errors',
		},
		list: {
			node: {
				type: 'list',
				style: 'bullet',
				tight: true,
				children: [
					{ type: 'listItem', children: [{ type: 'paragraph', children: [text('One')] }] },
				],
			},
			text: 'One',
		},
		listItem: {
			node: {
				type: 'list',
				style: 'bullet',
				tight: true,
				children: [
					{ type: 'listItem', children: [{ type: 'paragraph', children: [text('One')] }] },
				],
			},
			text: 'One',
			why: 'Reached only through its list, which is the only way a walk ever meets one.',
		},
		blockquote: {
			node: { type: 'blockquote', children: [{ type: 'paragraph', children: [text('Quoted.')] }] },
			text: 'Quoted.',
		},
		callout: {
			node: {
				type: 'callout',
				kind: 'note',
				children: [{ type: 'paragraph', children: [text('Noted.')] }],
			},
			text: 'Noted.',
		},
		steps: {
			node: {
				type: 'steps',
				children: [{ type: 'step', id: 'one', title: [text('First')], children: [] }],
			},
			text: 'First',
		},
		step: {
			node: {
				type: 'steps',
				children: [{ type: 'step', id: 'one', title: [text('First')], children: [] }],
			},
			text: 'First',
			why: 'Reached only through its steps container.',
		},
		table: {
			node: {
				type: 'table',
				align: [null],
				header: [{ type: 'tableCell', children: [text('Chip')] }],
				rows: [[{ type: 'tableCell', children: [text('NTAG213')] }]],
			},
			text: 'Chip\nNTAG213',
		},
		tableCell: {
			node: {
				type: 'table',
				align: [null],
				header: [{ type: 'tableCell', children: [text('Chip')] }],
				rows: [],
			},
			text: 'Chip',
			why: 'Reached only through its table.',
		},
		figure: {
			node: {
				type: 'figure',
				image: {
					type: 'image',
					src: `assets/${'a'.repeat(64)}.png`,
					alt: 'A',
					width: 1,
					height: 1,
				},
				caption: [text('The Scan sheet')],
			},
			// The alt text as well as the caption, because this walk is given an `image`
			// reader. The table of contents supplies none and gets the caption alone.
			text: 'A\nThe Scan sheet',
		},
		code: {
			node: {
				type: 'code',
				lang: 'swift',
				highlighted: true,
				showLineNumbers: false,
				lines: [{ tokens: [{ text: 'let session = TagSession()' }] }],
			},
			text: 'let session = TagSession()',
			why: 'Only with `code: true`, which the reading estimate does not pass and search does.',
		},
		thematicBreak: {
			node: { type: 'thematicBreak' },
			text: null,
			why: 'A rule has no text. It is the one block that contributes nothing by nature.',
		},
		text: { node: text('Plain.'), text: 'Plain.' },
		emphasis: { node: { type: 'emphasis', children: [text('em')] }, text: 'em' },
		strong: { node: { type: 'strong', children: [text('strong')] }, text: 'strong' },
		strikethrough: { node: { type: 'strikethrough', children: [text('gone')] }, text: 'gone' },
		inlineCode: { node: { type: 'inlineCode', value: 'Tag locked' }, text: 'Tag locked' },
		link: {
			node: { type: 'link', kind: 'internal', slug: 'a/b', children: [text('Matrix')] },
			text: 'Matrix',
		},
		image: {
			node: {
				type: 'image',
				src: `assets/${'a'.repeat(64)}.png`,
				alt: 'The sheet',
				width: 1,
				height: 1,
			},
			text: 'The sheet',
			why: 'Only when a caller supplies an `image` reader, which the table of contents does not.',
		},
		status: {
			node: { type: 'status', value: 'yes' },
			text: 'yes',
			why: 'Only when a caller supplies a `status` labeller, which has to come from outside.',
		},
		break: {
			node: { type: 'break' },
			text: ' ',
			why: 'A space, so the two lines it separates do not run together.',
		},
	};

	test('every node type in the AST really is walked, not merely listed', () => {
		// This used to build `handled` from `BLOCK_TYPES` and `INLINE_TYPES` and then check
		// membership against `AST_NODE_TYPES`, which is those same arrays concatenated. It
		// held by construction and could never fail. Adding a block type with no case in the
		// switch left it green except for a magic literal count, and bumping that count,
		// which is what the failure invited, made the file pass while `blockText` silently
		// dropped every one of those nodes from the table of contents, the search index, the
		// reading estimate and llms.txt.
		//
		// So each type is now fed through the walk that owns it. Two types contribute
		// nothing unless a caller asks, and one contributes nothing at all; each says why.
		const options = {
			status: (value: string) => value,
			image: (node: { alt: string }) => node.alt,
			code: true,
		};
		let examined = 0;
		for (const type of AST_NODE_TYPES) {
			const sample = SAMPLES[type];
			expect(sample, `${type} has no sample, so nothing exercises its walk`).toBeDefined();
			if (sample === undefined) continue;

			// The three child types have no walk of their own: a `listItem` only ever reaches
			// a walk through its list. Their samples are the parent, so what is asserted is
			// that the parent's case descends into them.
			const walked = (INLINE_TYPES as readonly string[]).includes(type)
				? inlineText([sample.node as Inline], options)
				: blockText([sample.node as Block], options);
			expect(walked, `${type} walked to the wrong text`).toBe(sample.text ?? '');
			examined += 1;
		}
		expect(examined).toBe(AST_NODE_TYPES.length);
		expect(examined).toBe(22);
	});

	test('the child types are walked through their parents as well as directly', () => {
		// `listItem`, `tableCell` and `step` are reachable only from a parent, so a walk that
		// handled them directly and dropped them from the parent's case would pass above.
		expect(blockText([SAMPLES.list?.node as Block])).toContain('One');
		expect(blockText([SAMPLES.table?.node as Block])).toContain('NTAG213');
		expect(blockText([SAMPLES.steps?.node as Block])).toContain('First');
	});

	test('every status value can be labelled', () => {
		for (const value of STATUS_VALUES) {
			expect(inlineText([{ type: 'status', value }], { status: (given) => given })).toBe(value);
		}
	});
});
