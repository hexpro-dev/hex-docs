/**
 * The rules that need more than one page.
 *
 * Every one of these is a question a single file cannot answer: whether an anchor
 * exists on the other side of a link, whether a page appears in the nav at all, whether
 * a translation says the same thing as its source. They run once, after every page has
 * compiled, which is also why they are the rules most likely to be skipped by a tool
 * that lints one file at a time.
 */

import type { Block, Inline, Link } from '../../../../src/contracts/ast.js';
import { blockText } from '../../../../src/ast/text.js';
import type { TranslationState } from '../../../../src/contracts/frontmatter.js';
import type { Locale } from '../../../../src/contracts/locales.js';
import { SOURCE_LOCALE, sortLocales } from '../../../../src/contracts/locales.js';
import { MAX_NAV_DEPTH, navDepth, navDocs, navGroupIds } from '../../../../src/contracts/nav.js';
import type { DocsProjectConfig, GlossaryEntry } from '../../../../src/contracts/project.js';
import { normaliseText } from '../../../../src/search/normalise.js';
import { tokenise } from '../../../../src/search/tokenise.js';

import type { CompiledPageOutput } from '../page.js';
import type { LoadedProject } from '../project.js';
import { locate, raw, type RawFinding } from '../types.js';

export interface ProjectRuleContext {
	project: LoadedProject;
	/** Slug to locale to what compiling it produced. */
	pages: Map<string, Map<Locale, CompiledPageOutput>>;
	/** Slug to locale to the page's own translation state, before its snippets are folded in. */
	pageStates: Map<string, Map<Locale, TranslationState>>;
	/** Snippet id to locale to its own state. */
	snippetStates: Map<string, Map<Locale, TranslationState>>;
	/** Slugs excluded from the bundle, which are linted and not published. */
	drafts: ReadonlySet<string>;
}

export function projectFindings(context: ProjectRuleContext): RawFinding[] {
	return [
		...navFindings(context),
		...anchorFindings(context),
		...translationFindings(context),
		...glossaryFindings(context),
	];
}

// ---------------------------------------------------------------------------
// nav
// ---------------------------------------------------------------------------

function navFindings(context: ProjectRuleContext): RawFinding[] {
	const findings: RawFinding[] = [];
	const { nav } = context.project;
	const entries = navDocs(nav);
	const seen = new Set<string>();

	for (const entry of entries) {
		if (seen.has(entry.slug)) {
			findings.push(
				raw(
					'nav-duplicate',
					{ kind: 'file', file: 'nav.json' },
					null,
					`"${entry.slug}" appears in the nav twice.`,
					{
						remediation:
							'Keep one entry. Two entries give the page two positions in reading order, so prev and next disagree with the sidebar.',
						excerpt: entry.slug,
					},
				),
			);
		}
		seen.add(entry.slug);
		if (!context.pages.has(entry.slug)) {
			findings.push(
				raw(
					'link-resolves',
					{ kind: 'file', file: 'nav.json' },
					null,
					`The nav names "${entry.slug}", which is not a page in this project.`,
					{
						remediation:
							'Add the page, or remove the entry. A nav entry pointing at nothing renders as a link to a 404.',
						excerpt: entry.slug,
					},
				),
			);
		}
	}

	const groups = navGroupIds(nav);
	const seenGroups = new Set<string>();
	for (const group of groups) {
		if (seenGroups.has(group)) {
			findings.push(
				raw(
					'nav-duplicate',
					{ kind: 'file', file: 'nav.json' },
					null,
					`Two nav groups share the id "${group}".`,
					{
						remediation:
							'Rename one. Group ids appear in the DOM, so two of them make one of the two unaddressable.',
						excerpt: group,
					},
				),
			);
		}
		seenGroups.add(group);
	}

	const depth = navDepth(nav);
	if (depth > MAX_NAV_DEPTH) {
		findings.push(
			raw(
				'nav-depth',
				{ kind: 'file', file: 'nav.json' },
				null,
				`The nav nests ${depth} levels of groups and the limit is ${MAX_NAV_DEPTH}.`,
				{
					remediation:
						'Flatten a level. A fourth level renders and is unusable on a phone: the indent eats the text column, and in Arabic it eats it from the other side.',
				},
			),
		);
	}

	for (const slug of context.pages.keys()) {
		if (seen.has(slug) || context.drafts.has(slug)) continue;
		const source = context.pages.get(slug)?.get(SOURCE_LOCALE);
		findings.push(
			raw(
				'orphan-page',
				{ kind: 'file', file: source?.page.sourceFile ?? 'nav.json' },
				null,
				`"${slug}" is published and appears nowhere in nav.json.`,
				{
					remediation:
						'Add it to the nav, or mark it draft. An orphan is reachable by URL, unreachable by reading, and invisible to prev and next.',
					excerpt: slug,
				},
			),
		);
	}

	return findings;
}

// ---------------------------------------------------------------------------
// anchors
// ---------------------------------------------------------------------------

function anchorFindings(context: ProjectRuleContext): RawFinding[] {
	const findings: RawFinding[] = [];

	for (const [slug, byLocale] of context.pages) {
		for (const [locale, output] of byLocale) {
			walkLinks(output.page.body, (link) => {
				const anchor =
					link.kind === 'anchor' ? link.anchor : link.kind === 'internal' ? link.anchor : undefined;
				if (anchor === undefined) return;

				const targetSlug = link.kind === 'internal' ? link.slug : slug;
				const targets = context.pages.get(targetSlug);
				// A translated page falls back to the source locale when it has no file of its
				// own, so the anchor has to be checked against whichever page the reader will
				// actually be served rather than against the one that does not exist.
				const target = targets?.get(locale) ?? targets?.get(SOURCE_LOCALE);
				if (target === undefined) return;
				if (target.anchors.has(anchor)) return;

				findings.push(
					raw(
						'anchor-resolves',
						locate(output.parsed.origins, link, output.page.sourceFile),
						locale,
						`"#${anchor}" is not a heading on ${targetSlug === slug ? 'this page' : `"${targetSlug}"`}${target.page.locale === locale ? '' : ` in ${target.page.locale}`}.`,
						{
							remediation:
								'Check the anchor. An id derived from heading text is locale-dependent by construction, which is what aliases exist for: a translated heading also answers to the source locale spelling.',
							excerpt: anchor,
						},
					),
				);
			});
		}
	}

	return findings;
}

function walkLinks(blocks: readonly Block[], visit: (link: Link) => void): void {
	const inline = (nodes: readonly Inline[]): void => {
		for (const node of nodes) {
			if (node.type === 'link') {
				visit(node);
				inline(node.children);
			} else if (
				node.type === 'emphasis' ||
				node.type === 'strong' ||
				node.type === 'strikethrough'
			) {
				inline(node.children);
			}
		}
	};

	const walk = (nodes: readonly Block[]): void => {
		for (const block of nodes) {
			switch (block.type) {
				case 'paragraph':
				case 'heading':
					inline(block.children);
					break;
				case 'list':
					for (const item of block.children) walk(item.children);
					break;
				case 'blockquote':
					walk(block.children);
					break;
				case 'callout':
					if (block.title !== undefined) inline(block.title);
					walk(block.children);
					break;
				case 'table':
					if (block.caption !== undefined) inline(block.caption);
					for (const cell of block.header) inline(cell.children);
					for (const row of block.rows) for (const cell of row) inline(cell.children);
					break;
				case 'figure':
					if (block.caption !== undefined) inline(block.caption);
					break;
				case 'steps':
					for (const step of block.children) {
						inline(step.title);
						walk(step.children);
					}
					break;
				default:
					break;
			}
		}
	};

	walk(blocks);
}

// ---------------------------------------------------------------------------
// translations
// ---------------------------------------------------------------------------

function translationFindings(context: ProjectRuleContext): RawFinding[] {
	const findings: RawFinding[] = [];
	const config = context.project.config;
	const locales = sortLocales(config.i18n.locales);

	for (const [slug, byLocale] of context.pages) {
		if (context.drafts.has(slug)) continue;
		const source = byLocale.get(SOURCE_LOCALE);
		if (source === undefined) {
			findings.push(
				raw(
					'translation-missing',
					{ kind: 'file', file: 'nav.json' },
					SOURCE_LOCALE,
					`"${slug}" has no ${SOURCE_LOCALE} file.`,
					{
						remediation:
							'Every page is authored in the source locale and translated outward. A page that exists only in a translation has nothing to compare against and can never be anything but stale.',
						excerpt: slug,
					},
				),
			);
			continue;
		}

		for (const locale of locales) {
			if (locale === SOURCE_LOCALE) continue;
			const output = byLocale.get(locale);
			if (output === undefined) {
				findings.push(
					raw(
						'translation-missing',
						{ kind: 'file', file: source.page.sourceFile },
						locale,
						`"${slug}" has no ${locale} translation.`,
						{
							remediation: `Write content/${locale}/${slug}.md, or accept the fallback: under graceful parity the site serves the source locale with a notice and noindex.`,
							excerpt: slug,
						},
					),
				);
				continue;
			}

			const state = context.pageStates.get(slug)?.get(locale);
			if (state === 'stale') {
				findings.push(
					raw(
						'translation-stale',
						{ kind: 'file', file: output.page.sourceFile },
						locale,
						`The ${locale} translation of "${slug}" is older than its source.`,
						{
							remediation:
								'Retranslate it. Staleness comes from git committer dates rather than from a field, so there is nothing to refresh but the text.',
						},
					),
				);
			}

			findings.push(...sourceTextFindings(source, output, locale, state));
			findings.push(...headingParityFindings(source, output, locale, state));
		}
	}

	for (const [id, byLocale] of context.snippetStates) {
		for (const locale of locales) {
			if (locale === SOURCE_LOCALE) continue;
			const state = byLocale.get(locale);
			const file = `snippets/${locale}/${id}.md`;
			if (state === undefined) {
				findings.push(
					raw(
						'translation-missing',
						{ kind: 'file', file: `snippets/${SOURCE_LOCALE}/${id}.md` },
						locale,
						`The snippet "${id}" has no ${locale} translation.`,
						{
							remediation: `Write snippets/${locale}/${id}.md. A snippet is per locale on purpose: a flat tree would inject the source language into a translated page and the page would still read current.`,
							excerpt: id,
						},
					),
				);
				continue;
			}
			if (state === 'stale') {
				findings.push(
					raw(
						'translation-stale',
						{ kind: 'file', file },
						locale,
						`The ${locale} translation of the snippet "${id}" is older than its source.`,
						{
							remediation:
								'Retranslate it. Every page that transcludes it is no fresher than this fragment, which is what the effective state on those pages already says.',
						},
					),
				);
			}
		}
	}

	return findings;
}

/**
 * A translation whose text is still the source language.
 *
 * The state is set by `translated: false` in front matter, written by the scaffolder
 * and removed by whoever actually translates the page. This is the second, independent
 * signal, and it fires only when the flag is absent: two findings about the same page
 * would make the flag look like the problem rather than the reminder.
 */
function sourceTextFindings(
	source: CompiledPageOutput,
	output: CompiledPageOutput,
	locale: Locale,
	state: TranslationState | undefined,
): RawFinding[] {
	if (state === 'scaffolded') return [];
	const sourceText = normaliseText(blockText(source.page.body)).trim();
	const text = normaliseText(blockText(output.page.body)).trim();
	if (sourceText === '' || text === '') return [];

	const overlap = similarity(sourceText, text);
	if (sourceText !== text && overlap < 0.9) return [];

	return [
		raw(
			'translation-is-source-text',
			{ kind: 'file', file: output.page.sourceFile },
			locale,
			sourceText === text
				? `The ${locale} page is byte for byte the source text.`
				: `The ${locale} page is ${Math.round(overlap * 100)} per cent the same tokens as its source.`,
			{
				remediation:
					'Translate it, or add "translated: false" to its front matter until somebody does. Timestamps cannot see this: a scaffolded file is committed after the source it copies, so its dates say current forever.',
			},
		),
	];
}

/** Jaccard overlap of the two token sets. Cheap, and enough to tell a copy from a translation. */
function similarity(a: string, b: string): number {
	const left = new Set(tokenise(a));
	const right = new Set(tokenise(b));
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const term of left) if (right.has(term)) shared += 1;
	return shared / (left.size + right.size - shared);
}

/**
 * Heading parity, graded.
 *
 * An error when the translation is current and a warning when it is already stale. A
 * hard error in both states deadlocks a project: add one heading to an English page and
 * the only ways to publish become retranslating six pages immediately or deleting them.
 */
function headingParityFindings(
	source: CompiledPageOutput,
	output: CompiledPageOutput,
	locale: Locale,
	state: TranslationState | undefined,
): RawFinding[] {
	const expected = source.headings;
	const actual = output.headings;
	if (expected.length === actual.length && expected.every((h, i) => h.depth === actual[i]?.depth)) {
		return [];
	}

	const drifted =
		expected.length === actual.length
			? expected
					.map((h, i) =>
						h.depth === actual[i]?.depth
							? null
							: `${actual[i]?.id ?? '?'} is level ${actual[i]?.depth ?? '?'} and its source is level ${h.depth}`,
					)
					.filter((entry): entry is string => entry !== null)
					.join('; ')
			: `the source has ${expected.length} headings and this has ${actual.length}`;

	return [
		raw(
			'heading-set-matches-source',
			{ kind: 'file', file: output.page.sourceFile },
			locale,
			`The heading structure does not match the source: ${drifted}.`,
			{
				remediation:
					state === 'current'
						? 'Match the structure. A deep link written against one language lands on the wrong section in another when the outlines differ.'
						: 'This page is already out of date, so this is a warning rather than an error. Fix the structure when it is retranslated.',
			},
		),
	];
}

// ---------------------------------------------------------------------------
// glossary
// ---------------------------------------------------------------------------

function glossaryFindings(context: ProjectRuleContext): RawFinding[] {
	const glossary = context.project.config.glossary;
	if (glossary === undefined || glossary.length === 0) return [];

	const findings: RawFinding[] = [];
	for (const [slug, byLocale] of context.pages) {
		const source = byLocale.get(SOURCE_LOCALE);
		if (source === undefined) continue;
		const sourceText = blockText(source.page.body, { code: true });

		for (const [locale, output] of byLocale) {
			if (locale === SOURCE_LOCALE) continue;
			const text = blockText(output.page.body, { code: true });
			for (const entry of glossary) {
				const finding = glossaryFinding(
					entry,
					sourceText,
					text,
					locale,
					output,
					slug,
					context.project.config,
				);
				if (finding !== null) findings.push(finding);
			}
		}
	}
	return findings;
}

function glossaryFinding(
	entry: GlossaryEntry,
	sourceText: string,
	text: string,
	locale: Locale,
	output: CompiledPageOutput,
	slug: string,
	config: DocsProjectConfig,
): RawFinding | null {
	if (!mentions(sourceText, entry.term)) return null;

	if (entry.kind === 'do-not-translate') {
		// Substring containment in the translation, word boundaries in the source. Chinese
		// and Japanese have no spaces, so "NDEF" in a translated page is routinely written
		// against a Han character on both sides, and a word-boundary test reports every
		// correctly translated page in two of the seven languages as having dropped the term.
		if (containsFold(text, entry.term)) return null;
		return raw(
			'glossary-term-translated',
			{ kind: 'file', file: output.page.sourceFile },
			locale,
			`"${entry.term}" is in the do-not-translate glossary and does not appear in the ${locale} page.`,
			{
				remediation:
					entry.note ??
					`Keep the term as written. ${config.productName} readers type it into a search box, and a localised part number makes the page unfindable in that language.`,
				excerpt: entry.term,
			},
		);
	}

	const expected = entry.translations[locale];
	if (text.includes(expected)) return null;
	return raw(
		'glossary-term-translated',
		{ kind: 'file', file: output.page.sourceFile },
		locale,
		`The source page for "${slug}" uses "${entry.term}", and the ${locale} page does not use "${expected}".`,
		{
			remediation:
				entry.note ??
				'One spelling per language. Three sessions writing one manual is how the same object ends up with three words for it.',
			excerpt: expected,
			suggestion: expected,
		},
	);
}

/** Case-insensitive substring containment, for a language with no word boundaries. */
function containsFold(text: string, term: string): boolean {
	return text.toLowerCase().includes(term.toLowerCase());
}

/** Word-boundary containment, case-insensitive, for a term that may carry digits. */
function mentions(text: string, term: string): boolean {
	const escaped = term.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
}
