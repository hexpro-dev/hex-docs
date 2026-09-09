/**
 * The publish workflow, read as a document rather than grepped as a string.
 *
 * Three of the four properties this file pins are properties of something that is
 * **absent**, and absence is exactly what a substring search cannot assert. `expect(text)
 * .not.toContain('paths:')` passes against a workflow with `paths-ignore:` in it, and it
 * passes against a workflow that is one long comment. So the text is parsed into a tree
 * first and the assertions are made against the tree, and every absence assertion is
 * paired with a positive control that shows the detector finds the thing when it is there.
 * A detector nobody has watched fire is a detector that proves nothing, which is the same
 * lesson `rules-fire.test.ts` is built around.
 *
 * The reader below is about forty lines and reads exactly the shape this generator emits.
 * That is deliberate rather than a shortcut: `kit/` ships two runtime dependencies and a
 * YAML parser would be a third, travelling into every app repository that mounts this
 * submodule, to read one file this package wrote itself. What it does not read is stated
 * where it is defined, and anything it meets that it does not understand throws rather
 * than being skipped, so a workflow that grew a shape this cannot see fails here instead
 * of being half examined.
 *
 * What is deliberately not covered: the workflow is never executed, so nothing here says
 * `actions/checkout@v5` exists or that `hexdocs build` succeeds on a runner. Those are
 * facts about GitHub and about the CLI, and the CLI half is covered by its own tests.
 */

import { describe, expect, test } from 'vitest';

import {
	BUCKET_VARIABLE,
	PUBLISH_WORKFLOW_PATH,
	ROLE_VARIABLE,
	publishWorkflow,
} from '../../src/templates/workflow.js';

const KIT_MOUNT = 'hex-docs';
const REGION = 'ap-southeast-2';
const OUT = '.hexdocs-bundle';

const YAML = publishWorkflow({ kitMount: KIT_MOUNT, region: REGION, out: OUT });

// ---------------------------------------------------------------------------
// a reader for the one shape this generator writes
// ---------------------------------------------------------------------------

type Node = string | Mapping | Node[];

interface Mapping {
	[key: string]: Node;
}

interface Row {
	indent: number;
	text: string;
}

/**
 * Lines that carry data, with their column.
 *
 * A comment is dropped whole and a comment after a value is not: this generator writes
 * neither, and a reader that stripped trailing `#` would silently eat a `#` inside a
 * value if one ever appeared.
 */
function rowsOf(source: string): Row[] {
	return source
		.split('\n')
		.filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
		.map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
}

/** No type coercion at all: every leaf comes back as the characters that were written. */
function scalar(text: string): Node {
	if (text.startsWith('[') && text.endsWith(']')) {
		const inner = text.slice(1, -1).trim();
		return inner === '' ? [] : inner.split(',').map((item) => scalar(item.trim()));
	}
	if (text.length >= 2 && (text.startsWith("'") || text.startsWith('"'))) {
		if (text.endsWith(text[0] as string)) return text.slice(1, -1);
	}
	return text;
}

class Reader {
	private at = 0;

	constructor(private readonly rows: Row[]) {}

	block(indent: number): Node {
		const first = this.rows[this.at];
		if (first === undefined || first.indent < indent) return {};
		return first.text.startsWith('- ') ? this.sequence(indent) : this.mapping(indent);
	}

	private mapping(indent: number): Mapping {
		const map: Mapping = {};
		for (;;) {
			const row = this.rows[this.at];
			if (row === undefined || row.indent < indent) break;
			if (row.indent > indent) throw new Error(`indent this reader does not follow: ${row.text}`);
			const colon = row.text.indexOf(':');
			if (colon === -1) throw new Error(`not a mapping entry: ${row.text}`);
			const key = row.text.slice(0, colon);
			const rest = row.text.slice(colon + 1).trim();
			this.at += 1;
			if (rest !== '') {
				map[key] = scalar(rest);
				continue;
			}
			const next = this.rows[this.at];
			map[key] = next !== undefined && next.indent > indent ? this.block(next.indent) : {};
		}
		return map;
	}

	private sequence(indent: number): Node[] {
		const items: Node[] = [];
		for (;;) {
			const row = this.rows[this.at];
			if (row === undefined || row.indent < indent || !row.text.startsWith('- ')) break;
			// The item's first line is rewritten as an ordinary line at the column its text
			// really starts at, so `- uses: x` and the `with:` under it read as one mapping.
			this.rows[this.at] = { indent: indent + 2, text: row.text.slice(2) };
			items.push(this.block(indent + 2));
		}
		return items;
	}
}

function parse(source: string): Mapping {
	const reader = new Reader(rowsOf(source));
	const root = reader.block(0);
	if (Array.isArray(root) || typeof root === 'string') throw new Error('the document is not a map');
	return root;
}

function mapAt(node: Node | undefined, ...path: string[]): Mapping {
	let here = node;
	for (const key of path) {
		if (here === undefined || typeof here === 'string' || Array.isArray(here)) {
			throw new Error(`no map at ${path.join('.')}`);
		}
		here = here[key];
	}
	if (here === undefined || typeof here === 'string' || Array.isArray(here)) {
		throw new Error(`no map at ${path.join('.')}`);
	}
	return here;
}

/** Every key in the document, at every depth, so an absence can be asserted over all of it. */
function keysOf(node: Node): string[] {
	if (typeof node === 'string') return [];
	if (Array.isArray(node)) return node.flatMap(keysOf);
	return Object.entries(node).flatMap(([key, value]) => [key, ...keysOf(value)]);
}

const DOCUMENT = parse(YAML);

// ---------------------------------------------------------------------------
// the reader itself, before anything is asserted with it
// ---------------------------------------------------------------------------

describe('the reader in this file', () => {
	test('reads the nesting, the sequences and the inline list', () => {
		const document = parse(
			[
				'# a comment',
				'name: probe',
				'on:',
				'  push:',
				'    branches: [main, next]',
				'  workflow_dispatch:',
				'jobs:',
				'  publish:',
				'    steps:',
				'      - uses: actions/checkout@v5',
				'        with:',
				'          # why',
				'          fetch-depth: 0',
				'      - run: echo hi',
				'',
			].join('\n'),
		);
		expect(document['name']).toBe('probe');
		expect(mapAt(document, 'on', 'push')['branches']).toEqual(['main', 'next']);
		// A key with nothing under it is an empty map, not a missing key: `workflow_dispatch:`
		// is how a workflow declares a manual trigger and it has no value.
		expect(mapAt(document, 'on')['workflow_dispatch']).toEqual({});
		const steps = mapAt(document, 'jobs', 'publish')['steps'];
		expect(Array.isArray(steps)).toBe(true);
		expect(steps).toEqual([
			{ uses: 'actions/checkout@v5', with: { 'fetch-depth': '0' } },
			{ run: 'echo hi' },
		]);
	});

	test('throws on a shape it does not read rather than skipping the line', () => {
		// The property that makes every absence assertion below worth anything. A reader that
		// skipped what it did not understand would report no `paths` key in a workflow whose
		// `paths` key it could not parse.
		expect(() => parse(['on:', '  push:', '    - not a mapping entry', ''].join('\n'))).toThrow(
			/not a mapping entry/,
		);
	});
});

// ---------------------------------------------------------------------------
// no paths filter
// ---------------------------------------------------------------------------

describe('the trigger', () => {
	test('is every push to main with no paths filter anywhere in the document', () => {
		const push = mapAt(DOCUMENT, 'on', 'push');
		// Both directions on the trigger's own keys, so a filter added beside `branches` fails
		// here even if it were spelled something this test does not name.
		expect(Object.keys(push)).toEqual(['branches']);
		expect(push['branches']).toEqual(['main']);
		expect(Object.keys(mapAt(DOCUMENT, 'on'))).toEqual(['push', 'workflow_dispatch']);

		// And over the whole document, because a filter can also be written under the job.
		const keys = keysOf(DOCUMENT);
		expect(keys).not.toContain('paths');
		expect(keys).not.toContain('paths-ignore');
	});

	test('and the check that says so can see a filter when there is one', () => {
		// The positive control. Without it "no paths key" is satisfied by a walker that
		// returns an empty list, which is what a refactor of `keysOf` would produce silently.
		const filtered = YAML.replace(
			'    branches: [main]',
			['    branches: [main]', "    paths: ['docs/**']"].join('\n'),
		);
		expect(filtered).not.toBe(YAML);
		expect(keysOf(parse(filtered))).toContain('paths');
	});

	test('workflow_dispatch is declared, so a sha with no bundle can be built by hand', () => {
		expect(mapAt(DOCUMENT, 'on')['workflow_dispatch']).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// the clone
// ---------------------------------------------------------------------------

describe('the checkout', () => {
	const steps = mapAt(DOCUMENT, 'jobs', 'publish')['steps'] as Node[];
	const checkout = steps
		.map((step) => (typeof step === 'string' || Array.isArray(step) ? {} : step))
		.find((step) => String(step['uses'] ?? '').startsWith('actions/checkout@'));

	test('fetches the whole history, because a shallow clone dates every file the same', () => {
		expect(checkout).toBeDefined();
		const options = mapAt(checkout as Mapping, 'with');
		// `0` and not `1`, and not absent. Translation freshness is a comparison of committer
		// dates: under the default depth of 1 every file carries the clone's own date, the
		// whole corpus reads `current`, and no stale translation is ever reported.
		expect(options['fetch-depth']).toBe('0');
		// The submodule is the toolchain. Without it there is no hexdocs to run at all.
		expect(options['submodules']).toBe('true');
	});

	test('every action is pinned to a major rather than to a moving tag', () => {
		const used = steps
			.map((step) => (typeof step === 'string' || Array.isArray(step) ? {} : step))
			.map((step) => step['uses'])
			.filter((value): value is string => typeof value === 'string');
		expect(used.length).toBeGreaterThan(0);
		for (const action of used) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@v\d+$/);
	});
});

// ---------------------------------------------------------------------------
// the credentials
// ---------------------------------------------------------------------------

describe('the permissions and the credentials', () => {
	test('are OIDC and exactly OIDC', () => {
		const permissions = mapAt(DOCUMENT, 'permissions');
		// Both directions. `id-token: write` is what mints the token the credentials step
		// exchanges; a third permission added here is a widening nobody asked for.
		expect(permissions).toEqual({ 'id-token': 'write', contents: 'read' });
	});

	test('read the role from a repository variable and never from a secret', () => {
		const steps = mapAt(DOCUMENT, 'jobs', 'publish')['steps'] as Node[];
		const credentials = steps
			.map((step) => (typeof step === 'string' || Array.isArray(step) ? {} : step))
			.find((step) =>
				String(step['uses'] ?? '').startsWith('aws-actions/configure-aws-credentials@'),
			);
		expect(credentials).toBeDefined();
		const options = mapAt(credentials as Mapping, 'with');
		expect(options['role-to-assume']).toBe(`\${{ vars.${ROLE_VARIABLE} }}`);
		// The region is a literal for the opposite reason: it names no account and grants
		// nothing, so making it a variable would be a third thing to configure.
		expect(options['aws-region']).toBe(REGION);

		// Nothing in the file reads a long-lived key. A key in a repository secret outlives
		// whoever added it and is valid from anywhere.
		expect(YAML).not.toContain('secrets.');
	});

	test('one publish at a time, never cancelled', () => {
		// A cancelled run can leave a prefix holding some objects and no manifest, which
		// reads downstream as a bundle that exists and cannot be verified.
		expect(mapAt(DOCUMENT, 'concurrency')).toEqual({
			group: 'docs-publish',
			'cancel-in-progress': 'false',
		});
	});
});

// ---------------------------------------------------------------------------
// nothing in here names an account
// ---------------------------------------------------------------------------

describe('what the file must never carry', () => {
	// hex-docs is a public repository and an app repository may have a public mirror, so
	// the pair an attacker would want is the bucket name and the role ARN. Neither is here.
	const ACCOUNT_ID = /\d{12}/;
	const ARN = /arn:aws:/;

	test('no account id, no ARN, and no bucket name', () => {
		expect(ACCOUNT_ID.test(YAML)).toBe(false);
		expect(ARN.test(YAML)).toBe(false);
		// Both names reach the file as variable references and as nothing else, which is what
		// makes the check above hold for a repository this generator has never seen.
		expect(YAML).toContain(`\${{ vars.${BUCKET_VARIABLE} }}`);
		expect(YAML).toContain(`\${{ vars.${ROLE_VARIABLE} }}`);
	});

	test('and the two patterns match what they are for, so a clean scan means something', () => {
		// The positive control again. `\d{12}` inside a template literal is one edit away from
		// matching nothing, and a scan that cannot fail is a green row over an unread file.
		// The fake id is assembled from two halves rather than written out, for the same
		// reason `ATTRIBUTION_PATTERNS` in `scripts/lint.mjs` spells its needles `C[l]aude`.
		// That guard fails on a twelve digit run anywhere in this repository, so a positive
		// control carrying one would be a file the repository-wide scan reports, and the only
		// ways out of that are an exemption naming this file or a weaker rule. Splitting the
		// literal costs one line and keeps both guards unqualified.
		const leaked = YAML.replace(
			`\${{ vars.${ROLE_VARIABLE} }}`,
			`arn:aws:iam::${'01234567'}${'8901'}:role/hexdocs-publish`,
		);
		expect(ACCOUNT_ID.test(leaked)).toBe(true);
		expect(ARN.test(leaked)).toBe(true);
	});

	test('every GitHub expression in the file is one of the two variable reads', () => {
		const expressions = [...YAML.matchAll(/\$\{\{[^}]*\}\}/g)].map((match) => match[0]);
		expect(new Set(expressions)).toEqual(
			new Set([`\${{ vars.${ROLE_VARIABLE} }}`, `\${{ vars.${BUCKET_VARIABLE} }}`]),
		);
		// Two reads, each written once. A third would be a third thing to configure before
		// the first publish, and this is the assertion that would name it.
		expect(expressions).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// the two commands
// ---------------------------------------------------------------------------

describe('the steps that do the work', () => {
	const steps = mapAt(DOCUMENT, 'jobs', 'publish')['steps'] as Node[];
	const runs = steps
		.map((step) => (typeof step === 'string' || Array.isArray(step) ? {} : step))
		.filter((step) => typeof step['run'] === 'string');

	test('build then publish, both through the mounted toolchain', () => {
		expect(runs.map((step) => step['run'])).toEqual([
			`${KIT_MOUNT}/kit/bin/hexdocs build --out ${OUT}`,
			`${KIT_MOUNT}/kit/bin/hexdocs publish ${OUT}`,
		]);
	});

	test('the bucket reaches publish through the environment', () => {
		const publish = runs[1] as Mapping;
		expect(mapAt(publish, 'env')).toEqual({ [BUCKET_VARIABLE]: `\${{ vars.${BUCKET_VARIABLE} }}` });
	});

	test('a different mount moves both commands and the pnpm lockfile lookup', () => {
		// kcalc mounts the submodule at `kcalc-web/docs`, so a path assumed rather than
		// measured is a failed publish in the one repository that is not laid out like the
		// others.
		const elsewhere = parse(
			publishWorkflow({ kitMount: 'kcalc-web/docs', region: REGION, out: OUT }),
		);
		const steps = mapAt(elsewhere, 'jobs', 'publish')['steps'] as Node[];
		const text = JSON.stringify(steps);
		expect(text).toContain('kcalc-web/docs/kit/bin/hexdocs build');
		expect(text).toContain('kcalc-web/docs/kit/bin/hexdocs publish');
		expect(text).toContain('kcalc-web/docs/kit/package.json');
		expect(text).not.toContain('hex-docs/kit');
	});
});

test('the workflow has exactly one home, because GitHub reads no other directory', () => {
	expect(PUBLISH_WORKFLOW_PATH).toBe('.github/workflows/docs-publish.yml');
});
