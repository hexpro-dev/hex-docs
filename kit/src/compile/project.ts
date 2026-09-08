/**
 * Reading an app repository's `docs/` tree.
 *
 * Everything the compiler reads resolves against `docs/site/`, and anything that
 * escapes it is refused. The whole of that protection is a symlink refusal in the walk
 * below, and that is sufficient rather than minimal: a symlink is the only thing git
 * can carry into a checkout that points outside the tree. There is deliberately no
 * per-file `realpath` check, because it does not resolve hard links either, git cannot
 * represent one, and a comment claiming a protection that does not exist is how the
 * guard gets trusted by the next person to touch it.
 *
 * The deny list is the one file read from outside `docs/site/`, and its own contract
 * says why: it names the strings that must never ship, so keeping it inside the tree the
 * publisher reads would be the same mistake in miniature.
 */

import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { Locale } from '../../../src/contracts/locales.js';
import { matchLocale, sortLocales } from '../../../src/contracts/locales.js';
import type { NavTree } from '../../../src/contracts/nav.js';
import type { DenyList, DocsProjectConfig } from '../../../src/contracts/project.js';
import { FORBIDDEN_SOURCE_NAMES } from '../../../src/contracts/project.js';
import { parseSlug } from '../../../src/contracts/slug.js';
import { SNIPPET_ID_PATTERN } from '../../../src/contracts/source.js';
import type { ZodType } from 'zod';

import {
	denyListSchema,
	docsProjectConfigSchema,
	navTreeSchema,
} from '../contracts/config.schema.js';

import { raw, type RawFinding } from './types.js';
import { readRepository, type RepositoryState } from './git.js';

/** One markdown file in the tree. */
export interface SourceDocument {
	/** Relative to `docs/site/`, which is what a finding and the manifest both carry. */
	file: string;
	/** Relative to the repository root, which is what git answers about. */
	repoPath: string;
	locale: Locale;
	/** The slug for a page, the id for a snippet. */
	id: string;
	text: string;
}

export interface LoadedAsset {
	/** Relative to `docs/site/`, e.g. `assets/scan-screen.png`. */
	file: string;
	repoPath: string;
	bytes: Buffer;
}

export interface LoadedProject {
	appRoot: string;
	siteRoot: string;
	/** Absent when the tree is not in a git repository at all. */
	repository: RepositoryState | undefined;
	config: DocsProjectConfig;
	nav: NavTree;
	/**
	 * `null` when `docs/docs.private.json` is absent, and `null` again when it is present
	 * and does not validate.
	 *
	 * Absence is not reported here, and stating that plainly matters: a deny scan that
	 * examined nothing has cleared nothing, so whoever runs the scan is the one that owes
	 * the report. That is `no-competitor-name` and `internal-leak` in `lint/prose.ts`,
	 * each of which turns a null list into a finding naming the path it would have read. `null` rather than an empty list is what lets that caller tell "there is
	 * no list" from "the list is empty", which are the same scan and different answers.
	 */
	denyList: DenyList | null;
	/** Slug to locale to file. */
	pages: Map<string, Map<Locale, SourceDocument>>;
	/** Snippet id to locale to file. */
	snippets: Map<string, Map<Locale, SourceDocument>>;
	/** Path relative to `docs/site/` to its bytes. */
	assets: Map<string, LoadedAsset>;
	findings: RawFinding[];
	/** Files the walk actually read, so a run that examined nothing can fail. */
	examined: number;
}

/**
 * A state in which there is no project to compile.
 *
 * Thrown rather than reported, because every finding downstream would be a consequence
 * of this one and a report listing four hundred of them buries the sentence that
 * matters.
 */
export class ProjectError extends Error {
	readonly finding: RawFinding;

	constructor(finding: RawFinding) {
		super(finding.message);
		this.name = 'ProjectError';
		this.finding = finding;
	}
}

/** A Zod issue path to an RFC 6901 pointer, so a finding can point inside the file. */
function pointerOf(path: readonly (string | number | symbol)[]): string {
	if (path.length === 0) return '';
	return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

function readJson(path: string, file: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		throw new ProjectError(
			raw('front-matter-invalid', { kind: 'file', file }, null, `${file} is missing.`, {
				remediation: 'Run hexdocs init in the app repository, or restore the file from git.',
			}),
		);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new ProjectError(
			raw(
				'front-matter-invalid',
				{ kind: 'file', file },
				null,
				`${file} is not valid JSON: ${(error as Error).message}`,
				{ remediation: 'Fix the syntax. Nothing downstream can read the project without it.' },
			),
		);
	}
}

function parseConfig<T>(
	schema: ZodType<T>,
	value: unknown,
	file: string,
	fatal: boolean,
	findings: RawFinding[],
): T | undefined {
	const result = schema.safeParse(value);
	if (result.success) return result.data;

	const reported = result.error.issues.map((issue) =>
		raw(
			'front-matter-invalid',
			{ kind: 'pointer', file, pointer: pointerOf(issue.path) },
			null,
			issue.message,
			{
				remediation: `Fix ${file}${pointerOf(issue.path) === '' ? '' : ` at ${pointerOf(issue.path)}`}. The schema is generated from the same Zod that validates here, so an editor pointed at kit/schema will complete it.`,
			},
		),
	);
	if (fatal) {
		throw new ProjectError(
			reported[0] ??
				raw('front-matter-invalid', { kind: 'file', file }, null, `${file} does not validate.`),
		);
	}
	findings.push(...reported);
	return undefined;
}

/** Every file under `directory`, relative to it, with symlinks refused rather than followed. */
function walk(directory: string, base: string, findings: RawFinding[]): string[] {
	const found: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return found;
	}

	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const full = join(directory, entry.name);
		const relativePath = relative(base, full).split(sep).join('/');

		if (entry.isSymbolicLink()) {
			findings.push(
				raw(
					'source-layout',
					{ kind: 'file', file: relativePath },
					null,
					'A symbolic link inside the publishable root.',
					{
						remediation:
							'Delete it. A symlink is the only way a checked-out tree can point outside itself, and refusing it is the whole of what keeps a page from escaping docs/site.',
					},
				),
			);
			continue;
		}

		if ((FORBIDDEN_SOURCE_NAMES as readonly string[]).includes(entry.name)) {
			findings.push(
				raw(
					'wiring-forbidden-agent-files',
					{ kind: 'file', file: relativePath },
					null,
					`"${entry.name}" cannot live under docs/site/.`,
					{
						remediation:
							'Move it to docs/, one level up. sync-public.sh copies docs/site into the public mirror and its prune step deletes these four names afterwards, so a release dies there with an error about a file nobody put here on purpose.',
					},
				),
			);
			continue;
		}

		if (entry.isDirectory()) {
			found.push(...walk(full, base, findings));
			continue;
		}
		found.push(relativePath);
	}

	return found;
}

export function loadProject(appRoot: string): LoadedProject {
	const siteRoot = join(appRoot, 'docs', 'site');
	const findings: RawFinding[] = [];

	const config = parseConfig<DocsProjectConfig>(
		docsProjectConfigSchema,
		readJson(join(siteRoot, 'docs.json'), 'docs.json'),
		'docs.json',
		true,
		findings,
	) as DocsProjectConfig;
	const nav = parseConfig<NavTree>(
		navTreeSchema,
		readJson(join(siteRoot, 'nav.json'), 'nav.json'),
		'nav.json',
		true,
		findings,
	) as NavTree;

	let denyList: DenyList | null = null;
	try {
		statSync(join(appRoot, 'docs', 'docs.private.json'));
		denyList =
			parseConfig<DenyList>(
				denyListSchema,
				readJson(join(appRoot, 'docs', 'docs.private.json'), 'docs.private.json'),
				'docs.private.json',
				false,
				findings,
			) ?? null;
	} catch {
		denyList = null;
	}

	const repository = readRepository(appRoot);
	const repoPrefix =
		repository === undefined ? '' : `${relative(repository.root, siteRoot).split(sep).join('/')}/`;

	const pages = new Map<string, Map<Locale, SourceDocument>>();
	const snippets = new Map<string, Map<Locale, SourceDocument>>();
	const assets = new Map<string, LoadedAsset>();
	let examined = 0;

	const declared = new Set<Locale>(config.i18n.locales);
	const seenLocaleDirectory = new Map<Locale, string>();

	for (const file of walk(siteRoot, siteRoot, findings)) {
		if (file === 'docs.json' || file === 'nav.json') continue;
		examined += 1;
		const segments = file.split('/');
		const root = segments[0] as string;
		const full = join(siteRoot, file);

		if (root === 'assets') {
			assets.set(file, { file, repoPath: `${repoPrefix}${file}`, bytes: readFileSync(full) });
			continue;
		}

		if (root !== 'content' && root !== 'snippets') {
			findings.push(
				raw(
					'source-layout',
					{ kind: 'file', file },
					null,
					`"${root}/" is not part of a documentation tree.`,
					{
						remediation:
							'The publishable root holds docs.json, nav.json, content/, snippets/ and assets/. Anything else is copied to the public mirror with no route to it.',
					},
				),
			);
			continue;
		}

		const directory = segments[1];
		if (directory === undefined || segments.length < 3) {
			findings.push(
				raw(
					'source-layout',
					{ kind: 'file', file },
					null,
					`${file} is not inside a locale directory.`,
					{
						remediation: `Move it to ${root}/<locale>/. The locale comes from the directory and from nothing else.`,
					},
				),
			);
			continue;
		}

		const matched = matchLocale(directory);
		if (!matched.ok) {
			findings.push(
				raw('translation-missing', { kind: 'file', file }, null, matched.message, {
					remediation: `Rename or remove ${root}/${directory}/.`,
				}),
			);
			continue;
		}
		const locale = matched.locale;
		if (!matched.canonical) {
			findings.push(
				raw(
					'translation-missing',
					{ kind: 'file', file },
					locale,
					`"${directory}" is a spelling of "${locale}" rather than the spelling this package uses.`,
					{
						remediation: `Rename the directory to "${locale}". Two spellings of one language produce two directories that compile into each other.`,
					},
				),
			);
		}
		const previous = seenLocaleDirectory.get(locale);
		if (previous !== undefined && previous !== directory) {
			findings.push(
				raw(
					'translation-missing',
					{ kind: 'file', file },
					locale,
					`Both "${previous}" and "${directory}" resolve to the locale "${locale}".`,
					{ remediation: 'Merge them. One language has one directory.' },
				),
			);
		}
		seenLocaleDirectory.set(locale, directory);

		if (!declared.has(locale)) {
			findings.push(
				raw(
					'translation-missing',
					{ kind: 'file', file },
					locale,
					`"${locale}" is not in this project's i18n.locales.`,
					{
						remediation: `Add it to docs.json i18n.locales, or remove the directory. Declared: ${sortLocales(declared).join(', ')}.`,
					},
				),
			);
			continue;
		}

		if (!file.endsWith('.md')) {
			findings.push(
				raw('source-layout', { kind: 'file', file }, locale, `${file} is not a markdown file.`, {
					remediation: 'Content is markdown. Images belong in assets/.',
				}),
			);
			continue;
		}

		const text = readFileSync(full, 'utf8');
		const id = segments.slice(2).join('/').replace(/\.md$/, '');
		const document: SourceDocument = {
			file,
			repoPath: `${repoPrefix}${file}`,
			locale,
			id,
			text,
		};

		if (root === 'snippets') {
			if (!SNIPPET_ID_PATTERN.test(id)) {
				findings.push(
					raw('snippet-resolves', { kind: 'file', file }, locale, `"${id}" is not a snippet id.`, {
						remediation:
							'Snippet ids are one slug segment, because they are only ever a filename and a key. Move it out of a subdirectory.',
					}),
				);
				continue;
			}
			const byLocale = snippets.get(id) ?? new Map<Locale, SourceDocument>();
			byLocale.set(locale, document);
			snippets.set(id, byLocale);
			continue;
		}

		const parsed = parseSlug(id);
		if (!parsed.ok) {
			findings.push(
				raw('slug-reserved', { kind: 'file', file }, locale, parsed.message, {
					remediation:
						'Rename the file. The slug is the path and a page cannot disagree with its own address.',
				}),
			);
			continue;
		}
		const byLocale = pages.get(id) ?? new Map<Locale, SourceDocument>();
		byLocale.set(locale, document);
		pages.set(id, byLocale);
	}

	return {
		appRoot,
		siteRoot,
		repository,
		config,
		nav,
		denyList,
		pages,
		snippets,
		assets,
		findings,
		examined,
	};
}
