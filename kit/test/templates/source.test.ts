/**
 * The files a repository starts with, held to the schemas this package ships.
 *
 * The assertion that carries the weight is the same one in five places: **the generated
 * file is parsed and validated against its own validator**. A scaffolder that emits a
 * config its own schema rejects is the tool contradicting itself, and it is a failure
 * nobody sees until somebody runs `hexdocs check` in a repository they have just set up
 * and reads an error about a file they did not write. Nothing here asserts that a string
 * contains a key name: `expect(text).toContain('"parity"')` passes against a config whose
 * parity is `strict`, against one where the key is in the wrong object, and against one
 * that is not JSON at all.
 *
 * `siteConfig` is the exception and it is asserted as one. That file is deliberately
 * incomplete, so the test is that it fails validation for exactly one reason and that
 * filling in that one field makes it pass. "It does not validate" on its own would be
 * satisfied by a file with three other things wrong with it.
 *
 * Deliberately not covered here: what `hexdocs init` does with this plan, which is
 * `kit/test/commands/init.test.ts`, and what `hexdocs scaffold source` does with it
 * against a real repository, which is `kit/test/commands/scaffold.test.ts`. This file is
 * the pure builders and nothing else touches the filesystem except the one existence check
 * that says a `$schema` reference names a schema that is really there.
 */

import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { LOCALES, type Locale } from '../../../src/contracts/locales.js';
import { NAV_VERSION } from '../../../src/contracts/nav.js';
import {
	DENY_LIST_RELATIVE,
	DOCS_CONFIG_VERSION,
	SITE_ROOT_RELATIVE,
} from '../../../src/contracts/project.js';
import { SITE_CONFIG_VERSION } from '../../../src/contracts/site.js';
import { UI_STRINGS } from '../../../src/ui/strings.js';
import {
	denyListSchema,
	docsProjectConfigSchema,
	docsSiteConfigSchema,
	navTreeSchema,
} from '../../src/contracts/config.schema.js';
import { MIRROR_SCRIPT_RELATIVE, normaliseEntry } from '../../src/source/allow-paths.js';
import {
	ALLOW_PATHS_ANCHOR,
	DEFAULT_KIT_MOUNT,
	denyList,
	docsProjectConfig,
	navTree,
	schemaRefFor,
	siteConfig,
	sourceScaffold,
	type ScaffoldedFile,
} from '../../src/templates/source.js';
import { PUBLISH_WORKFLOW_PATH } from '../../src/templates/workflow.js';

const PROJECT = 'fixture-app';
const PRODUCT = 'Fixture App';
const REPO = 'hexpro-dev/fixture-app';

/** The repository this test file is in, so a `$schema` reference can be resolved for real. */
const HEX_DOCS_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function parseJson(text: string): unknown {
	return JSON.parse(text) as unknown;
}

// ---------------------------------------------------------------------------
// the shape every generated file shares
// ---------------------------------------------------------------------------

describe('the JSON these builders write', () => {
	const files = [
		docsProjectConfig({
			project: PROJECT,
			productName: PRODUCT,
			repo: REPO,
			locales: ['en'],
			schemaRef: null,
		}),
		navTree({ schemaRef: null }),
		denyList({ schemaRef: null }),
		siteConfig({ project: PROJECT, basePath: `/${PROJECT}/docs`, schemaRef: null }),
	];

	test('is tab indented and ends in a newline, matching every checked-in config', () => {
		for (const text of files) {
			expect(text.endsWith('}\n')).toBe(true);
			expect(text).toContain('\n\t"');
			// Not spaces. These strings are applied in somebody else's repository, and a file
			// whose bytes depend on a formatter the receiving repository may not have is a file
			// that reads as a diff on the next person's first save.
			expect(text).not.toContain('\n  "');
		}
	});

	test('omits $schema rather than writing it as null', () => {
		for (const text of files) {
			const value = parseJson(text) as Record<string, unknown>;
			expect('$schema' in value).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// docs/site/docs.json
// ---------------------------------------------------------------------------

describe('docsProjectConfig', () => {
	const built = (locales: readonly Locale[] = ['en']): Record<string, unknown> =>
		parseJson(
			docsProjectConfig({
				project: PROJECT,
				productName: PRODUCT,
				repo: REPO,
				locales,
				schemaRef: schemaRefFor(
					`${SITE_ROOT_RELATIVE}/docs.json`,
					DEFAULT_KIT_MOUNT,
					'docs-1.json',
				),
			}),
		) as Record<string, unknown>;

	test('validates against the schema the compiler reads it with', () => {
		const parsed = docsProjectConfigSchema.safeParse(built());
		expect(parsed.error?.issues ?? []).toEqual([]);
		expect(parsed.success).toBe(true);
	});

	test('and still validates with every locale the estate ships', () => {
		const parsed = docsProjectConfigSchema.safeParse(built(LOCALES));
		expect(parsed.error?.issues ?? []).toEqual([]);
		expect(parsed.data?.i18n.locales).toEqual([...LOCALES]);
	});

	test('starts a project at the settings a first bundle can actually meet', () => {
		const config = docsProjectConfigSchema.parse(built());
		expect(config.docs).toBe(DOCS_CONFIG_VERSION);
		expect(config.project).toBe(PROJECT);
		expect(config.productName).toBe(PRODUCT);
		expect(config.repo).toBe(REPO);
		// `graceful`, because a new project's first bundle is one English page and `required`
		// would make that bundle a publish-blocking error against six translations nobody
		// has written yet.
		expect(config.i18n.parity).toBe('graceful');
		expect(config.i18n.sourceLocale).toBe('en');
		// Empty, and it stays empty until a page exists under a first path segment: a section
		// declared before any page lives in it configures a warning about nothing.
		expect(config.sections).toEqual([]);
		// Zero suppressions. The number is a budget rather than a switch, and raising it is a
		// diff somebody reads.
		expect(config.lint.maxDisables).toBe(0);
		expect(config.lint.extends).toBe('house');
	});

	test('the fence allowlist starts at one language, so a typo is an error', () => {
		const config = docsProjectConfigSchema.parse(built());
		// The property is that the list is an allowlist rather than "whatever the highlighter
		// knows". That holds only while it is the languages the project really uses, so the
		// scaffold starts with exactly one and every other is added the first time a fence
		// needs it.
		expect(config.code.languages).toEqual(['text']);
	});

	test('a project that switched off a protected rule would be refused by this schema', () => {
		// Not a property of the scaffold: a property of the validator the scaffold is held to,
		// asserted here because the scaffold is the reason a reader trusts the file. Without
		// it, "the generated config validates" would be a weaker claim than it reads as.
		const config = built() as Record<string, unknown>;
		config['lint'] = { extends: 'house', maxDisables: 0, rules: { 'internal-leak': 'off' } };
		const parsed = docsProjectConfigSchema.safeParse(config);
		expect(parsed.success).toBe(false);
		expect(JSON.stringify(parsed.error?.issues ?? [])).toContain('internal-leak');
	});
});

// ---------------------------------------------------------------------------
// docs/site/nav.json
// ---------------------------------------------------------------------------

describe('navTree', () => {
	test('validates, and names exactly the one page the scaffold writes', () => {
		const tree = navTreeSchema.parse(parseJson(navTree({ schemaRef: null })));
		expect(tree.nav).toBe(NAV_VERSION);
		// One entry, because a scaffolded tree has one page and this file is the page
		// namespace as well as the order: a published page no nav entry reaches is an orphan,
		// which is an error rather than a warning.
		expect(tree.items).toEqual([{ doc: 'index' }]);
	});
});

// ---------------------------------------------------------------------------
// docs/docs.private.json
// ---------------------------------------------------------------------------

describe('denyList', () => {
	const list = denyListSchema.parse(parseJson(denyList({ schemaRef: null })));

	test('validates, and comes back with no strings at all', () => {
		expect(list.private).toBe(1);
		// Deliberately empty. `no-competitor-name` reports an empty list as "the deny scan
		// examined nothing", and a made-up needle would replace that honest refusal with a
		// scan of one string nobody chose, counted among the passing checks.
		expect(list.strings).toEqual([]);
	});

	test('and the two patterns match the shapes they name', () => {
		// Assembled from pieces rather than written out, for the same reason the banned
		// characters in this repository are declared as code points: a file testing a pattern
		// must not itself contain a string the pattern matches, or every scanner that reads
		// this repository has one hit to explain.
		const udid = `${'00008030'}-${'001A2B3C4D5E6F70'}`;
		const key = `AKIA${'ABCDEFGHIJKLMNOP'}`;
		const matches = (id: string, sample: string): boolean => {
			const entry = list.patterns.find((candidate) => candidate.id === id);
			expect(entry).toBeDefined();
			return new RegExp((entry as { pattern: string }).pattern, entry?.flags).test(sample);
		};

		expect(matches('ios-device-udid', udid)).toBe(true);
		// The `i` flag is not decoration: an identifier is as likely to be pasted lower case.
		expect(matches('ios-device-udid', udid.toLowerCase())).toBe(true);
		expect(matches('aws-access-key-id', key)).toBe(true);

		// And neither fires on ordinary prose, which is what makes a hit worth reading.
		expect(matches('ios-device-udid', 'The tag id is printed on the label.')).toBe(false);
		expect(matches('aws-access-key-id', 'AKIA is a prefix.')).toBe(false);
	});

	test('every pattern compiles, so a bad one fails here and not at publish time', () => {
		expect(list.patterns.length).toBeGreaterThan(0);
		for (const entry of list.patterns) {
			expect(() => new RegExp(entry.pattern, entry.flags)).not.toThrow();
			expect(entry.why.length).toBeGreaterThan(20);
		}
	});
});

// ---------------------------------------------------------------------------
// <project>.docs.json
// ---------------------------------------------------------------------------

describe('siteConfig', () => {
	const text = siteConfig({ project: PROJECT, basePath: `/${PROJECT}/docs`, schemaRef: null });
	const value = parseJson(text) as Record<string, unknown>;

	test('does not validate, and versions is the only reason', () => {
		const parsed = docsSiteConfigSchema.safeParse(value);
		expect(parsed.success).toBe(false);
		// One reason, named. "It does not validate" on its own would be satisfied by a file
		// with three other things wrong with it, which is precisely the state this file must
		// not be shipped in.
		expect((parsed.error?.issues ?? []).map((issue) => issue.path.join('.'))).toEqual(['versions']);
	});

	test('and one real version entry is all it needs', () => {
		const parsed = docsSiteConfigSchema.safeParse({
			...value,
			versions: [
				{
					label: '1.0',
					commit: '0'.repeat(40),
					released: '2026-01-01',
					default: true,
				},
			],
		});
		expect(parsed.error?.issues ?? []).toEqual([]);
		expect(parsed.success).toBe(true);
	});

	test('pages comes back empty, because hexdocs sync writes it as a build input', () => {
		expect(value['pages']).toEqual([]);
		expect(value['site']).toBe(SITE_CONFIG_VERSION);
		// Absent rather than empty. `hidden` is optional and a hidden slug must also be in
		// `pages`, so an empty array here would be a key saying nothing.
		expect('hidden' in value).toBe(false);
		// Absent is a supported state and means the documentation takes this package's own
		// palette, which is the case that has to work for the package to be reusable at all.
		expect('themeClass' in value).toBe(false);
	});

	test('the sidebar label is this package own string table, in all seven languages', () => {
		const label = value['navLabel'] as Record<string, string>;
		// Both directions on the key set. A locale added to the package and not to this
		// record would ship an untranslated sidebar heading, and the schema would accept it:
		// `localisedLabelSchema` is a record over the locales, and a missing key is only
		// caught where the record is built.
		expect(Object.keys(label).sort()).toEqual([...LOCALES].sort());
		for (const locale of LOCALES) {
			// Against the real table, not against a copy written here. A second table of seven
			// strings is a second idea of what the sidebar is called.
			expect(label[locale]).toBe(UI_STRINGS[locale].treeLabel);
		}
		// And the values are really translated, rather than seven copies of the English.
		// `fr` and `en` genuinely share a spelling, so this counts distinct values instead of
		// asserting all seven differ.
		expect(new Set(Object.values(label)).size).toBeGreaterThan(4);
	});
});

// ---------------------------------------------------------------------------
// the $schema references
// ---------------------------------------------------------------------------

describe('schemaRefFor', () => {
	test('climbs out of the file it is written in and lands on a schema that exists', () => {
		const file = `${SITE_ROOT_RELATIVE}/docs.json`;
		const reference = schemaRefFor(file, DEFAULT_KIT_MOUNT, 'docs-1.json');
		expect(reference).toBe('../../hex-docs/kit/schema/docs-1.json');

		// Resolved the way an editor resolves it: against the directory of the file that
		// carries it. This is the difference between a reference that gives completion and
		// one that is wrong in a way nobody notices until they need it.
		const resolved = posix.normalize(posix.join(posix.dirname(file), reference));
		expect(resolved).toBe(`${DEFAULT_KIT_MOUNT}/kit/schema/docs-1.json`);
		// And the schema is really in this repository under that name.
		expect(existsSync(new URL('kit/schema/docs-1.json', new URL(`file://${HEX_DOCS_ROOT}`)))).toBe(
			true,
		);
	});

	test('a file at the repository root gets an explicit ./ rather than a bare path', () => {
		// `hexdocs.json` and `../hex-docs/...` resolve the same to a shell and differently to
		// a reader: a bare `hex-docs/...` reads as a package name in a JSON pointer, which is
		// what a hosted `$schema` looks like.
		expect(schemaRefFor('docs.json', DEFAULT_KIT_MOUNT, 'site-1.json')).toBe(
			'./hex-docs/kit/schema/site-1.json',
		);
	});

	test('follows the mount rather than assuming one', () => {
		// kcalc mounts the submodule at `kcalc-web/docs`, and the site config lives under
		// `kcalc-web/front/app/docs/`.
		expect(
			schemaRefFor('kcalc-web/front/app/docs/kcalc.docs.json', 'kcalc-web/docs', 'site-1.json'),
		).toBe('../../../docs/kit/schema/site-1.json');
	});
});

// ---------------------------------------------------------------------------
// the whole plan
// ---------------------------------------------------------------------------

describe('sourceScaffold', () => {
	const plan = sourceScaffold({
		project: PROJECT,
		productName: PRODUCT,
		repo: REPO,
		locales: ['en'],
	});
	const byPath = new Map(plan.files.map((file) => [file.path, file]));

	test('is exactly the six files a documentation tree starts with, in reading order', () => {
		// Both directions, and in order: the list is the definition of what a project is, and
		// a file added to it silently is a file `init` writes and nobody reviewed.
		expect(plan.files.map((file) => file.path)).toEqual([
			`${SITE_ROOT_RELATIVE}/docs.json`,
			`${SITE_ROOT_RELATIVE}/nav.json`,
			`${SITE_ROOT_RELATIVE}/content/en/index.md`,
			DENY_LIST_RELATIVE,
			PUBLISH_WORKFLOW_PATH,
			MIRROR_SCRIPT_RELATIVE,
		]);
	});

	test('every one carries a reason, and only the mirror script is a patch', () => {
		for (const file of plan.files) {
			// A file an agent is told to write with no sentence saying why is a file that gets
			// written without being read.
			expect(file.why.length).toBeGreaterThan(30);
			expect(file.contents.length).toBeGreaterThan(0);
		}
		const patches = plan.files.filter((file) => file.action === 'patch');
		expect(patches.map((file) => file.path)).toEqual([MIRROR_SCRIPT_RELATIVE]);
		// `anchor` is present and null on a create rather than absent: "there is no anchor"
		// must not read the same as a key somebody forgot to set.
		for (const file of plan.files.filter((entry) => entry.action === 'create')) {
			expect(file.anchor).toBeNull();
		}
	});

	test('every generated JSON file validates against its own schema', () => {
		const cases: readonly [string, { safeParse: (value: unknown) => { success: boolean } }][] = [
			[`${SITE_ROOT_RELATIVE}/docs.json`, docsProjectConfigSchema],
			[`${SITE_ROOT_RELATIVE}/nav.json`, navTreeSchema],
			[DENY_LIST_RELATIVE, denyListSchema],
		];
		for (const [path, schema] of cases) {
			const file = byPath.get(path) as ScaffoldedFile;
			expect(file).toBeDefined();
			const parsed = schema.safeParse(parseJson(file.contents));
			expect([path, parsed.success]).toEqual([path, true]);
		}
	});

	test('the allowlist line is the publishable root, at the indent the one real mirror uses', () => {
		const patch = byPath.get(MIRROR_SCRIPT_RELATIVE) as ScaffoldedFile;
		expect(patch.contents).toBe(`    "${SITE_ROOT_RELATIVE}"`);
		// Four spaces exactly, because that is the shape of every line in the array this is
		// written for and the file contains no tab characters at all.
		expect(patch.contents.slice(0, patch.contents.indexOf('"'))).toBe('    ');
		expect(patch.anchor).toBe(ALLOW_PATHS_ANCHOR);

		// The entry is the publishable root and not its parent, checked through the same
		// folding the guard uses rather than by comparing strings: `docs/site/` and `./docs/site`
		// are the spellings a comparison misses.
		expect(normaliseEntry(patch.contents.trim().slice(1, -1))).toBe(SITE_ROOT_RELATIVE);
		expect(normaliseEntry(patch.contents.trim().slice(1, -1))).not.toBe('docs');
	});

	test('the publish workflow is in the plan and named by the constant the guard reads', () => {
		// If these two drift, the allowlist assertion checks a file nobody writes and reports
		// nothing, which is the failure mode that guard exists to close.
		expect(byPath.has(PUBLISH_WORKFLOW_PATH)).toBe(true);
		expect(plan.files.filter((file) => file.path.startsWith('.github/'))).toHaveLength(1);
	});

	test('the notes say the four things a plan cannot say in a file', () => {
		expect(plan.notes.length).toBeGreaterThanOrEqual(4);
		const all = plan.notes.join('\n');
		expect(all).toContain('docs.private.json');
		expect(all).toContain('HEXDOCS_PUBLISH_ROLE');
		expect(all).toContain('HEXDOCS_BUCKET');
		expect(all).toContain('allowlist');
		expect(all).toContain('sections is empty');
	});

	test('the mount reaches every $schema path and both workflow commands', () => {
		const elsewhere = sourceScaffold({
			project: PROJECT,
			productName: PRODUCT,
			repo: REPO,
			locales: ['en'],
			kitMount: 'kcalc-web/docs',
		});
		const refs = elsewhere.files
			.filter((file) => file.path.endsWith('.json'))
			.map((file) => (parseJson(file.contents) as Record<string, string>)['$schema']);
		expect(refs.length).toBeGreaterThan(0);
		for (const reference of refs) expect(reference).toContain('docs/kit/schema/');
		for (const reference of refs) expect(reference).not.toContain('hex-docs/kit/schema/');

		const workflow = elsewhere.files.find((file) => file.path === PUBLISH_WORKFLOW_PATH);
		expect(workflow?.contents).toContain('kcalc-web/docs/kit/bin/hexdocs');
	});

	test('a title with no front matter spelling is a note, not a file it cannot write', () => {
		// The one way the index page fails to build: a product name that has to be quoted and
		// carries a double quote, which this front matter dialect implements no escape for.
		// Emitting it anyway would produce a file the compiler refuses to read, with a message
		// about a value this tool chose.
		const awkward = sourceScaffold({
			project: PROJECT,
			productName: 'Fixture: "App"',
			repo: REPO,
			locales: ['en'],
		});
		const indexPath = `${SITE_ROOT_RELATIVE}/content/en/index.md`;
		expect(awkward.files.map((file) => file.path)).not.toContain(indexPath);
		// The rest of the plan is unaffected, because one unwritable page is a fact about one
		// page.
		expect(awkward.files).toHaveLength(plan.files.length - 1);
		const note = awkward.notes.find((line) => line.startsWith(indexPath));
		expect(note).toBeDefined();
		expect(note).toContain('double quote');
	});
});
