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
import {
	RAW_ASSET_LINK,
	RAW_PAGE_LINK,
	type HeadingRecord,
} from '../../../src/contracts/manifest.js';
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
	type ResolvedDestination,
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
	/**
	 * Snippet body text by id, for the markdown served at `<slug>.md`, already in its raw
	 * form: see `rawSnippetBody`. Spliced in verbatim, because a snippet's destinations
	 * carry the snippet's own line numbers and this page's parse has none of them.
	 */
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

/** The one comment shape this toolchain accepts, and the one the raw markdown strips. */
const WHOLE_LINE_COMMENT = /^\s*<!--[\s\S]*-->\s*$/;

/**
 * The destination a raw object carries in place of what the author typed.
 *
 * A page is its wire slug with `.md`, which is the address of the page's own raw object
 * under a docs mount, and an asset is its bundle filename. Both are prefixed rather than
 * resolved, because the absolute form needs the locale prefix, the mount and the version
 * label, and none of the three is known until a site serves the object.
 */
export function rawDestination(target: ResolvedDestination['target']): string {
	if (target.kind === 'page') return `${RAW_PAGE_LINK}${target.slug}.md`;
	return `${RAW_ASSET_LINK}${target.src.slice(target.src.lastIndexOf('/') + 1)}`;
}

/**
 * `body` with every recorded destination replaced by its raw form, and nothing else
 * changed.
 *
 * Each destination is one insertion and its removals. Edits run right to left within a
 * line, so an earlier edit never moves the columns of a later one, and at one column a
 * removal runs before the insertion, so the token lands in front of what is left rather
 * than being removed with the path. A removal that falls outside its line, or overlaps
 * another edit, is thrown over rather than applied: every range comes from the parse of
 * this exact text, so either means the parse and the text disagree, and applying it would
 * publish a link spliced into whatever the characters there really are.
 */
export function rewriteDestinations(
	body: string,
	firstLine: number,
	destinations: readonly ResolvedDestination[],
): string {
	const lines = body.split('\n');
	const edits = destinations
		.flatMap((destination) => [
			{ ...destination.at, length: 0, text: rawDestination(destination.target) },
			...destination.remove.map((range) => ({ ...range, text: '' })),
		])
		.sort((a, b) => a.line - b.line || b.column - a.column || b.length - a.length);

	let previous: { line: number; column: number } | undefined;
	for (const edit of edits) {
		const index = edit.line - firstLine;
		const line = lines[index];
		const from = edit.column - 1;
		const overlaps =
			previous !== undefined &&
			previous.line === edit.line &&
			edit.column + edit.length > previous.column;
		if (line === undefined || from < 0 || from + edit.length > line.length || overlaps) {
			throw new Error(
				`rewriteDestinations: an edit at line ${edit.line}, column ${edit.column}, length ${edit.length} ` +
					`does not fit the text it was parsed from. The raw markdown and the page payload would disagree about where this link goes.`,
			);
		}
		lines[index] = `${line.slice(0, from)}${edit.text}${line.slice(from + edit.length)}`;
		previous = edit;
	}
	return lines.join('\n');
}

/**
 * One snippet's body as the raw markdown splices it in: destinations rewritten, the
 * authoring comments removed, and the whole trimmed.
 *
 * The comments matter here and not only in `rawMarkdown`. That function strips them from
 * a page's own body and then splices this text in verbatim for each `::include`, so a
 * suppression comment written in a snippet reached the published `<slug>.md` and the
 * `llms-full.txt` of every page including it, while never appearing in a page payload.
 *
 * A comment becomes a blank line rather than disappearing, so a paragraph is not silently
 * joined to the one below it. Given no destinations it is also how the build reads a
 * snippet to compare two locales for `scaffolded`, so the comment stripping and the
 * trimming are written once for both.
 */
export function rawSnippetBody(
	body: string,
	firstLine: number,
	destinations: readonly ResolvedDestination[],
): string {
	return rewriteDestinations(body, firstLine, destinations)
		.split('\n')
		.map((line) => (WHOLE_LINE_COMMENT.test(line) ? '' : line))
		.join('\n')
		.trim();
}

/**
 * The markdown served at `<slug>.md`, and concatenated into `llms-full.txt`.
 *
 * Not the source file. Four differences, each because the address is read by an agent
 * rather than by an editor: the title is an `h1` at the top, because the front matter
 * that carried it is not published; `::include` is expanded, because a fragment
 * reference is meaningless to a reader who cannot fetch it; the authoring comments are
 * already gone, stripped by the parse, because a suppression comment on a published
 * page is a leak of the process onto the product; and every destination that resolved
 * to a page or an asset is in its raw form, because the author's relative path is only
 * right from the source tree. `llms-full.txt` joins every page under one address, so a
 * relative link from a page two directories down resolves to nothing there, and an
 * image's path into `docs/site/assets/` is not an address anywhere.
 *
 * The rewrite is applied from the parse's own ranges before the line walk, so it follows
 * the parser's idea of what is a link. Code spans and fences are never touched because
 * the parser never recorded a destination inside one, not because this walk skips them.
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
	const body = rewriteDestinations(
		parsed.frontMatter.body,
		parsed.frontMatter.bodyLine,
		parsed.destinations,
	);

	for (const line of body.split('\n')) {
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
		if (WHOLE_LINE_COMMENT.test(line)) continue;

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
