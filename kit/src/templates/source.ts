/**
 * The files a repository needs before it holds any documentation.
 *
 * Both halves of the config pair are built here on purpose. `DocsProjectConfig` is
 * `docs/site/docs.json` in the app repository and `DocsSiteConfig` is
 * `<project>.docs.json` in the web repository; `src/contracts/project.ts` opens by saying
 * that confusing the two is the mistake worth designing against, and neither is a partial
 * of the other. Keeping the two builders in one file is what lets a reader see in one
 * screen that they share exactly one key, `project`, and that it is the join.
 *
 * `sourceScaffold` is the table of files a project starts with, and it has exactly one
 * definition. `hexdocs init` writes them and `hexdocs scaffold source` returns them as
 * content for an agent to apply, and both read it from here: two lists of what a project
 * starts with would be two ideas of what a project is, and the one written by whichever
 * command was touched last would be the one nobody reads.
 *
 * Nothing in this module touches the filesystem. Every function is a pure builder over its
 * options, which is what lets `scaffold` return the strings to an agent without a writer
 * and lets `init` decide separately whether it is allowed to write them.
 */

import { posix } from 'node:path';

import type { LocalisedLabel } from '../../../src/contracts/frontmatter.js';
import { LOCALES } from '../../../src/contracts/locales.js';
import type { Locale } from '../../../src/contracts/locales.js';
import { NAV_VERSION } from '../../../src/contracts/nav.js';
import type { NavTree } from '../../../src/contracts/nav.js';
import {
	DEFAULT_BUDGETS,
	DENY_LIST_RELATIVE,
	DOCS_CONFIG_VERSION,
	PLAIN_CODE_LANGUAGE,
	SITE_ROOT_RELATIVE,
} from '../../../src/contracts/project.js';
import type { DenyList, DocsProjectConfig } from '../../../src/contracts/project.js';
import { SITE_CONFIG_VERSION } from '../../../src/contracts/site.js';
import type { DocsSiteConfig } from '../../../src/contracts/site.js';
import { UI_STRINGS } from '../../../src/ui/strings.js';

import { MIRROR_SCRIPT_RELATIVE, siteRootLine } from '../source/allow-paths.js';

import { PLACEHOLDER_DESCRIPTION, sourcePage } from './page.js';
import { BUNDLE_OUT, PUBLISH_WORKFLOW_PATH, publishWorkflow } from './workflow.js';

/**
 * Where the toolchain is mounted, when nobody measured it.
 *
 * `hex-nfc`, `sol-alarm` and `nepali-companion` mount the submodule here, mirroring where
 * `hex-terraform/` is mounted in the repositories that use it. kcalc mounts it at
 * `kcalc-web/docs` and hex-web at `common/docs`, which is exactly why this is a default
 * a caller can replace rather than the answer.
 */
export const DEFAULT_KIT_MOUNT = 'hex-docs';

/**
 * The AWS region the generated workflow names.
 *
 * A literal here rather than a repository variable, and the asymmetry with the bucket and
 * the role is deliberate: a region names no account and grants nothing, and this
 * repository's own CLAUDE.md states it in public.
 */
const PUBLISH_REGION = 'ap-southeast-2';

/**
 * Tab-indented JSON with a final newline, matching every checked-in config in the estate.
 *
 * `JSON.stringify` rather than a formatter, because these strings are applied in somebody
 * else's repository and there is no guarantee a formatter runs there at all. A file whose
 * bytes depend on a tool the receiving repository may not have is a file that reads as a
 * diff on the next person's first save.
 */
function json(value: unknown): string {
	return `${JSON.stringify(value, null, '\t')}\n`;
}

/**
 * The seven sidebar labels, read out of this package's own string table.
 *
 * This is what makes "installing documentation needs no locale-file edits" true.
 * `check-locales.mjs` in hex-web compares all seven locale files key for key in both
 * directions, so a chrome key this package needed would be fourteen mandatory edits in one
 * consumer and an invented mechanism in the other. The label lives in the config instead,
 * and the config gets it from `UI_STRINGS` rather than from a translation table written
 * here for the purpose.
 *
 * The cast is over a map of the whole `LOCALES` tuple, so the record cannot come out
 * partial, and it is not covering for a missing key: `UI_STRINGS` is
 * `Record<Locale, Record<UiKey, string>>`, so an eighth language added to `LOCALES` and
 * not to the string table fails the typecheck where the strings are.
 */
function navLabelFromUiStrings(): LocalisedLabel {
	return Object.fromEntries(
		LOCALES.map((locale) => [locale, UI_STRINGS[locale].treeLabel]),
	) as LocalisedLabel;
}

// ---------------------------------------------------------------------------
// the individual files
// ---------------------------------------------------------------------------

export interface ProjectConfigOptions {
	project: string;
	productName: string;
	/** `owner/name`, as GitHub spells it. */
	repo: string;
	/** In `LOCALES` order and containing `en`. The caller normalises; this does not check. */
	locales: readonly Locale[];
	/** A relative `$schema` path, or `null` to omit the key. */
	schemaRef: string | null;
}

/** `docs/site/docs.json`: the app repository's own configuration. */
export function docsProjectConfig(options: ProjectConfigOptions): string {
	const config: DocsProjectConfig = {
		...(options.schemaRef === null ? {} : { $schema: options.schemaRef }),
		docs: DOCS_CONFIG_VERSION,
		project: options.project,
		productName: options.productName,
		repo: options.repo,
		defaultAudience: 'both',
		headingIds: 'slug',
		// Empty, and it stays empty until a page exists under a first path segment.
		// `SectionConfig.kind` drives exactly one thing, the warning when a page's audience
		// does not match its section's usual one, so a section declared before any page
		// lives in it configures a warning about nothing.
		//
		// Legal documents are the case that wants `headingIds: "section-number"` above
		// instead of the default: `#section-4` then addresses the same clause in all seven
		// languages, where slugified heading text gives each language its own anchors and
		// breaks every inbound link with nothing reporting it.
		sections: [],
		i18n: {
			locales: [...options.locales],
			// The contract types this as the literal `'en'`, so this line is not a second
			// declaration of the fact. Documentation is authored in English and translated
			// outward, and staleness is defined against this locale and nothing else.
			sourceLocale: 'en',
			// `graceful` publishes what exists and marks the rest. A new project's first
			// bundle is one English page, and `required` would make that bundle a
			// publish-blocking error against six translations nobody has written yet. Flip
			// it once a manual is fully translated and staying that way is worth enforcing.
			parity: 'graceful',
		},
		budgets: { ...DEFAULT_BUDGETS },
		// `text` and nothing else. This is an allowlist rather than "whatever the
		// highlighter knows", which is what makes a typo like ```swfit an error instead of
		// an unhighlighted block nobody notices, and that property holds only while the
		// list is the languages this project actually uses. Add each one the first time a
		// fence needs it.
		code: { languages: [PLAIN_CODE_LANGUAGE] },
		toc: { enabled: true, maxDepth: 3, minHeadings: 3 },
		// Zero suppressions, because there are no pages yet and so nothing to suppress. The
		// number is a budget rather than a switch: raising it is a diff somebody reads,
		// which is the only thing that keeps a growing pile of `hexdocs-disable-next-line`
		// comments visible.
		lint: { extends: 'house', maxDisables: 0 },
	};
	return json(config);
}

/** `docs/site/nav.json`: the order of the documentation, and the page namespace. */
export function navTree(options: { schemaRef: string | null }): string {
	const tree: NavTree = {
		...(options.schemaRef === null ? {} : { $schema: options.schemaRef }),
		nav: NAV_VERSION,
		// One entry, because a scaffolded tree has one page. This file is the page namespace
		// as well as the order: a published page that appears nowhere in it is an orphan,
		// reachable by URL and unreachable by reading, and `orphan-page` is an error. Every
		// page added under `content/<locale>/` has to be added here too.
		items: [{ doc: 'index' }],
	};
	return json(tree);
}

/**
 * `docs/docs.private.json`: the strings and patterns that must never reach a published
 * page.
 *
 * The `strings` list comes out empty and the project is expected to fill it, which costs a
 * real error on the first `hexdocs check`. A placeholder would have been the comfortable
 * choice and it is the wrong one: `no-competitor-name` reports an empty list as "the deny
 * scan examined nothing", and a made-up needle would replace that honest refusal with a
 * scan of one string nobody chose, counted among the passing checks. A scaffolder cannot
 * know which product names a project must not mention, so it says so instead of
 * pretending.
 *
 * The two patterns are not placeholders. Both are shapes no published page in this estate
 * should carry and both are cheap to match: an iOS device identifier, which is what an
 * internal bench-procedure tree is full of, and a long-lived AWS access key id, which is
 * half a credential and the half that names the account.
 */
export function denyList(options: { schemaRef: string | null }): string {
	const list: DenyList = {
		...(options.schemaRef === null ? {} : { $schema: options.schemaRef }),
		private: 1,
		strings: [],
		patterns: [
			{
				id: 'ios-device-udid',
				pattern: '\\b[0-9A-F]{8}-[0-9A-F]{16}\\b',
				flags: 'i',
				why: 'An iOS device identifier. It names one physical phone from a test rig, and it belongs in an internal tree rather than on a page anybody can read.',
			},
			{
				id: 'aws-access-key-id',
				pattern: '\\bAKIA[0-9A-Z]{16}\\b',
				flags: '',
				why: 'A long-lived AWS access key id. A page carrying one has published half a credential, and the half that names the account.',
			},
			{
				id: 'aws-account-identifier',
				pattern: 'arn:aws[a-z-]*:|(?<![0-9a-fA-F])[0-9]{12}(?![0-9a-fA-F])',
				flags: '',
				why: 'An AWS ARN or a bare twelve digit account id. The page likeliest to carry one is the page describing how this documentation is published, which an author writes with the workflow open beside them. The digit half refuses a hex neighbour on either side: a word boundary sits between a letter and a digit, so a plain twelve digit match hits every sha256 digest on the page.',
			},
		],
	};
	return json(list);
}

export interface SiteConfigOptions {
	project: string;
	/** Leading slash, no trailing slash, no locale segment. */
	basePath: string;
	schemaRef: string | null;
}

/**
 * `<project>.docs.json`: the docs mount, as the consuming website sees it.
 *
 * `versions` comes out empty and the file therefore does not validate, which is the one
 * hole this module leaves on purpose. The schema requires at least one version entry and
 * an entry requires a real 40-character commit sha; there is no sha a scaffolder could
 * know, and writing a plausible-looking one would put a fabricated commit into the file
 * the version picker reads. `hexdocs label` produces the first entry.
 *
 * `pages` is empty because `hexdocs sync` writes it, `hidden` is omitted rather than
 * written as an empty array, and `themeClass` is omitted because absent is a supported
 * state: it means the documentation takes this package's own palette, which is the case
 * that has to work for the package to be reusable at all.
 */
export function siteConfig(options: SiteConfigOptions): string {
	const config: DocsSiteConfig = {
		...(options.schemaRef === null ? {} : { $schema: options.schemaRef }),
		site: SITE_CONFIG_VERSION,
		project: options.project,
		basePath: options.basePath,
		navLabel: navLabelFromUiStrings(),
		versions: [],
		pages: [],
	};
	return json(config);
}

// ---------------------------------------------------------------------------
// the scaffold
// ---------------------------------------------------------------------------

export type ScaffoldedFile = {
	/** Relative to the repository root, forward slashes. */
	path: string;
	action: 'create' | 'patch';
	/** The whole file for a create; the exact text to insert for a patch. */
	contents: string;
	/**
	 * For a patch, the existing line to insert `contents` after. `null` for a create.
	 *
	 * Present and null rather than absent, which is the convention for anything an agent
	 * reads: "there is no anchor" must not read the same as a key somebody forgot to set.
	 * `hexdocs init` does not use it, because it parses the file and computes the real
	 * insertion point; it is here for an agent applying the change with Edit.
	 */
	anchor: string | null;
	why: string;
};

export type SourceScaffoldPlan = {
	files: ScaffoldedFile[];
	/** Things the caller has to say out loud. Never empty for this scaffold. */
	notes: string[];
};

export interface SourceScaffoldOptions {
	project: string;
	productName: string;
	repo: string;
	/** In `LOCALES` order and containing `en`. */
	locales: readonly Locale[];
	/**
	 * Where the toolchain is mounted, relative to the repository root.
	 *
	 * Only the `$schema` references and the workflow's two `run:` lines depend on it, and
	 * both are wrong in a way nobody notices until they are needed: a `$schema` that does
	 * not resolve costs an editor's completion, and a `run:` that does not resolve costs a
	 * failed publish. The default is the documented mount rather than a guess.
	 */
	kitMount?: string;
}

/**
 * The anchor line an agent inserts the allowlist entry after.
 *
 * Four spaces and a double-quoted entry, because that is the shape of every line in
 * hex-nfc's array and the file contains no tab characters at all. `insertSiteRoot`
 * computes the real anchor from the parsed file, including its indent; this constant is
 * the documented default for a caller that is handing the change to an agent rather than
 * applying it, and it names the entry the docs group already has.
 */
export const ALLOW_PATHS_ANCHOR = '    "docs/public"';

/**
 * A relative `$schema` reference from one repository-relative file to a generated schema.
 *
 * Accepted and ignored by every schema in this package, and worth writing anyway: a
 * relative path gives an editor completion and validation in place with nothing hosted
 * anywhere, which is the difference between a config somebody can fill in and one they
 * have to look up. Posix throughout, because it is a line in a JSON file rather than a
 * path on the machine reading it.
 */
export function schemaRefFor(file: string, kitMount: string, schema: string): string {
	const target = posix.join(kitMount, 'kit/schema', schema);
	const reference = posix.relative(posix.dirname(file), target);
	return reference.startsWith('.') ? reference : `./${reference}`;
}

/**
 * Every file a documentation tree starts with, in the order somebody reads them.
 *
 * The publish workflow is in this list and is deliberately **not** in any public-mirror
 * allowlist. In hex-nfc, `.github/workflows/` is allowlisted per file and the mirror
 * script's own workflow is excluded by simply not being listed; this one is excluded by
 * the same mechanism, absence, and for the same reason: it names the bucket and the
 * publisher role, which is the pair an attacker would want and which a reader of a public
 * mirror could not use anyway.
 */
export function sourceScaffold(options: SourceScaffoldOptions): SourceScaffoldPlan {
	const kitMount = options.kitMount ?? DEFAULT_KIT_MOUNT;
	const files: ScaffoldedFile[] = [];
	const notes: string[] = [];

	const configPath = `${SITE_ROOT_RELATIVE}/docs.json`;
	files.push({
		path: configPath,
		action: 'create',
		contents: docsProjectConfig({
			project: options.project,
			productName: options.productName,
			repo: options.repo,
			locales: options.locales,
			schemaRef: schemaRefFor(configPath, kitMount, 'docs-1.json'),
		}),
		anchor: null,
		why: 'The project configuration: what the compiler reads before it reads a single page.',
	});

	const navPath = `${SITE_ROOT_RELATIVE}/nav.json`;
	files.push({
		path: navPath,
		action: 'create',
		contents: navTree({ schemaRef: schemaRefFor(navPath, kitMount, 'nav-1.json') }),
		anchor: null,
		why: 'The order of the documentation, and the page namespace. A published page missing from here is an orphan, which is an error rather than a warning.',
	});

	const indexPath = `${SITE_ROOT_RELATIVE}/content/en/index.md`;
	const index = sourcePage({
		title: `${options.productName} documentation`,
		description: PLACEHOLDER_DESCRIPTION,
	});
	if (index.ok) {
		files.push({
			path: indexPath,
			action: 'create',
			contents: index.contents,
			anchor: null,
			why: 'The one page the nav names. Every page after it is added here and to nav.json together.',
		});
	} else {
		notes.push(`${indexPath} could not be built. ${index.why}`);
	}

	files.push({
		path: DENY_LIST_RELATIVE,
		action: 'create',
		contents: denyList({ schemaRef: schemaRefFor(DENY_LIST_RELATIVE, kitMount, 'private-1.json') }),
		anchor: null,
		why: `The strings and patterns that must never reach a published page. It sits outside ${SITE_ROOT_RELATIVE}/ on purpose: it names the things that must not ship, so keeping it inside the tree the publisher reads would be the same mistake in miniature.`,
	});

	files.push({
		path: PUBLISH_WORKFLOW_PATH,
		action: 'create',
		contents: publishWorkflow({ kitMount, region: PUBLISH_REGION, out: BUNDLE_OUT }),
		anchor: null,
		why: 'Turns every commit on main into a bundle keyed by its sha. Labelling one of those shas is what publishes a version.',
	});

	files.push({
		path: MIRROR_SCRIPT_RELATIVE,
		action: 'patch',
		// Derived from the constant the compiler resolves the publishable root against, and
		// that pairing is the whole reason `SITE_ROOT_RELATIVE` exists. Widening this to a
		// bare `docs` means editing that constant, and editing that constant points the
		// compiler at `docs/` instead of `docs/site/`, which every project test in
		// `kit/test/compile/` fails on long before anything reaches a mirror.
		contents: siteRootLine(),
		anchor: ALLOW_PATHS_ANCHOR,
		why: `Without this line the public mirror carries no documentation at all. With a bare "docs" instead of ${JSON.stringify(SITE_ROOT_RELATIVE)} it carries the internal tree as well, and prune_internal_files() matches four basenames and would report nothing to prune.`,
	});

	notes.push(
		'docs.private.json comes back with an empty `strings` list, and no-competitor-name reports that as an error naming the file until it is filled in. That is deliberate: a placeholder needle would replace an honest "the deny scan examined nothing" with a scan of one string nobody chose, counted among the passing checks. Add the product names this project must never mention.',
	);
	notes.push(
		'The publish workflow needs two repository variables before it can run: HEXDOCS_PUBLISH_ROLE and HEXDOCS_BUCKET. Neither is written into the file, because it is committed to a repository whose public mirror is protected by an allowlist rather than by a rule.',
	);
	// Asked for rather than written, because this command never edits a file it did not
	// create and a repository already has a .gitignore with its own reasons in it. It is a
	// note rather than silence because the directory lands in the repository root as a full
	// object tree, and the next `git add -A` commits it: on a repository with a public
	// mirror that is a directory nobody reviewed against the allowlist. The consumer half
	// treats the same class of thing as first class, with a gitignore edit of its own and a
	// `prefetch-gitignore` row; this side had nothing at all.
	notes.push(
		`Add ${BUNDLE_OUT}/ to .gitignore. That is where the publish workflow compiles, and a build run by hand in a checkout puts the whole object tree in the repository root as untracked files.`,
	);
	notes.push(
		'Do not add the publish workflow to a public-mirror allowlist, and do not put a helper it calls in .github/scripts/, which hex-nfc allowlists as a whole directory. Exclusion by absence is what keeps the bucket name and the role name off the mirror.',
	);
	notes.push(
		"sections is empty in docs.json. Add one entry per first slug segment as the tree grows; it drives the warning when a page's audience does not match its section's usual one, and nothing else.",
	);

	return { files, notes };
}
