/**
 * One page, in one locale, compiled.
 *
 * Everything the renderer needs and nothing it has to derive. The table of contents is
 * the clearest case and the one that sets the rule for the rest: it is a publish-time
 * product of the heading nodes, already filtered to `toc.maxDepth` and already decided
 * against `toc.minHeadings`, because the renderer has no project config to decide with
 * and re-deriving it would mean walking the tree on every server render.
 */

import { AST_VERSION, type Block, type Heading } from '../../../src/contracts/ast.js';
import { blockText, inlineText } from '../../../src/ast/text.js';
import {
	DEFAULT_AUDIENCE,
	DEFAULT_PAGE_KIND,
	type DocFrontMatter,
	type TranslationRecord,
} from '../../../src/contracts/frontmatter.js';
import type { Locale } from '../../../src/contracts/locales.js';
import {
	LEAF_DIRECTIVE_PATTERN,
	SNIPPET_ID_PATTERN,
	SNIPPET_INCLUDE_NAME,
} from '../../../src/contracts/source.js';
import type { HeadingRecord } from '../../../src/contracts/manifest.js';
import type { CompiledPage, PageHeading } from '../../../src/contracts/page.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';
import { countWords } from '../../../src/search/tokenise.js';
import { frontMatterSchema } from '../contracts/config.schema.js';

import { parseDocument } from './markdown/index.js';
import type { SourceDocument } from './project.js';
import {
	locate,
	raw,
	type NodeOrigins,
	type ParseServices,
	type ParsedDocument,
	type RawFinding,
} from './types.js';

export interface CompilePageOptions {
	config: DocsProjectConfig;
	slug: string;
	locale: Locale;
	document: SourceDocument;
	services: ParseServices;
	/**
	 * The source locale's heading ids, in document order, so a translated heading can
	 * answer to the anchor somebody wrote against the English page.
	 *
	 * Matched by position, which is the same assumption `heading-set-matches-source`
	 * checks: when the two pages have different heading counts no alias is assigned at
	 * all, because a positional match across a structural difference would silently point
	 * a deep link at the wrong section.
	 */
	sourceHeadingIds?: readonly string[];
	translation: TranslationRecord;
	/** Snippet body text by id, for the markdown served at `<slug>.md`. */
	snippetBodies?: ReadonlyMap<string, string>;
	origins?: NodeOrigins;
}

export interface CompiledPageOutput {
	page: CompiledPage;
	parsed: ParsedDocument;
	/** Every heading, in document order, which is what heading parity is graded against. */
	headings: HeadingRecord[];
	/** Every anchor this page answers to: ids and aliases. */
	anchors: Set<string>;
	findings: RawFinding[];
	/** The markdown served at `<slug>.md`, with includes expanded. */
	raw: string;
}

export function compilePage(options: CompilePageOptions): CompiledPageOutput {
	const { config, slug, locale, document } = options;
	const parsed = parseDocument(document.text, {
		file: document.file,
		config,
		services: options.services,
		...(options.origins === undefined ? {} : { origins: options.origins }),
	});
	// The parser reports against a file and knows nothing about locales, and every one of
	// its findings is about this file, which is in this locale. Stamping here rather than
	// threading the locale through the parser keeps the parser testable against a string
	// with no project around it, and a report grouped by language still groups these.
	const findings: RawFinding[] = parsed.problems.map((finding) =>
		finding.locale === null ? { ...finding, locale } : finding,
	);

	const front = readValidatedFrontMatter(parsed, document.file, options.slug, findings);
	const { headings, toc, anchors } = assignHeadingIds(
		parsed.blocks,
		options.sourceHeadingIds,
		parsed.origins,
		document.file,
		findings,
	);

	const tocEntries = toc.filter((entry) => entry.depth <= config.toc.maxDepth);
	const words = countWords(blockText(parsed.blocks, { code: false }));

	const page: CompiledPage = {
		ast: AST_VERSION,
		project: config.project,
		slug,
		locale,
		title: front.title,
		description: front.description,
		...(front.navTitle === undefined ? {} : { navTitle: front.navTitle }),
		audience: front.audience ?? DEFAULT_AUDIENCE,
		pageKind: front.pageKind ?? DEFAULT_PAGE_KIND,
		tags: front.tags ?? [],
		...(front.since === undefined ? {} : { since: front.since }),
		toc: config.toc.enabled && front.toc !== false && tocEntries.length >= config.toc.minHeadings,
		headings: tocEntries,
		body: parsed.blocks,
		translation: options.translation,
		reading: { words, minutes: Math.max(1, Math.ceil(words / 200)) },
		snippets: [...new Set(parsed.includes)],
		sourceFile: document.file,
	};

	return {
		page,
		parsed,
		headings,
		anchors,
		findings,
		raw: rawMarkdown(front.title, parsed, options.snippetBodies ?? new Map()),
	};
}

/**
 * Front matter, validated, with a usable value either way.
 *
 * A page whose front matter does not validate still compiles, because the alternative
 * is one finding about the front matter and nothing at all about the four hundred lines
 * under it. The fallbacks are poor on purpose, because a mistake in front matter should
 * be visible on the page rather than papered over. Poor is not the same as invalid: an
 * empty title and an empty description are refused by `compiledPageSchema`, so a page
 * that took them compiled to a payload the bundle's own schema rejects, and the failure
 * surfaced downstream as a digest mismatch naming nothing. The slug is the honest
 * substitute and `buildSearchIndex` already made the same choice for the same reason: it
 * is what the address says, and a blank result row is not something a reader can act on.
 */
function readValidatedFrontMatter(
	parsed: ParsedDocument,
	file: string,
	slug: string,
	findings: RawFinding[],
): DocFrontMatter {
	const result = frontMatterSchema.safeParse(parsed.frontMatter.data);
	if (result.success) return result.data;

	for (const issue of result.error.issues) {
		const key = issue.path[0];
		const line = typeof key === 'string' ? parsed.frontMatter.keyLines[key] : undefined;
		findings.push(
			raw(
				'front-matter-invalid',
				line === undefined ? { kind: 'file', file } : { kind: 'file', file, line },
				null,
				`${issue.path.length === 0 ? 'front matter' : issue.path.join('.')}: ${issue.message}`,
				{
					remediation:
						'The schema is generated to kit/schema/frontmatter-1.json, so an editor with the relative $schema set will complete the shape.',
				},
			),
		);
	}

	const data = parsed.frontMatter.data;
	const title = typeof data.title === 'string' && data.title !== '' ? data.title : slug;
	return {
		title,
		description:
			typeof data.description === 'string' && data.description !== ''
				? data.description
				: // Not the slug twice. A description is a sentence and this one says what is
					// wrong, so the page reads as broken to whoever opens it, which is the point
					// of a poor fallback, while still satisfying the schema.
					`This page's front matter did not validate, so it has no description.`,
	};
}

interface HeadingPass {
	headings: HeadingRecord[];
	toc: PageHeading[];
	anchors: Set<string>;
}

/**
 * Makes every heading id unique within the page, and gives a translation the source
 * locale's anchors as aliases.
 *
 * Uniqueness is what makes an id stable across a rebuild of the same source, which is
 * what keeps every deep link anybody pasted into a support reply working. Two headings
 * with the same text produce `id` and `id-2`, in document order, so inserting a third
 * one later does not renumber the first two.
 */
function assignHeadingIds(
	blocks: readonly Block[],
	sourceHeadingIds: readonly string[] | undefined,
	origins: NodeOrigins,
	file: string,
	findings: RawFinding[],
): HeadingPass {
	const found: Heading[] = [];
	collectHeadings(blocks, found);

	const anchors = new Set<string>();
	const headings: HeadingRecord[] = [];
	const toc: PageHeading[] = [];
	const aliasable =
		sourceHeadingIds !== undefined && sourceHeadingIds.length === found.length
			? sourceHeadingIds
			: undefined;

	let previousDepth: number | undefined;
	for (const [index, heading] of found.entries()) {
		let id = heading.id;
		let suffix = 2;
		while (anchors.has(id)) {
			id = `${heading.id}-${suffix}`;
			suffix += 1;
		}
		heading.id = id;
		anchors.add(id);

		const alias = aliasable?.[index];
		if (alias !== undefined && alias !== id && !anchors.has(alias)) {
			heading.aliases = [alias];
			anchors.add(alias);
		}

		if (previousDepth !== undefined && heading.depth > previousDepth + 1) {
			findings.push(
				raw(
					'heading-order',
					locate(origins, heading, file),
					null,
					`This heading is level ${heading.depth} under a level ${previousDepth}, which skips a level.`,
					{
						remediation:
							'Use the next level down. A screen reader announces the outline from these levels, and a skipped one reads as a missing section.',
						excerpt: inlineText(heading.children),
					},
				),
			);
		}
		previousDepth = heading.depth;

		headings.push({ id, depth: heading.depth });
		toc.push({ id, depth: heading.depth, text: inlineText(heading.children) });
	}

	return { headings, toc, anchors };
}

function collectHeadings(blocks: readonly Block[], into: Heading[]): void {
	for (const block of blocks) {
		switch (block.type) {
			case 'heading':
				into.push(block);
				break;
			case 'list':
				for (const item of block.children) collectHeadings(item.children, into);
				break;
			case 'blockquote':
			case 'callout':
				collectHeadings(block.children, into);
				break;
			case 'steps':
				for (const step of block.children) collectHeadings(step.children, into);
				break;
			default:
				break;
		}
	}
}

/** As `blocks.ts` reads a fence: three or more of one character, and the info string. */
const FENCE = /^(`{3,}|~{3,})(.*)$/;

/**
 * The markdown served at `<slug>.md`, and concatenated into `llms-full.txt`.
 *
 * Not the source file. Three differences, each because the address is read by an agent
 * rather than by an editor: the title is an `h1` at the top, because the front matter
 * that carried it is not published; `::include` is expanded, because a fragment
 * reference is meaningless to a reader who cannot fetch it; and the authoring comments
 * are already gone, stripped by the parse, because a suppression comment on a published
 * page is a leak of the process onto the product.
 *
 * Built from the source lines rather than from the tree, which is what makes the fence
 * tracking necessary rather than decorative. Both rewrites used to fire anywhere on the
 * page, so a fence documenting the authoring syntax had its `::include[safety-note]`
 * sample replaced by the snippet's whole body and its sample comment deleted, while the
 * rendered page correctly showed both as code. Two published representations of one
 * address disagreed and nothing reported it.
 */
function rawMarkdown(
	title: string,
	parsed: ParsedDocument,
	snippetBodies: ReadonlyMap<string, string>,
): string {
	const lines: string[] = [`# ${title}`, ''];
	// The marker that opened the current fence, or undefined outside one.
	let fence: string | undefined;

	for (const line of parsed.frontMatter.body.split('\n')) {
		const trimmed = line.trim();
		if (fence !== undefined) {
			lines.push(line);
			if (
				trimmed.startsWith(fence[0] as string) &&
				trimmed.length >= fence.length &&
				trimmed === trimmed[0]?.repeat(trimmed.length)
			) {
				fence = undefined;
			}
			continue;
		}
		const opening = FENCE.exec(trimmed);
		if (opening !== null) {
			fence = opening[1] as string;
			lines.push(line);
			continue;
		}

		// The comments are stripped here as well as in the parse, because this text is
		// built from the source rather than from the tree. Without it a suppression comment
		// reaches `<slug>.md` and `llms-full.txt` while never appearing in a page payload,
		// which is the half of the leak nobody would think to look for.
		if (/^\s*<!--[\s\S]*-->\s*$/.test(line)) continue;

		// Read with the contract's own leaf-directive grammar rather than a second
		// hand-copied spelling of it, so a change to the directive syntax cannot leave this
		// scan matching the old one.
		const directive = LEAF_DIRECTIVE_PATTERN.exec(trimmed);
		const id = directive?.[1] === SNIPPET_INCLUDE_NAME ? (directive[2] as string) : undefined;
		if (id === undefined || !SNIPPET_ID_PATTERN.test(id)) {
			lines.push(line);
			continue;
		}
		const body = snippetBodies.get(id);
		lines.push(body === undefined ? line : body.trimEnd());
	}
	return `${lines
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trimEnd()}\n`;
}
