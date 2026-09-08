/**
 * `hexdocs scaffold` / `docs_scaffold`: the files a repository needs, as content rather
 * than as a write.
 *
 * **It writes nothing.** It returns file contents and the agent applies them with Write
 * or Edit, so every change is visible in the transcript and in git. That is the boundary
 * hex-terraform draws, and it is the reason the MCP server needs no write audit, no
 * path-safety story and no undo: `Command`'s union refuses to give a writing command a
 * tool name at all, and this one has a tool name because there is nothing to audit.
 *
 * **Nothing here can overwrite.** Every `create` entry whose target already exists is
 * dropped, and a note names the path. That is the structural answer to the semantic
 * contradiction the design pass this replaces contained in its own skills, where one skill
 * used a create command to scaffold translations onto pages that already existed: a tool
 * that cannot do the wrong thing makes a skill that misdescribes it harmless. The rule is
 * uniform across all four kinds rather than special to `page`, because "this one command
 * cannot clobber and the others can" is a distinction nobody remembers under pressure.
 *
 * The refusals are not silent. A dropped file, a `sync-public.sh` this code will not edit,
 * a config left deliberately incomplete: each is a line in `notes`, which the CLI prints
 * and the tool returns.
 *
 * The table of files a source tree starts with lives in `templates/source.ts` and is
 * shared with `hexdocs init`, which writes them. Two lists of what a project starts with
 * would be two ideas of what a project is.
 */

import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notRunRow } from '../../../src/contracts/diagnostics.js';
import { LOCALES, SOURCE_LOCALE, matchLocale } from '../../../src/contracts/locales.js';
import type { Locale } from '../../../src/contracts/locales.js';
import {
	PROJECT_ID_PATTERN,
	REPO_PATTERN,
	SITE_ROOT_RELATIVE,
} from '../../../src/contracts/project.js';
import { parseSlug } from '../../../src/contracts/slug.js';
import { readFrontMatter } from '../compile/frontmatter.js';
import { defineCommand } from '../registry/command.js';
import type { CommandOutput } from '../registry/command.js';
import type { Param } from '../registry/params.js';
import {
	MIRROR_SCRIPT_RELATIVE,
	allowPathsRefusals,
	parseAllowPaths,
} from '../source/allow-paths.js';
import {
	DEFAULT_KIT_MOUNT,
	schemaRefFor,
	siteConfig,
	sourceScaffold,
	type ScaffoldedFile,
} from '../templates/source.js';
import {
	PLACEHOLDER_DESCRIPTION,
	headingsOf,
	includeIdsOf,
	sourcePage,
	translationStub,
	type Emitted,
	type FrontMatterEntry,
	type StubHeading,
} from '../templates/page.js';
import {
	BUCKET_VARIABLE,
	PUBLISH_WORKFLOW_PATH,
	ROLE_VARIABLE,
	publishWorkflow,
} from '../templates/workflow.js';

import { LOCALE_MANY, REGION, ROOT, SITE, rootOf } from './common.js';

const SCAFFOLD_KINDS = ['page', 'source', 'site', 'workflow'] as const;

type ScaffoldKind = (typeof SCAFFOLD_KINDS)[number];

/**
 * `site` again, without `required`.
 *
 * The help text is `SITE`'s own, so two surfaces cannot describe the flag differently,
 * which is the whole reason `common.ts` exists. Only the requiredness changes, and it has
 * to: `required` is a property of a parameter, and `--site` is needed by one of this
 * command's four kinds. The conditional requirement is checked in the handler and reported
 * as a `not-run` row, because "you asked for a site config and did not say which site"
 * deserves a sentence rather than a schema error.
 */
const SITE_OPTIONAL: Param = { help: SITE.help, type: 'string' };

/** The directory the generated workflow builds into. A CI-only artefact. */
const BUNDLE_OUT = '.hexdocs-bundle';

/**
 * Where this file sits inside the mounted toolchain, resolved at import time.
 *
 * `kit/src/commands/scaffold.ts` is three levels below the repository root, so this is the
 * root of hex-docs wherever it happens to be mounted. It is read to work out what a
 * `$schema` reference and a workflow's path to `bin/hexdocs` should say, which is the
 * difference between a scaffolded config that gives an editor completion and one whose
 * first line is wrong in a way nobody notices until they need it.
 */
const HEX_DOCS_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface KitMount {
	/** Relative to the repository root, forward slashes, no trailing slash. */
	readonly path: string;
	/** False when it was assumed rather than measured, which is a note. */
	readonly measured: boolean;
}

/**
 * Where the toolchain is, as the scaffolded repository would spell it.
 *
 * Measured from this module's own location, so a submodule mounted at `kcalc-web/docs`
 * produces `$schema` paths and a workflow that work there without being told. It falls
 * back when the toolchain is not underneath the root at all, which is what happens when
 * somebody runs the CLI out of a hex-docs checkout against a repository somewhere else: a
 * relative path climbing out of the repository would be worse than the documented default,
 * because it would be silently wrong on the machine that later reads the file.
 */
function kitMountOf(root: string): KitMount {
	const measured = relative(root, HEX_DOCS_ROOT).split(sep).join('/').replace(/\/+$/, '');
	if (measured === '' || measured.startsWith('..') || measured.startsWith('/')) {
		return { path: DEFAULT_KIT_MOUNT, measured: false };
	}
	return { path: measured, measured: true };
}

type ScaffoldData = {
	kind: ScaffoldKind;
	root: string;
	files: ScaffoldedFile[];
	notes: string[];
};

/** A collector, so every kind reports a dropped file the same way. */
class Plan {
	readonly files: ScaffoldedFile[] = [];
	readonly notes: string[] = [];

	constructor(private readonly root: string) {}

	/**
	 * A file to create, unless something is already there.
	 *
	 * The existence check is a read, not a write, so it is available under MCP where
	 * `Ctx.write` is null. Reading is all this command does; there is no path through it
	 * that opens a file for writing.
	 */
	create(path: string, contents: Emitted | string, why: string): void {
		if (existsSync(resolve(this.root, path))) {
			this.notes.push(
				`${path} already exists, so nothing was returned for it. This command never ` +
					'overwrites. Read the file and edit it if it needs to change.',
			);
			return;
		}
		if (typeof contents !== 'string' && !contents.ok) {
			this.notes.push(`${path} could not be built. ${contents.why}`);
			return;
		}
		this.files.push({
			path,
			action: 'create',
			contents: typeof contents === 'string' ? contents : contents.contents,
			anchor: null,
			why,
		});
	}

	patch(file: ScaffoldedFile): void {
		this.files.push(file);
	}

	note(line: string): void {
		this.notes.push(line);
	}

	read(path: string): string | null {
		const absolute = resolve(this.root, path);
		if (!existsSync(absolute)) return null;
		try {
			return readFileSync(absolute, 'utf8');
		} catch {
			return null;
		}
	}
}

/** The output shape every kind returns, so `data` is built in exactly one place. */
function done(kind: ScaffoldKind, root: string, plan: Plan): CommandOutput {
	const data: ScaffoldData = { kind, root, files: plan.files, notes: plan.notes };
	const lines = [
		`${plan.files.length} file(s) to apply, ${plan.notes.length} note(s). Nothing was written.`,
		...plan.files.map(
			(file) =>
				`  ${file.action === 'patch' ? 'patch ' : 'create'}  ${file.path}` +
				(file.anchor === null ? '' : `  after: ${file.anchor.trim()}`),
		),
		...plan.notes.map((note) => `  note    ${note}`),
	];
	return { data, lines, envelope: null, rows: [] };
}

/** A refusal: nothing examined, nothing produced, and a sentence saying which. */
function refuse(kind: ScaffoldKind, root: string, why: string): CommandOutput {
	const data: ScaffoldData = { kind, root, files: [], notes: [why] };
	return {
		data,
		lines: [],
		envelope: null,
		// A `not-run` row rather than a clean exit with an empty file list. An empty list is
		// what a successful scaffold of an already-scaffolded repository looks like, so
		// returning one here would make "you did not tell me the project id" and "there was
		// nothing to do" the same answer to an agent reading the JSON.
		rows: [notRunRow('scaffold', 'scaffold kinds', why)],
	};
}

/**
 * `--locale` as the array it really is.
 *
 * `common.ts` annotates `LOCALE_MANY` as `Param`, which erases `many: true` from the type,
 * so `Input<P>` says `string | undefined` for a value both front doors deliver as an
 * array: `optionsFor` and `shapeOf` read `many` off the object at runtime rather than off
 * the type. This normalises instead of casting, because a cast to `string[]` would be a
 * lie in one direction and `new Set(input.locale)` over a bare string is a set of its
 * characters, which is the failure that would follow.
 */
function requestedLocales(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === 'string');
	}
	return typeof value === 'string' ? [value] : [];
}

/** Requested locales, deduplicated and in `LOCALES` order so a re-run returns one answer. */
function localesOf(requested: readonly string[], fallback: readonly Locale[]): Locale[] {
	if (requested.length === 0) return [...fallback];
	const wanted = new Set(requested);
	return LOCALES.filter((locale) => wanted.has(locale));
}

/**
 * A page title from its slug, for the case where nobody passed one.
 *
 * `guide/first-tag` becomes `First tag` and `guide/index` becomes `Guide`, because the
 * meaningful segment of a section root is the section. It is a starting point and never a
 * translation: the title is the one field an author is certain to rewrite.
 */
function titleFromSlug(slug: string): string | null {
	const parsed = parseSlug(slug);
	if (!parsed.ok) return null;
	const segment =
		parsed.slug.kind === 'page'
			? parsed.slug.name
			: parsed.slug.section[parsed.slug.section.length - 1];
	if (segment === undefined) return null;
	const words = segment.split('-').join(' ');
	return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

/** The front matter fields and structure a stub copies from the page it translates. */
interface SourceFacts {
	front: FrontMatterEntry[];
	headings: StubHeading[];
	includes: string[];
}

/**
 * Keys a stub does not inherit, each because the contract says where the fact lives.
 *
 * `draft` is read from the source locale's file only, because a missing translation has no
 * front matter to agree with. `translated` is what the stub itself sets, and copying a
 * source page's own value would be copying a key the source should not have had.
 */
const NOT_INHERITED = new Set(['draft', 'translated']);

/**
 * What a translation stub needs from the page it is a translation of.
 *
 * The front matter is read with `readFrontMatter`, the compiler's own reader, rather than
 * with a second one written here. Two readers of a deliberately narrow YAML subset is the
 * failure `kit/src/compile/frontmatter.ts` opens by naming: they agree on every file
 * anybody tests and disagree on the one that matters. A value that reader refuses is
 * simply absent from `data`, which lands as the "no readable source page" branch below,
 * rather than as a stub built on a value the compiler will not accept.
 *
 * `title` and `description` are required here rather than left to the schema, because a
 * source page missing either is a page the stub would inherit the hole from, and the
 * schema error would then name the translation instead of the file that is actually wrong.
 *
 * A value of any other shape than the three the reader produces is dropped rather than
 * guessed at. It should be unreachable, and it is a key silently absent from the stub if
 * it ever is not, which is why the count is reported to the caller.
 */
function sourceFactsOf(text: string, file: string): SourceFacts | null {
	const block = readFrontMatter(text, file);
	if (typeof block.data['title'] !== 'string' || typeof block.data['description'] !== 'string') {
		return null;
	}

	const front: FrontMatterEntry[] = [];
	for (const [key, value] of Object.entries(block.data)) {
		if (NOT_INHERITED.has(key)) continue;
		if (typeof value === 'string' || typeof value === 'boolean') {
			front.push({ key, value });
			continue;
		}
		if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
			front.push({ key, value });
		}
	}

	return { front, headings: headingsOf(block.body), includes: includeIdsOf(block.body) };
}

// ---------------------------------------------------------------------------
// the four kinds
// ---------------------------------------------------------------------------

interface KindInput {
	root: string;
	mount: KitMount;
	slug: string | undefined;
	locales: readonly string[];
	project: string | undefined;
	site: string | undefined;
	title: string | undefined;
	productName: string | undefined;
	repo: string | undefined;
}

function mountNote(input: KindInput, what: string): string {
	return `The toolchain is not underneath ${input.root}, so ${what} assumes it is mounted at ${DEFAULT_KIT_MOUNT}/. Change it if it is somewhere else.`;
}

/**
 * The mirror-script patch, kept or dropped against what is actually on disk.
 *
 * `sourceScaffold` emits it unconditionally, because it is a pure builder and `init` needs
 * it in every plan. Here there is a repository to look at, so the four answers are worth
 * telling apart: no mirror script at all, an allowlist this code will not touch, an entry
 * that is already there, and the ordinary case. The refusals come from
 * `source/allow-paths.ts`, which is the one parser of that file; a second reader here
 * would be a second opinion about what the array says, and the array is the whole decision
 * about what leaves a private repository.
 */
function applyMirrorPatch(plan: Plan, patch: ScaffoldedFile): void {
	const text = plan.read(MIRROR_SCRIPT_RELATIVE);
	if (text === null) {
		plan.note(
			`There is no ${MIRROR_SCRIPT_RELATIVE} here, so this repository has no public mirror and nothing to allowlist. The patch is not included.`,
		);
		return;
	}

	const refusals = allowPathsRefusals(text);
	if (refusals.length > 0) {
		for (const refusal of refusals) {
			plan.note(
				`${MIRROR_SCRIPT_RELATIVE}${refusal.line === null ? '' : `:${refusal.line}`} (${refusal.id}): ${refusal.why}`,
			);
		}
		plan.note(
			`The allowlist entry is not included. Fix the array first: it is the only thing deciding what leaves this repository, and adding a line to one that is already wrong would endorse it.`,
		);
		return;
	}

	const block = parseAllowPaths(text);
	const present = block?.entries.some((entry) => entry.normalised === SITE_ROOT_RELATIVE) === true;
	if (present) {
		plan.note(
			`${MIRROR_SCRIPT_RELATIVE} already carries ${JSON.stringify(SITE_ROOT_RELATIVE)}. Nothing to add.`,
		);
		return;
	}

	// The anchor is the one the array actually has, including its own indent, so an
	// allowlist formatted unlike hex-nfc's still gets the line in the right place. Falling
	// back to the last entry keeps the insertion inside the array in a repository whose
	// mirror script has no `docs/public` entry at all, which is every one except hex-nfc.
	const anchor =
		block?.entries.find((entry) => entry.normalised === 'docs/public') ??
		block?.entries[block.entries.length - 1];
	if (anchor === undefined) {
		plan.note(
			`${MIRROR_SCRIPT_RELATIVE} has an allowlist this code could not read an entry out of, so it names no anchor to insert after. The patch is not included.`,
		);
		return;
	}

	plan.patch({
		...patch,
		contents: `${anchor.indent}"${SITE_ROOT_RELATIVE}"`,
		anchor: anchor.text,
	});
	if (anchor.normalised !== 'docs/public') {
		plan.note(
			`${MIRROR_SCRIPT_RELATIVE} has no "docs/public" entry, so the new line goes after the last entry in the array rather than into the documentation group.`,
		);
	}
}

function scaffoldSource(input: KindInput): CommandOutput {
	const missing: string[] = [];
	if (input.project === undefined) missing.push('--project');
	if (input.productName === undefined) missing.push('--product-name');
	if (input.repo === undefined) missing.push('--repo');
	if (missing.length > 0) {
		return refuse(
			'source',
			input.root,
			`scaffold source needs ${missing.join(', ')}. The project id is an S3 key prefix and a URL segment, the product name is the one project-level string the interface reads, and the repo is where "edit this page" points. None of the three has a default worth guessing.`,
		);
	}
	const project = input.project as string;
	const productName = input.productName as string;
	const repo = input.repo as string;

	if (!PROJECT_ID_PATTERN.test(project)) {
		return refuse(
			'source',
			input.root,
			`"${project}" is not a project id. It is an S3 key prefix and a URL segment, so it is lower case ASCII words joined by single hyphens: "hex-nfc".`,
		);
	}
	if (!REPO_PATTERN.test(repo)) {
		return refuse('source', input.root, `"${repo}" is not a repository. Write it as owner/name.`);
	}

	const plan = new Plan(input.root);
	if (!input.mount.measured) {
		plan.note(mountNote(input, 'every $schema path and the publish workflow'));
	}

	const scaffolded = sourceScaffold({
		project,
		productName,
		repo,
		locales: localesOf(input.locales, [SOURCE_LOCALE]),
		kitMount: input.mount.path,
	});

	for (const file of scaffolded.files) {
		if (file.action === 'patch') {
			applyMirrorPatch(plan, file);
			continue;
		}
		plan.create(file.path, file.contents, file.why);
	}
	for (const note of scaffolded.notes) plan.note(note);

	return done('source', input.root, plan);
}

function scaffoldPage(input: KindInput): CommandOutput {
	if (input.slug === undefined) {
		return refuse(
			'page',
			input.root,
			'scaffold page needs --slug. The slug is the filename and the address, and there is nothing to derive it from.',
		);
	}
	const parsed = parseSlug(input.slug);
	if (!parsed.ok) return refuse('page', input.root, parsed.message);
	const slug = input.slug;

	const plan = new Plan(input.root);
	const locales = localesOf(input.locales, [SOURCE_LOCALE]);
	const sourceFile = `${SITE_ROOT_RELATIVE}/content/${SOURCE_LOCALE}/${slug}.md`;

	// Read once, before the loop. Every stub is built from the same source page and the
	// answer cannot differ between locales, so reading per locale would be six reads of one
	// file and six chances for them to disagree if the file changed underneath.
	const sourceText = plan.read(sourceFile);
	const facts = sourceText === null ? null : sourceFactsOf(sourceText, sourceFile);

	for (const locale of locales) {
		const path = `${SITE_ROOT_RELATIVE}/content/${locale}/${slug}.md`;
		if (locale === SOURCE_LOCALE) {
			plan.create(
				path,
				sourcePage({
					title: input.title ?? titleFromSlug(slug) ?? slug,
					description: PLACEHOLDER_DESCRIPTION,
				}),
				'The page in the source language. Every translation is a translation of this file.',
			);
			continue;
		}

		if (facts === null) {
			plan.note(
				`There is no readable ${sourceFile}, so a ${locale} file would be a translation of nothing. Scaffold the source page first: a translation is a translation of one specific page, and its heading structure is held to that page's by heading-set-matches-source.`,
			);
			continue;
		}

		plan.create(
			path,
			translationStub({ front: facts.front, headings: facts.headings }),
			`The ${locale} file for a page nobody has translated yet: the source's front matter and heading structure, a TODO under each heading, and translated: false. It is never a copy of the source prose, which is what would make six locales of English read as fully translated.`,
		);
	}

	if (facts !== null && facts.includes.length > 0 && locales.some((l) => l !== SOURCE_LOCALE)) {
		plan.note(
			`${sourceFile} transcludes ${facts.includes.join(', ')}. The stubs do not carry the ::include lines, because a snippet with no file in the target locale is a snippet-resolves error and blocks the whole bundle, where the missing section is only a heading-set-matches-source warning. Write snippets/<locale>/<id>.md and put the include back when you translate the page.`,
		);
	}

	return done('page', input.root, plan);
}

function scaffoldSite(input: KindInput): CommandOutput {
	const missing: string[] = [];
	if (input.project === undefined) missing.push('--project');
	if (input.site === undefined) missing.push('--site');
	if (missing.length > 0) {
		return refuse(
			'site',
			input.root,
			`scaffold site needs ${missing.join(', ')}. The project id joins this file to docs/site/docs.json and to the S3 key prefix, and the site is which application in this repository the documentation mounts into.`,
		);
	}
	const project = input.project as string;
	const site = (input.site as string).replace(/^\.?\/+/, '').replace(/\/+$/, '');

	if (!PROJECT_ID_PATTERN.test(project)) {
		return refuse(
			'site',
			input.root,
			`"${project}" is not a project id. It is an S3 key prefix and a URL segment, so it is lower case ASCII words joined by single hyphens: "hex-nfc".`,
		);
	}

	const plan = new Plan(input.root);
	if (!input.mount.measured) plan.note(mountNote(input, 'the $schema path'));

	// `<site>/app/docs/` is where `verify-install` and `prefetch` both look for these files,
	// so the location is part of the contract rather than a convention.
	const path = `${site}/app/docs/${project}.docs.json`;

	// A project id that is also a language code produces a basePath whose first segment is
	// a locale, which the schema refuses outright: the locale prefix is added per request,
	// because English is unprefixed and the other six are not, so a basePath carrying one
	// would have to exist seven times.
	const basePath = `/${project}/docs`;
	if (matchLocale(project).ok) {
		plan.note(
			`"${project}" is also a language code, so ${basePath} starts with a locale segment and the schema refuses it. Mount the documentation somewhere else and edit basePath by hand.`,
		);
	}

	plan.create(
		path,
		siteConfig({
			project,
			basePath,
			schemaRef: schemaRefFor(path, input.mount.path, 'site-1.json'),
		}),
		'The whole docs mount, as this website sees it: the routes, LOCALISED_PATHS, the hreflang set, the sitemap and the theme class are all derived from this one file.',
	);
	plan.note(
		'versions comes back empty, so the file does not validate yet. The schema needs at least one entry and an entry needs a real 40-character commit sha, which a scaffolder cannot know; writing a plausible one would put a fabricated commit into the file the version picker reads. Run hexdocs label to produce the first entry.',
	);
	plan.note(
		'pages stays empty. hexdocs sync writes it from the bundle, and it has to be a build input because root.tsx renders the canonical link and all eight hreflang alternates above <Meta />, where a route cannot correct them.',
	);
	plan.note(
		"themeClass is omitted. Absent is a supported state and means the documentation takes this package's own palette; set it to a class the site already defines to pick up that app's accent.",
	);

	return done('site', input.root, plan);
}

function scaffoldWorkflow(input: KindInput): CommandOutput {
	const plan = new Plan(input.root);
	if (!input.mount.measured) plan.note(mountNote(input, 'the workflow'));

	plan.create(
		PUBLISH_WORKFLOW_PATH,
		publishWorkflow({
			kitMount: input.mount.path,
			// The one default declared in `common.ts`, read rather than repeated, so the flag
			// a person passes to `publish` and the region the workflow assumes cannot drift.
			region: String(REGION.fallback),
			out: BUNDLE_OUT,
		}),
		'Turns every commit on main into a bundle keyed by its sha. Labelling one of those shas is what publishes a version.',
	);
	plan.note(
		`It needs two repository variables before it can run: ${ROLE_VARIABLE} and ${BUCKET_VARIABLE}. Neither is written into the file: hex-docs is a public repository, and an app repository may have a public mirror.`,
	);
	plan.note(
		'Do not add it to a public-mirror allowlist, and do not put a helper it calls in .github/scripts/, which hex-nfc allowlists as a whole directory. Exclusion by absence is what keeps the bucket name and the role name off a mirror.',
	);

	return done('workflow', input.root, plan);
}

export const scaffold = defineCommand({
	name: 'scaffold',
	tool: 'docs_scaffold',
	writes: 'nothing',
	summary: 'Return the files a repository needs, for the agent to apply. Writes nothing.',
	detail:
		'Four kinds. `source` is a documentation tree in an application repository: the project config, the nav, a first page, the deny list, the publish workflow, and the one line a public-mirror allowlist needs. `page` is one markdown file per requested locale, where a non-source locale gets the source page heading structure and a TODO under each heading with `translated: false` in its front matter, and never a copy of the English prose. `site` is the mount config for the consuming website. `workflow` is the publish workflow on its own. Nothing is written and nothing is ever overwritten: a file that already exists is dropped and named in the notes. Apply the results with Write and Edit, and read the notes first.',
	params: {
		kind: {
			help: 'what to scaffold',
			type: 'string',
			required: true,
			values: SCAFFOLD_KINDS,
		},
		root: ROOT,
		slug: {
			help: 'the page slug, for kind=page: index, guide/first-tag',
			type: 'string',
		},
		locale: LOCALE_MANY,
		project: {
			help: 'the project id: lower case, hyphenated, the S3 key prefix and a URL segment',
			type: 'string',
		},
		site: SITE_OPTIONAL,
		title: {
			help: 'the page title, for kind=page; derived from the slug when absent',
			type: 'string',
		},
		'product-name': {
			help: 'how the product is named in prose, for kind=source',
			type: 'string',
		},
		repo: {
			help: 'owner/name, for kind=source: the "edit this page" target',
			type: 'string',
		},
	},
	positionals: ['kind'],
	taughtBy: ['docs-init-source', 'docs-authoring', 'docs-install-site'],
	async run(input, ctx) {
		const root = rootOf(ctx.cwd, input.root);
		const shared: KindInput = {
			root,
			mount: kitMountOf(root),
			slug: input.slug,
			locales: requestedLocales(input.locale),
			project: input.project,
			site: input.site,
			title: input.title,
			productName: input['product-name'],
			repo: input.repo,
		};

		switch (input.kind) {
			case 'source':
				return scaffoldSource(shared);
			case 'page':
				return scaffoldPage(shared);
			case 'site':
				return scaffoldSite(shared);
			case 'workflow':
				return scaffoldWorkflow(shared);
		}
	},
});
