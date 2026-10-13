/**
 * Directives in the markdown served at `<slug>.md`, written out as plain markdown.
 *
 * The golden files hold what the corpus lowers to. This holds each decision on its own,
 * the ones the corpus does not reach included: every callout kind in both spellings, the
 * label in each language, every way one container sits inside another, the refusals, and
 * the guards that stop a build rather than publish a `:::`. Every case is compiled
 * through `compilePage`, so `assertLowered` has already read each result back by the time
 * an expectation runs.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { SITE_ROOT } from '../../../fixtures/index.js';
import { CALLOUT_KINDS } from '../../../src/contracts/ast.js';
import { LOCALES, type Locale } from '../../../src/contracts/locales.js';
import { RAW_ASSET_LINK, RAW_PAGE_LINK } from '../../../src/contracts/manifest.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';
import { CALLOUT_LABELS } from '../../../src/ui/strings.js';
import { highlight } from '../../src/compile/highlight/index.js';
import { assertLowered, calloutLead, lowerDirectives } from '../../src/compile/lower.js';
import { parseDocument } from '../../src/compile/markdown/index.js';
import { compilePage, rawSnippetBody } from '../../src/compile/page.js';
import type { DirectiveRecord, ParseServices } from '../../src/compile/types.js';

const CONFIG = JSON.parse(readFileSync(join(SITE_ROOT, 'docs.json'), 'utf8')) as DocsProjectConfig;
const IMAGE = `${'d'.repeat(64)}.png`;
const SNIPPET = 'From the snippet, first paragraph.\n\nFrom the snippet, second paragraph.';

function services(): ParseServices {
	return {
		highlight,
		resolveLink: (href) =>
			href === 'first-tag.md'
				? { ok: true, link: { type: 'link', kind: 'internal', slug: 'guide/first-tag' } }
				: { ok: true, link: { type: 'link', kind: 'external', href } },
		resolveImage: () => ({ ok: true, src: `assets/${IMAGE}`, width: 4, height: 4 }),
		resolveInclude: (id) =>
			id === 'safety-note'
				? {
						ok: true,
						blocks: [
							{ type: 'paragraph', children: [{ type: 'text', value: 'From the snippet.' }] },
						],
					}
				: { ok: false, message: `There is no snippet "${id}".`, remediation: null },
	};
}

interface Options {
	locale?: Locale;
	snippetBodies?: Map<string, string>;
}

function compile(body: string, options: Options = {}) {
	const locale = options.locale ?? 'en';
	return compilePage({
		config: CONFIG,
		slug: 'guide/example',
		locale,
		document: {
			file: `content/${locale}/guide/example.md`,
			repoPath: `docs/site/content/${locale}/guide/example.md`,
			locale,
			id: 'guide/example',
			text: `---\ntitle: A page\ndescription: One sentence.\n---\n\n${body}\n`,
		},
		services: services(),
		translation: { state: 'source', sourceUpdated: '2026-01-05T09:00:00Z' },
		snippetBodies: options.snippetBodies ?? new Map([['safety-note', SNIPPET]]),
	});
}

/** The raw markdown under its title, which every case here would otherwise repeat. */
function rawOf(body: string, options: Options = {}): string {
	return compile(body, options).raw.split('\n').slice(2).join('\n').trimEnd();
}

const lines = (...rows: string[]): string => rows.join('\n');

describe('a procedure', () => {
	test('is an ordered list, each title in bold and each body indented under it', () => {
		const body = lines(
			'Before.',
			'',
			'::::steps',
			':::step[Open the scan screen]',
			'Tap **Scan** on the [home screen](first-tag.md).',
			'',
			'```text',
			'NFC ready',
			'```',
			':::',
			'',
			':::step[Hold the tag]',
			'- Keep it still.',
			'- Wait for the tick.',
			':::',
			'::::',
			'',
			'After.',
		);
		expect(rawOf(body)).toBe(
			lines(
				'Before.',
				'',
				'1. **Open the scan screen**',
				'',
				`   Tap **Scan** on the [home screen](${RAW_PAGE_LINK}guide/first-tag.md).`,
				'',
				'   ```text',
				'   NFC ready',
				'   ```',
				'',
				'2. **Hold the tag**',
				'',
				'   - Keep it still.',
				'   - Wait for the tick.',
				'',
				'After.',
			),
		);
	});

	test('indents each body to the width of its own number', () => {
		// CommonMark continues a list item at the column its content starts, which is one
		// further along from step 10 than from step 9. Indented to the narrower width, the
		// tenth body would be a paragraph after the list rather than part of the step.
		const steps = Array.from({ length: 10 }, (_, index) =>
			lines(`:::step[Step ${index + 1}]`, `Body ${index + 1}.`, ':::'),
		);
		const raw = rawOf(lines('::::steps', ...steps, '::::'));
		expect(raw).toContain(lines('9. **Step 9**', '', '   Body 9.'));
		expect(raw).toContain(lines('10. **Step 10**', '', '    Body 10.'));
	});

	test('writes a step with no title as its number alone', () => {
		expect(rawOf(lines('::::steps', ':::step', 'Just do it.', ':::', '::::'))).toBe(
			lines('1.', '', '   Just do it.'),
		);
	});
});

describe('a callout', () => {
	test.each(CALLOUT_KINDS)(
		'of kind %s, untitled, runs its label into its first paragraph in either spelling',
		(kind) => {
			const expected = lines(
				`> **${CALLOUT_LABELS.en[kind]}:** The tag must be`,
				'> formatted first.',
			);
			expect(rawOf(lines(`:::${kind}`, 'The tag must be', 'formatted first.', ':::'))).toBe(
				expected,
			);
			expect(
				rawOf(lines(`> [!${kind.toUpperCase()}]`, '> The tag must be', '> formatted first.')),
			).toBe(expected);
		},
	);

	test('with a title puts the label and the title on a line of their own', () => {
		// The page shows the title in place of the label. The label stays in the text because
		// the kind is otherwise lost to a reader with no colour and no icon to go on.
		expect(rawOf(lines(':::warning[Keep the password]', 'It is the only copy.', ':::'))).toBe(
			lines('> **Warning: Keep the password**', '>', '> It is the only copy.'),
		);
	});

	test('that opens with a list, a fence or a snippet keeps its label on a line of its own', () => {
		// A label run into a list item would be part of the item, and one run into a fence
		// would be code. A snippet's paragraph is not in this page's lines at all.
		expect(rawOf(lines(':::note', '- One', '- Two', ':::'))).toBe(
			lines('> **Note:**', '>', '> - One', '> - Two'),
		);
		expect(rawOf(lines(':::tip', '```text', 'ok', '```', ':::'))).toBe(
			lines('> **Tip:**', '>', '> ```text', '> ok', '> ```'),
		);
		expect(rawOf(lines(':::caution', '::include[safety-note]', ':::'))).toBe(
			lines(
				'> **Caution:**',
				'>',
				'> From the snippet, first paragraph.',
				'>',
				'> From the snippet, second paragraph.',
			),
		);
	});

	test('keeps a blank line, a comment and a link where the author put them', () => {
		const body = lines(
			':::note',
			'One, with [a link](first-tag.md).',
			'',
			'<!-- a note to the next author -->',
			'Two.',
			':::',
		);
		expect(rawOf(body)).toBe(
			lines(
				`> **Note:** One, with [a link](${RAW_PAGE_LINK}guide/first-tag.md).`,
				'>',
				'>',
				'> Two.',
			),
		);
	});

	test('is labelled in the language of the page, punctuated as that language punctuates it', () => {
		const expected: Record<Locale, string> = {
			en: '**Tip:**',
			zh: '**\u63d0\u793a\uff1a**',
			ar: '**\u062a\u0644\u0645\u064a\u062d:**',
			es: '**Sugerencia:**',
			ja: '**\u30d2\u30f3\u30c8\uff1a**',
			fr: '**Conseil\u00a0:**',
			'pt-BR': '**Dica:**',
		};
		for (const locale of LOCALES) {
			expect(rawOf(lines(':::tip', 'Text.', ':::'), { locale })).toBe(
				`> ${expected[locale]} Text.`,
			);
		}
		// A title follows a full-width colon with no space, and a Latin colon with one.
		expect(calloutLead('ja', 'warning', '\u6ce8\u610f')).toBe('**\u8b66\u544a\uff1a\u6ce8\u610f**');
		expect(calloutLead('fr', 'warning', 'Attention')).toBe('**Avertissement\u00a0: Attention**');
	});
});

describe('a caption', () => {
	test('of a table is a bold line before the table', () => {
		const table = ['| Chip | Read |', '| --- | --- |', '| NTAG213 | yes |'];
		expect(rawOf(lines(':::table[Support by chip]', ...table, ':::'))).toBe(
			lines('**Support by chip**', '', ...table),
		);
		expect(rawOf(lines(':::table', ...table, ':::'))).toBe(lines(...table));
		// Before the table rather than at the top of the container, which is where the page
		// puts it when the container holds a sentence first.
		expect(
			rawOf(lines(':::table[Support by chip]', 'Measured on iOS 18.', '', ...table, ':::')),
		).toBe(lines('Measured on iOS 18.', '', '**Support by chip**', '', ...table));
	});

	test('of a figure is a bold line after the image', () => {
		const image = `![The scan sheet](${RAW_ASSET_LINK}${IMAGE})`;
		expect(rawOf(lines(':::figure[Waiting for a tag]', '![The scan sheet](scan.png)', ':::'))).toBe(
			lines(image, '', '**Waiting for a tag**'),
		);
		expect(rawOf(lines(':::figure', '![The scan sheet](scan.png)', ':::'))).toBe(image);
	});

	test('is a paragraph of its own even with no blank line above the container', () => {
		// The parser lets a directive interrupt a paragraph and CommonMark does not let a bold
		// line do the same, so without the separator the caption would end the sentence.
		expect(
			rawOf(lines('Read the table.', ':::table[Chips]', '| A |', '| - |', '| 1 |', ':::')),
		).toBe(lines('Read the table.', '', '**Chips**', '', '| A |', '| - |', '| 1 |'));
	});
});

describe('an explicit heading anchor', () => {
	test('comes off the heading, and the page still answers to it', () => {
		const output = compile(
			lines(
				'## Station data {#station-data}',
				'',
				'Text.',
				'',
				'> ## Quoted {#quoted}',
				'',
				'- ## Listed {#listed}',
			),
		);
		expect(output.raw).toContain('\n## Station data\n');
		expect(output.raw).toContain('\n> ## Quoted\n');
		expect(output.raw).toContain('\n- ## Listed\n');
		expect(output.raw).not.toContain('{#');
		expect([...output.anchors]).toEqual(
			expect.arrayContaining(['station-data', 'quoted', 'listed']),
		);
	});
});

describe('one container inside another', () => {
	test('a callout in a step is a quotation inside the list item', () => {
		const body = lines(
			':::::steps',
			'::::step[Hold the tag]',
			'Keep it still.',
			'',
			':::warning',
			'Do not press.',
			':::',
			'::::',
			':::::',
		);
		expect(rawOf(body)).toBe(
			lines('1. **Hold the tag**', '', '   Keep it still.', '', '   > **Warning:** Do not press.'),
		);
	});

	test('a procedure in a callout is a list inside the quotation', () => {
		const body = lines(
			':::::note[Before you start]',
			'::::steps',
			':::step[Charge the phone]',
			'It needs ten per cent.',
			':::',
			'::::',
			':::::',
		);
		expect(rawOf(body)).toBe(
			lines(
				'> **Note: Before you start**',
				'>',
				'> 1. **Charge the phone**',
				'>',
				'>    It needs ten per cent.',
			),
		);
	});

	test('a callout in a quotation and in a list item keeps the context it sits in', () => {
		const body = lines(
			'> :::note',
			'> Quoted.',
			'>',
			'> Twice.',
			'> :::',
			'',
			'- Item.',
			'',
			'  :::tip',
			'  Listed.',
			'',
			'',
			'  Again.',
			'  :::',
		);
		// The two blank lines in the list item are one to the parser, and both are inside
		// the quotation all the same: a bare blank line there would end it, and a `>` at the
		// margin would end the list.
		expect(rawOf(body)).toBe(
			lines(
				'> > **Note:** Quoted.',
				'> >',
				'> > Twice.',
				'',
				'- Item.',
				'',
				'  > **Tip:** Listed.',
				'  >',
				'  >',
				'  > Again.',
			),
		);
	});

	test('a snippet in a step is indented with the step', () => {
		expect(
			rawOf(lines('::::steps', ':::step[Read this]', '::include[safety-note]', ':::', '::::')),
		).toBe(
			lines(
				'1. **Read this**',
				'',
				'   From the snippet, first paragraph.',
				'',
				'   From the snippet, second paragraph.',
			),
		);
	});
});

describe('directive syntax that is code', () => {
	test('is left exactly as typed, at the top and inside a step', () => {
		const sample = [':::note[Title]', '::include[safety-note]', '## Heading {#anchor}'];
		expect(rawOf(lines('```markdown', ...sample, ':::', '```'))).toBe(
			lines('```markdown', ...sample, ':::', '```'),
		);
		// No close line in the sample inside the step. A container's close is searched for
		// without regard to fences, so a `:::` there would close the step, in the page
		// payload as much as here; that is the parser's grammar, and the lowering follows it.
		expect(
			rawOf(
				lines('::::steps', ':::step[Write it]', '```markdown', ...sample, '```', ':::', '::::'),
			),
		).toBe(
			lines('1. **Write it**', '', '   ```markdown', ...sample.map((row) => `   ${row}`), '   ```'),
		);
	});
});

describe('what the parser refused', () => {
	test('a container it does not know loses its markers and keeps its contents', () => {
		const output = compile(lines(':::tabs[Platform]', 'Content.', ':::', '', 'After.'));
		expect(output.raw.split('\n').slice(2).join('\n').trimEnd()).toBe(
			lines('Content.', '', 'After.'),
		);
		// And the build fails on it regardless, which no project can switch off.
		expect(output.findings.map((finding) => finding.rule)).toContain('unsupported-syntax');
	});

	test('a lone step, a stray close, an unknown leaf and text loose in steps leave nothing', () => {
		const body = lines(
			':::step[Alone]',
			'Kept, as the payload keeps it.',
			':::',
			'',
			':::',
			'',
			'::video[intro]',
			'',
			'::::steps',
			'Loose text.',
			':::step[Real]',
			'Body.',
			':::',
			'::::',
		);
		const output = compile(body);
		expect(output.raw.split('\n').slice(2).join('\n').trimEnd()).toBe(
			lines('Kept, as the payload keeps it.', '', '1. **Real**', '', '   Body.'),
		);
		expect(output.findings.filter((finding) => finding.rule === 'unsupported-syntax').length).toBe(
			4,
		);
	});

	test('an include it could not expand leaves nothing behind', () => {
		const output = compile(lines('Before.', '', '::include[missing]', '', 'After.'));
		expect(output.raw).not.toContain('::include');
		expect(output.raw.split('\n').slice(2).join('\n').trimEnd()).toBe(
			lines('Before.', '', 'After.'),
		);
		expect(output.findings.map((finding) => finding.rule)).toContain('snippet-resolves');
	});
});

describe('a snippet', () => {
	test('is lowered from its own parse, and the scaffold comparison never is', () => {
		const text = lines(':::warning', 'Do not force it.', ':::');
		const parsed = parseDocument(text, {
			file: 'snippets/fr/safety-note.md',
			config: CONFIG,
			services: services(),
			includeDepth: 1,
		});
		const lowering = {
			locale: 'fr',
			file: 'snippets/fr/safety-note.md',
			directives: parsed.directives,
			origins: parsed.origins,
			snippetBodies: new Map<string, string>(),
		} as const;
		expect(rawSnippetBody(text, 1, [], lowering)).toBe(
			'> **Avertissement\u00a0:** Do not force it.',
		);
		// What `scaffolded` compares. A label in the file's own language would make a French
		// file copied byte for byte from the English one read as translated.
		expect(rawSnippetBody(text, 1, [])).toBe(text);
	});
});

describe('the guards', () => {
	const lowering = (directives: DirectiveRecord[]) => ({
		locale: 'en' as const,
		file: 'content/en/guide/example.md',
		directives,
		origins: new WeakMap(),
		snippetBodies: new Map<string, string>(),
	});

	test('a record that does not fit its line is thrown over rather than applied', () => {
		const at = { line: 1, column: 1 };
		expect(() =>
			lowerDirectives(
				'Plain text.',
				1,
				lowering([{ kind: 'include', at, id: 'x', expanded: false }]),
			),
		).toThrow(/does not fit/);
		expect(() =>
			lowerDirectives('## Heading', 1, lowering([{ kind: 'headingId', line: 1 }])),
		).toThrow(/does not fit/);
		expect(() =>
			lowerDirectives('One line.', 1, lowering([{ kind: 'dropped', at: { line: 5, column: 1 } }])),
		).toThrow(/outside the 1 lines/);
		expect(() =>
			lowerDirectives(
				'::x[y]',
				1,
				lowering([
					{ kind: 'dropped', at },
					{ kind: 'dropped', at },
				]),
			),
		).toThrow(/two directives claim line 1/);
	});

	test('a record with no lowering stops the build, naming what it met', () => {
		const unknown = { kind: 'tabs', at: { line: 1, column: 1 } } as unknown as DirectiveRecord;
		expect(() => lowerDirectives(':::tabs', 1, lowering([unknown]))).toThrow(
			/no plain markdown for \(tabs\)/,
		);
	});

	test('an include the parse expanded with no raw text for it is refused', () => {
		expect(() => compile(lines('::include[safety-note]'), { snippetBodies: new Map() })).toThrow(
			/no raw body/,
		);
	});

	test('the reread refuses directive syntax outside code and accepts it inside', () => {
		for (const left of [
			':::note',
			':::',
			'::include[x]',
			'## Title {#title}',
			'> [!NOTE]\n> Text.',
		]) {
			expect(() => assertLowered(`# T\n\nText.\n\n${left}\n`, 'content/en/a.md', CONFIG)).toThrow(
				/still holds directive syntax/,
			);
		}
		expect(() =>
			assertLowered(
				'# T\n\n```markdown\n:::note\n::include[x]\n## Title {#title}\n:::\n```\n',
				'content/en/a.md',
				CONFIG,
			),
		).not.toThrow();
	});
});
