/**
 * The compile, end to end.
 *
 * Load the tree, probe the assets, compile every page in every locale, run every rule,
 * build the search indexes, assemble the manifest and hand back the bytes. It is one
 * function because the order matters and every step depends on the one before it, and
 * because a pipeline split across four entry points is a pipeline three of whose
 * callers eventually skip a step.
 *
 * Two orderings here are load-bearing rather than convenient. The source locale is
 * compiled before every translation, because a translated heading takes the source
 * locale's anchor as an alias and a fallback page is the source locale's compiled page.
 * And the manifest is assembled last from what was actually produced, never from what
 * was intended, so a page that failed to compile is absent from it rather than present
 * and empty.
 */

import { AST_VERSION } from '../../../src/contracts/ast.js';
import type { TranslationRecord, TranslationState } from '../../../src/contracts/frontmatter.js';
import { SOURCE_LOCALE, sortLocales, type Locale } from '../../../src/contracts/locales.js';
import { navDocs } from '../../../src/contracts/nav.js';
import {
	MANIFEST_VERSION,
	assetKey,
	llmsKey,
	pageKey,
	rawKey,
	searchKey,
	validateManifestShape,
	type AssetRecord,
	type BundleManifest,
	type LocaleCoverage,
	type ManifestNavNode,
	type ObjectRecord,
	type PageLocaleRecord,
	type PageRecord,
	type SearchIndexRecord,
} from '../../../src/contracts/manifest.js';
import type { DiagnosticEnvelope } from '../../../src/contracts/diagnostics.js';
import { compareSlugStrings } from '../../../src/contracts/slug.js';
import { blockText } from '../../../src/ast/text.js';
import { countWords } from '../../../src/search/tokenise.js';
import { isNavGroup, type NavItem } from '../../../src/contracts/nav.js';

import { probeAsset } from './assets.js';
import { readFrontMatter } from './frontmatter.js';
import { compilePage, type CompiledPageOutput } from './page.js';
import { createImageResolver, createLinkResolver, type LinkTargets } from './links.js';
import { loadProject, type LoadedProject, type SourceDocument } from './project.js';
import { parseDocument } from './markdown/index.js';
import { highlight } from './highlight/index.js';
import { buildSearchIndex, type IndexablePage } from './search.js';
import { canonicalJson, gzipMember, sha256Hex, utf8Bytes } from './serialise.js';
import { pageFindings } from './lint/page.js';
import { projectFindings } from './lint/project.js';
import { PROSE_RULES } from './lint/prose.js';
import { runLint, type BlockSpan, type LintRunResult } from './lint/run.js';
import {
	raw,
	type DisableComment,
	type NodeOrigins,
	type ParseServices,
	type ProseSegment,
	type RawFinding,
} from './types.js';

export interface BuildOptions {
	/** `@hex-pro/docs-kit@<exact version>`, the one build-identity field a manifest keeps. */
	generator: string;
	/** Overrides what git reports, for a test that needs a fixed commit. */
	commit?: string;
	commitTimestamp?: string;
	/** Compiles pages marked `draft: true` as well. Off in a publish. */
	includeDrafts?: boolean;
}

export interface WrittenObject {
	/** Relative to the `ast-N` prefix. */
	key: string;
	bytes: Buffer;
}

export interface BuildResult {
	manifest: BundleManifest;
	objects: WrittenObject[];
	lint: LintRunResult;
	project: LoadedProject;
	/** Slug to locale to the compiled page, for a golden test and for the CLI. */
	pages: Map<string, Map<Locale, CompiledPageOutput>>;
	/** Problems the manifest's own invariants report, which must be empty. */
	manifestProblems: string[];
}

/** Worst first. A page is no fresher than the worst of itself and everything it includes. */
const STATE_ORDER: readonly TranslationState[] = [
	'source',
	'current',
	'stale',
	'scaffolded',
	'missing',
];

function worst(a: TranslationState, b: TranslationState): TranslationState {
	return STATE_ORDER.indexOf(a) >= STATE_ORDER.indexOf(b) ? a : b;
}

export function buildBundle(appRoot: string, options: BuildOptions): BuildResult {
	const project = loadProject(appRoot);
	const findings: RawFinding[] = [...project.findings];
	const config = project.config;
	const locales = sortLocales(config.i18n.locales);

	const commit = options.commit ?? project.repository?.head;
	const commitTimestamp = options.commitTimestamp ?? project.repository?.headTimestamp;
	if (commit === undefined || commitTimestamp === undefined) {
		throw new Error(
			`${appRoot} is not a git repository, so there is no commit to key a bundle by. Bundles are commit-addressed: the sha is the key and the label is applied later, in the web repository.`,
		);
	}
	if (project.repository?.shallow === true) {
		findings.push(
			raw('bundle-shallow-clone', { kind: 'project' }, null, 'This is a shallow clone.', {
				remediation:
					'Set fetch-depth: 0 on actions/checkout. In a shallow clone every file carries the same commit date, so the source is never newer than a translation and the whole corpus reads current, which is the wrong answer that looks fine.',
			}),
		);
	}

	// ---- assets ------------------------------------------------------------
	const assetRecords: AssetRecord[] = [];
	// Keyed by digest, which is also the key in the bucket, so an image moved between
	// pages is a no-op for the bundle. It is the record-emitted set as well as the bytes,
	// which is the part the loop below depends on.
	const assetBytes = new Map<string, Buffer>();
	const assetTargets = new Map<string, { src: string; width: number; height: number }>();
	for (const [path, asset] of [...project.assets].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		const probe = probeAsset(asset.bytes, path);
		if (!probe.ok) {
			findings.push(
				raw(probe.rule, { kind: 'file', file: path }, null, probe.message, {
					remediation: probe.remediation,
				}),
			);
			continue;
		}
		if (probe.asset.bytes > config.budgets.assetBytesMax) {
			findings.push(
				raw(
					'asset-size',
					{ kind: 'file', file: path },
					null,
					`${path} is ${probe.asset.bytes} bytes and the budget is ${config.budgets.assetBytesMax}.`,
					{
						remediation:
							'Resize or recompress it. Every asset is downloaded at build time and copied into the site, so the budget is a build-time cost as well as a reader-facing one.',
					},
				),
			);
			continue;
		}
		const digest = sha256Hex(asset.bytes);
		// One record per digest, not per path. `assetBytes` being keyed by digest deduped
		// nothing that reached the manifest, because the records and the object list are
		// built from this loop: the same logo under two names produced two identical
		// `AssetRecord`s, two `objects` entries with one key, a `counts.objects` one too
		// high, and both of `manifestProblems`' duplicate messages. Every path still gets
		// an `assetTargets` entry below, so both references resolve to the one object.
		if (!assetBytes.has(digest)) {
			assetBytes.set(digest, asset.bytes);
			assetRecords.push({ sha256: digest, ...probe.asset });
		}
		assetTargets.set(path, {
			src: assetKey(digest, probe.asset.ext),
			width: probe.asset.width,
			height: probe.asset.height,
		});
	}
	assetRecords.sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));

	// ---- what a link may point at -------------------------------------------
	const redirects = new Map<string, string>();
	const drafts = new Set<string>();
	for (const [slug, byLocale] of project.pages) {
		const source = byLocale.get(SOURCE_LOCALE);
		if (source === undefined) continue;
		const front = parseDocument(source.text, {
			file: source.file,
			config,
			services: nullServices(),
		}).frontMatter.data;
		if (front.draft === true) drafts.add(slug);
		for (const from of Array.isArray(front.redirectFrom) ? front.redirectFrom : []) {
			if (typeof from === 'string') redirects.set(from, slug);
		}
	}
	const published = new Set(
		[...project.pages.keys()].filter((slug) => options.includeDrafts === true || !drafts.has(slug)),
	);
	const targets: LinkTargets = {
		// The published set, not every slug. A draft is excluded from the bundle and was
		// still a valid link target, so a published page could link to a page the bundle
		// does not carry and `link-resolves` said nothing. The whole point of the rule is
		// that a link either resolves in this bundle or is reported, and a draft is exactly
		// the page most likely to be linked before it is ready. With `includeDrafts` the
		// drafts are in the bundle and in this set, which is the case that has to keep
		// working for a preview build.
		slugs: published,
		// Filtered the same way and for the same reason: an old slug redirecting to a page
		// held back as a draft is a link to something the bundle does not carry, and the
		// manifest's own redirect table already drops exactly these.
		redirects: new Map([...redirects].filter(([, to]) => published.has(to))),
		assets: assetTargets,
	};

	// ---- states -------------------------------------------------------------
	const dateOf = (document: SourceDocument): string | undefined =>
		project.repository?.dates.get(document.repoPath);

	const snippetStates = new Map<string, Map<Locale, TranslationState>>();
	for (const [id, byLocale] of project.snippets) {
		const states = new Map<Locale, TranslationState>();
		const source = byLocale.get(SOURCE_LOCALE);
		const sourceBody = source === undefined ? undefined : snippetBody(source);
		for (const [locale, document] of byLocale) {
			// A snippet gets the same two scaffolded signals a page gets. Passing neither
			// meant a snippet's state came from git dates alone, so it could never be
			// `scaffolded`, so the worst-of reduction below had nothing to reduce: a page
			// transcluding an untranslated English fragment published as `current`, its
			// coverage row counted it as translated, and no finding named the file. Both the
			// comment on that reduction and `TranslationRecord.state` say the published
			// state is the worst of the page and everything it transcludes, and until now
			// they were describing a rule that could not fire.
			//
			// The text signal is exact equality of the body, which is what the scaffolder
			// writes. Pages compare flattened text instead, because a page that is 92 per
			// cent the source is a near miss `translation-is-source-text` reports; a snippet
			// is a fragment with no page of its own to report against, so the state is the
			// only place it can be said.
			const body = snippetBody(document);
			states.set(
				locale,
				stateOf(
					locale,
					document,
					source,
					dateOf,
					readFrontMatter(document.text, document.file).data,
					sourceBody !== undefined && body !== '' && body === sourceBody,
				),
			);
		}
		snippetStates.set(id, states);
	}

	// ---- compile ------------------------------------------------------------
	const pages = new Map<string, Map<Locale, CompiledPageOutput>>();
	const pageStates = new Map<string, Map<Locale, TranslationState>>();

	for (const slug of [...project.pages.keys()].sort(compareSlugStrings)) {
		const byLocale = project.pages.get(slug) as Map<Locale, SourceDocument>;
		const source = byLocale.get(SOURCE_LOCALE);
		const compiled = new Map<Locale, CompiledPageOutput>();
		const states = new Map<Locale, TranslationState>();
		const ordered = [SOURCE_LOCALE, ...locales.filter((locale) => locale !== SOURCE_LOCALE)];

		for (const locale of ordered) {
			const document = byLocale.get(locale);
			if (document === undefined) continue;

			const origins: NodeOrigins = new WeakMap();
			const includedStates: TranslationState[] = [];
			const services = pageServices({
				file: document.file,
				locale,
				project,
				targets,
				origins,
				config,
				onInclude: (id) => {
					const state = snippetStates.get(id)?.get(locale);
					if (state !== undefined) includedStates.push(state);
				},
			});

			const sourceOutput = compiled.get(SOURCE_LOCALE);
			const output = compilePage({
				config,
				slug,
				locale,
				document,
				services,
				origins,
				translation: { state: 'current', sourceUpdated: '' },
				...(sourceOutput === undefined
					? {}
					: { sourceHeadingIds: sourceOutput.headings.map((heading) => heading.id) }),
				snippetBodies: snippetBodies(project, locale),
			});

			// The state is finalised after the compile, because it depends on two things the
			// parse produces: the `translated: false` flag in front matter, and what the page
			// turned out to include. `translation.state` is the effective state, the worst of
			// the page and everything it transcludes, which is what the reader's notice has to
			// show; the manifest keeps the page's own state, which is what a translator needs.
			const own = stateOf(
				locale,
				document,
				source,
				dateOf,
				output.parsed.frontMatter.data,
				sourceOutput === undefined ? undefined : isSourceText(sourceOutput, output),
			);
			states.set(locale, own);
			const effective = includedStates.reduce(worst, own);
			// The head commit's own date, never an empty string. `utcTimestampSchema` requires
			// a timestamp, so an empty one compiled to a payload and a manifest record the
			// bundle's own schemas reject, and the failure surfaced downstream as a digest
			// mismatch naming nothing. The commit date is the defensible substitute: the
			// bundle is addressed by that commit, and a file present in its tree with no
			// entry in the git walk is a contradiction rather than a page with a real older
			// date. Dropping the page instead was the other option and it is worse: an author
			// who has not committed a new page yet would watch it vanish from a local build.
			// The finding is what makes either outcome visible.
			const sourceDate = source === undefined ? undefined : dateOf(source);
			if (source !== undefined && sourceDate === undefined) {
				findings.push(
					raw(
						'bundle-file-undated',
						{ kind: 'file', file: source.file },
						null,
						`git has no committer date for ${source.repoPath}, so its freshness cannot be compared.`,
						{
							remediation:
								'Commit the file. Staleness is a comparison of committer dates, so a file with no history reads as current against everything and nothing says otherwise.',
						},
					),
				);
			}
			const sourceUpdated = sourceDate ?? commitTimestamp;
			const updated = dateOf(document);
			output.page.translation = {
				state: effective,
				sourceUpdated,
				...(locale === SOURCE_LOCALE || updated === undefined
					? {}
					: { translationUpdated: updated }),
			} satisfies TranslationRecord;

			compiled.set(locale, output);
			findings.push(...output.findings);
			findings.push(
				...pageFindings({
					config,
					page: output.page,
					parsed: output.parsed,
					file: document.file,
					locale,
				}),
			);
			findings.push(...proseFindings(output, locale, project, drafts.has(slug)));
		}

		pages.set(slug, compiled);
		pageStates.set(slug, states);
	}

	// ---- snippets, linted once each -------------------------------------------
	const snippetDisables: DisableComment[] = [];
	const snippetSpans: BlockSpan[] = [];
	for (const byLocale of project.snippets.values()) {
		for (const [locale, document] of byLocale) {
			const origins: NodeOrigins = new WeakMap();
			const parsed = parseDocument(document.text, {
				file: document.file,
				config,
				origins,
				includeDepth: 1,
				services: pageServices({
					file: `content/${locale}/_snippet.md`,
					locale,
					project,
					targets,
					origins,
					config,
					onInclude: () => undefined,
				}),
			});
			findings.push(...parsed.problems);
			snippetDisables.push(...parsed.disables);
			snippetSpans.push(...proseSpans(parsed.prose));
			for (const rule of Object.values(PROSE_RULES)) {
				findings.push(
					...rule(parsed.prose, {
						file: document.file,
						locale,
						sourceLocale: SOURCE_LOCALE,
						project: config,
						denyList: project.denyList,
						sourceLines: sourceLines(document.text),
						pageKind: 'article',
						isDraft: false,
					}),
				);
			}
		}
	}

	findings.push(...projectFindings({ project, pages, pageStates, snippetStates, drafts }));

	// ---- the objects ----------------------------------------------------------
	const objects: WrittenObject[] = [];
	const pageRecords: Record<string, PageRecord> = {};

	for (const slug of [...published].sort()) {
		const compiled = pages.get(slug);
		const source = compiled?.get(SOURCE_LOCALE);
		if (compiled === undefined || source === undefined) continue;

		const record: PageRecord = {
			audience: source.page.audience,
			since: source.page.since ?? null,
			locales: {},
		};

		for (const locale of locales) {
			const output = compiled.get(locale);
			if (output === undefined) continue;

			const json = canonicalJson(output.page);
			const rawBytes = utf8Bytes(output.raw);
			objects.push({ key: pageKey(locale, slug), bytes: gzipMember(utf8Bytes(json)) });
			objects.push({ key: rawKey(locale, slug), bytes: gzipMember(rawBytes) });

			if (Buffer.byteLength(json) > config.budgets.pageBytesMax) {
				findings.push(
					raw(
						'page-size',
						{ kind: 'file', file: output.page.sourceFile },
						locale,
						`The compiled page is ${Buffer.byteLength(json)} bytes and the budget is ${config.budgets.pageBytesMax}.`,
						{
							remediation:
								'Split the page. The bundle is consumed by the server build, so an unbounded page is a build that times out on a self-hosted box at deploy time.',
						},
					),
				);
			}

			const localeRecord: PageLocaleRecord = {
				digest: sha256Hex(json),
				bytes: Buffer.byteLength(json),
				rawDigest: sha256Hex(rawBytes),
				rawBytes: rawBytes.length,
				title: output.page.title.normalize('NFC'),
				...(output.page.navTitle === undefined
					? {}
					: { navTitle: output.page.navTitle.normalize('NFC') }),
				description: output.page.description.normalize('NFC'),
				updatedAt:
					output.page.translation.translationUpdated ?? output.page.translation.sourceUpdated,
				state: pageStates.get(slug)?.get(locale) ?? 'current',
				words: output.page.reading.words,
				headings: output.headings,
			};
			record.locales[locale] = localeRecord;
		}

		pageRecords[slug] = record;
	}

	for (const asset of assetRecords) {
		const source = assetBytes.get(asset.sha256);
		if (source === undefined) continue;
		objects.push({ key: assetKey(asset.sha256, asset.ext), bytes: Buffer.from(source) });
	}

	const search: Partial<Record<Locale, SearchIndexRecord>> = {};
	const llms: Partial<Record<Locale, { digest: string; bytes: number }>> = {};
	const navOrder = navDocs(project.nav)
		.map((entry) => entry.slug)
		.filter((slug) => slug in pageRecords);

	for (const locale of locales) {
		// Every page, in every locale, including the ones with no translation. The site
		// serves the source locale for those with a notice and noindex, so a reader has to
		// be able to find them; they are marked `fallback` here and land in the index as
		// `missing`, which is what that state is for.
		const indexable: IndexablePage[] = [];
		// Over `pageRecords` rather than over `published`, which is the same list minus the
		// slugs that got no record because they have no source-locale file. Indexing those
		// put a result row in a translation's index for a page the bundle carries no payload
		// for: the row rendered, the reader clicked it, and `prefetch` had downloaded
		// nothing to render. Every other consumer of a slug already filters on
		// `pageRecords`, and the manifest's own invariant says every slug that appears
		// anywhere must name a page the bundle has; search was the one place that invariant
		// was stated and not enforced, because it cannot see inside a gzipped index.
		for (const slug of Object.keys(pageRecords).sort(compareSlugStrings)) {
			const compiled = pages.get(slug);
			const own = compiled?.get(locale);
			if (own !== undefined) {
				indexable.push({ page: own.page, state: own.page.translation.state });
				continue;
			}
			const fallback = compiled?.get(SOURCE_LOCALE);
			if (fallback !== undefined) indexable.push({ page: fallback.page, state: 'fallback' });
		}

		const index = buildSearchIndex({ locale, commit, pages: indexable });
		const json = canonicalJson(index);
		objects.push({ key: searchKey(locale), bytes: gzipMember(utf8Bytes(json)) });
		search[locale] = {
			digest: sha256Hex(json),
			bytes: Buffer.byteLength(json),
			records: index.n,
			terms: index.terms === '' ? 0 : index.terms.split('\n').length,
		};

		const text = llmsText(locale, project, pages, navOrder);
		const bytes = utf8Bytes(text);
		objects.push({ key: llmsKey(locale), bytes });
		llms[locale] = { digest: sha256Hex(bytes), bytes: bytes.length };
	}

	objects.sort((a, b) => (a.key < b.key ? -1 : 1));

	const objectRecords: ObjectRecord[] = objects.map((object) => ({
		key: object.key,
		digest: sha256Hex(object.bytes),
		bytes: object.bytes.length,
	}));

	const coverage: Partial<Record<Locale, LocaleCoverage>> = {};
	for (const locale of locales) {
		const records = Object.values(pageRecords)
			.map((record) => record.locales[locale])
			.filter((record): record is PageLocaleRecord => record !== undefined);
		coverage[locale] = {
			pages: records.length,
			translated: records.filter((r) => r.state === 'source' || r.state === 'current').length,
			stale: records.filter((r) => r.state === 'stale').length,
			scaffolded: records.filter((r) => r.state === 'scaffolded').length,
		};
	}

	const manifest: BundleManifest = {
		manifest: MANIFEST_VERSION,
		ast: AST_VERSION,
		project: config.project,
		commit,
		commitTimestamp,
		generator: options.generator,
		locales,
		sourceLocale: config.i18n.sourceLocale,
		pages: sortedRecord(pageRecords),
		nav: manifestNav(project.nav.items, pageRecords),
		redirects: sortedRecord(
			Object.fromEntries(
				[...redirects].filter(([from, to]) => to in pageRecords && !(from in pageRecords)),
			),
		),
		assets: assetRecords,
		search,
		llms,
		llmsOrder: navOrder,
		objects: objectRecords,
		counts: {
			pages: Object.keys(pageRecords).length,
			locales: locales.length,
			objects: objectRecords.length,
			bytes: objectRecords.reduce((total, object) => total + object.bytes, 0),
		},
		coverage,
	};

	const lint = runLint(findings, {
		config,
		disables: [...allDisables(pages), ...snippetDisables],
		spans: [
			...[...pages.values()].flatMap((byLocale) =>
				[...byLocale.values()].flatMap((output) => proseSpans(output.parsed.prose)),
			),
			...snippetSpans,
		],
		kitVersion: options.generator,
		...(config.i18n.parity === 'required'
			? { overrides: { 'translation-missing': 'error' as const } }
			: {}),
	});

	return {
		manifest,
		objects,
		lint,
		project,
		pages,
		manifestProblems: validateManifestShape(manifest),
	};
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stateOf(
	locale: Locale,
	document: SourceDocument,
	source: SourceDocument | undefined,
	dateOf: (document: SourceDocument) => string | undefined,
	front: Record<string, unknown> = {},
	isSourceText = false,
): TranslationState {
	if (locale === SOURCE_LOCALE) return 'source';
	// Two independent things set this state, and either alone is enough. The scaffolder
	// writes `translated: false`, and the text itself says so when somebody removed the
	// flag without translating the page. Timestamps can see neither: a scaffolded file is
	// committed after the source it copies, so its dates read current forever.
	if (front.translated === false || isSourceText) return 'scaffolded';
	if (source === undefined) return 'current';
	const sourceDate = dateOf(source);
	const own = dateOf(document);
	if (sourceDate === undefined || own === undefined) return 'current';
	return own < sourceDate ? 'stale' : 'current';
}

/**
 * Whether a translation is still the source text.
 *
 * Compared on the flattened body rather than on the file, so front matter a translator
 * did fill in does not hide a body they did not. Exact equality only: the near-miss case
 * is what `translation-is-source-text` reports, and promoting a 92 per cent match to a
 * state would put a page nobody can point at into the coverage table.
 */
function isSourceText(source: CompiledPageOutput, output: CompiledPageOutput): boolean {
	const left = blockText(source.page.body).trim();
	return left !== '' && left === blockText(output.page.body).trim();
}

/** A file split into the lines the deny scan reads, numbered from one as an editor does. */
function sourceLines(text: string): { text: string; line: number }[] {
	return text.split(/\r?\n/).map((line, index) => ({ text: line, line: index + 1 }));
}

/** Keys in code point order, which is the order the manifest's own contract states. */
function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
	const sorted: Record<string, T> = {};
	for (const key of Object.keys(record).sort()) sorted[key] = record[key] as T;
	return sorted;
}

function manifestNav(
	items: readonly NavItem[],
	pages: Record<string, PageRecord>,
): ManifestNavNode[] {
	const nodes: ManifestNavNode[] = [];
	for (const item of items) {
		if (isNavGroup(item)) {
			const children = manifestNav(item.items, pages);
			// A group is not a page and has no slug of its own, so it is flattened rather
			// than represented. The manifest's nav exists to answer "what order are the
			// pages in"; the labels a group carries are in nav.json, which the site reads.
			nodes.push(...children);
			continue;
		}
		if ('doc' in item && item.doc in pages) {
			// The reason a page is hidden stays in nav.json; the flag is what the renderer
			// needs to keep it out of the sidebar and out of prev/next, which is what
			// `nav.ts` promises a hidden page gets. The page stays in this array so that
			// `nav` and `llmsOrder` continue to answer the same question.
			nodes.push(item.hidden === undefined ? { slug: item.doc } : { slug: item.doc, hidden: true });
		}
	}
	return nodes;
}

function allDisables(pages: Map<string, Map<Locale, CompiledPageOutput>>) {
	return [...pages.values()].flatMap((byLocale) =>
		[...byLocale.values()].flatMap((output) => output.parsed.disables),
	);
}

/**
 * The source line span of every prose segment, so a suppression can cover its block.
 *
 * Derived from the runs the folding already keeps, which is the only place the extent of
 * a hard-wrapped paragraph is recorded. Without these a suppression matched only the
 * literal next line, and a house-style finding on a paragraph wrapped at 75 columns is
 * usually on a continuation line, so a comment written above the paragraph suppressed
 * nothing and the only placement that worked changed the published page.
 */
function proseSpans(segments: readonly ProseSegment[]): BlockSpan[] {
	const spans: BlockSpan[] = [];
	for (const segment of segments) {
		const lines = segment.folded.runs.map((run) => run.line);
		if (lines.length === 0) continue;
		spans.push({ file: segment.file, from: Math.min(...lines), to: Math.max(...lines) });
	}
	return spans;
}

/**
 * One snippet's body, with the front matter and the authoring comments removed.
 *
 * The comments matter here and not only in `rawMarkdown`. That function strips them from
 * a page's own body and then splices this text in verbatim for each `::include`, so a
 * suppression comment written in a snippet reached the published `<slug>.md` and the
 * `llms-full.txt` of every page including it, while never appearing in a page payload.
 * `lint.ts` states as a property that no suppression ever reaches a bundle and the corpus
 * has only ever carried one, in a page, so the include path was the untested half of it.
 *
 * A comment becomes a blank line rather than disappearing, matching `stripComments`, so a
 * paragraph is not silently joined to the one below it.
 */
function snippetBody(document: SourceDocument): string {
	return readFrontMatter(document.text, document.file)
		.body.split('\n')
		.map((line) => (WHOLE_LINE_COMMENT.test(line) ? '' : line))
		.join('\n')
		.trim();
}

/** The one comment shape this toolchain accepts, and the one `rawMarkdown` strips. */
const WHOLE_LINE_COMMENT = /^\s*<!--[\s\S]*-->\s*$/;

function snippetBodies(project: LoadedProject, locale: Locale): Map<string, string> {
	const bodies = new Map<string, string>();
	for (const [id, byLocale] of project.snippets) {
		// This locale only, with no fallback to the source. `resolveInclude` refuses the
		// same fallback and its remediation says why: it would inject English into a
		// translated page while the page still read `current`, which is the failure the
		// per-locale snippet tree exists to prevent. The raw markdown used to do exactly
		// what the AST half refuses, so one address published a Japanese page and an
		// English fragment inside it. An absent snippet leaves the `::include` line
		// literal, which matches what the resolver does and what `snippet-resolves`
		// already reports.
		const document = byLocale.get(locale);
		if (document === undefined) continue;
		bodies.set(id, snippetBody(document));
	}
	return bodies;
}

/** Services for a parse whose problems are wanted but whose links are not resolved. */
function nullServices(): ParseServices {
	return {
		resolveLink: () => ({ ok: false, message: '', remediation: null }),
		resolveInclude: () => ({ ok: true, blocks: [] }),
		resolveImage: () => ({ ok: false, message: '', remediation: null }),
		highlight: () => ({ lines: [], highlighted: false }),
	};
}

interface PageServiceOptions {
	file: string;
	locale: Locale;
	project: LoadedProject;
	targets: LinkTargets;
	origins: NodeOrigins;
	config: LoadedProject['config'];
	onInclude: (id: string) => void;
}

function pageServices(options: PageServiceOptions): ParseServices {
	return {
		resolveLink: createLinkResolver(options.file, options.targets),
		resolveImage: createImageResolver(options.file, options.targets),
		highlight,
		resolveInclude: (id) => {
			const document = options.project.snippets.get(id)?.get(options.locale);
			if (document === undefined) {
				const elsewhere = options.project.snippets.has(id);
				return {
					ok: false,
					message: elsewhere
						? `The snippet "${id}" has no ${options.locale} translation.`
						: `There is no snippet "${id}".`,
					remediation: elsewhere
						? `Write snippets/${options.locale}/${id}.md. Falling back to the source language would inject it into a translated page while the page still read current, which is the failure the per-locale tree exists to prevent.`
						: `Create snippets/${options.locale}/${id}.md, or fix the id.`,
				};
			}
			options.onInclude(id);
			// Parsed fresh for every page that includes it, and its own prose and problems
			// are dropped here. The snippet is linted once, as a file of its own, so a banned
			// phrase in a fragment is reported once rather than once per including page.
			const parsed = parseDocument(document.text, {
				file: document.file,
				config: options.config,
				origins: options.origins,
				includeDepth: 1,
				services: {
					...pageServices({ ...options, file: `content/${options.locale}/_snippet.md` }),
					resolveInclude: () => ({
						ok: false,
						message: 'A snippet cannot include another snippet.',
						remediation: 'Inline the fragment.',
					}),
				},
			});
			return { ok: true, blocks: parsed.blocks };
		},
	};
}

function proseFindings(
	output: CompiledPageOutput,
	locale: Locale,
	project: LoadedProject,
	isDraft: boolean,
): RawFinding[] {
	const context = {
		file: output.page.sourceFile,
		locale,
		sourceLocale: SOURCE_LOCALE,
		project: project.config,
		denyList: project.denyList,
		// The whole file, front matter included. The deny rules are the only readers, and
		// what they are looking for is as likely to be in a fence, a link target or a
		// description as in a sentence.
		sourceLines: sourceLines(output.parsed.source),
		pageKind: output.page.pageKind,
		isDraft,
	};
	return Object.values(PROSE_RULES).flatMap((rule) => rule(output.parsed.prose, context));
}

/**
 * `llms.txt` for one locale.
 *
 * Nav reading order, one line per page, with the title and the description each locale
 * wrote for itself. A page with no translation is listed with the source locale's text,
 * because an agent asking what a documentation set contains wants the whole list rather
 * than the subset somebody has translated so far.
 */
function llmsText(
	locale: Locale,
	project: LoadedProject,
	pages: Map<string, Map<Locale, CompiledPageOutput>>,
	order: readonly string[],
): string {
	const home = pages.get('index')?.get(locale) ?? pages.get('index')?.get(SOURCE_LOCALE);
	const lines = [`# ${project.config.productName}`, ''];
	if (home !== undefined) lines.push(`> ${home.page.description}`, '');
	lines.push('## Documentation', '');

	for (const slug of order) {
		const output = pages.get(slug)?.get(locale) ?? pages.get(slug)?.get(SOURCE_LOCALE);
		if (output === undefined) continue;
		lines.push(`- [${output.page.title}](${slug}.md): ${output.page.description}`);
	}
	lines.push('');
	return lines.join('\n');
}

/** Words in a compiled page, exported so a test can compare against the manifest. */
export { countWords };
