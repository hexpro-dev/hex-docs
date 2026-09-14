/**
 * Editing JSON that a person also edits, without reformatting it.
 *
 * The inputs are the real byte shapes from `fixtures/consumers.ts` rather than examples
 * written for the test, because every failure this module exists to prevent is a property
 * of those exact bytes: hex-web's `tsconfig.json` carries block comments inside `paths`,
 * its `deploy.config.json` packs three directory names onto one line, and its
 * `pnpm-workspace.yaml` quotes an exclusion because the consumer's own guard matches that
 * literal string including the quotes. Neither repository has prettier installed, so
 * nothing would put any of that back.
 *
 * Two rules are asserted throughout rather than once. **Every helper returns `null` when
 * its anchor is missing or is not unique**, because "I cannot find exactly one place to
 * put this" is knowable where "this file was hand-edited" is not, and a guess writes into
 * somebody's build configuration. And **an edit changes only what it names**: the
 * assertions are byte comparisons against the original with one substitution, not
 * `JSON.parse` round trips, which is the comparison that would pass for a reserialiser.
 */

import { describe, expect, test } from 'vitest';

import {
	GLOB_WORKSPACE,
	LITERAL_WORKSPACE,
	type ConsumerFile,
	type ConsumerShape,
} from '../../../fixtures/consumers.js';
import {
	appendToArray,
	arrayElements,
	detectIndent,
	findValue,
	insertBefore,
	lineIndentAt,
	removeMember,
	rootSpan,
	setMember,
	stripComments,
} from '../../src/io/jsonc.js';

const FILES: Record<ConsumerShape, readonly ConsumerFile[]> = {
	'glob-workspace': GLOB_WORKSPACE,
	'literal-workspace': LITERAL_WORKSPACE,
};

function fileOf(shape: ConsumerShape, path: string): string {
	const found = FILES[shape].find((file) => file.path === path);
	if (found === undefined) throw new Error(`${shape} has no ${path}`);
	return found.contents;
}

const TSCONFIG = fileOf('glob-workspace', 'apps/front/tsconfig.json');
const BARE_TSCONFIG = fileOf('literal-workspace', 'kcalc-web/front/tsconfig.json');
const DEPLOY = fileOf('glob-workspace', 'deploy.config.json');
const DEPLOY_NO_FRONT = fileOf('literal-workspace', 'deploy.config.json');
const WORKSPACE = fileOf('glob-workspace', 'pnpm-workspace.yaml');
const MCP = fileOf('glob-workspace', '.mcp.json');

/** The span of a dotted path, or a failure naming the path rather than `undefined`. */
function span(text: string, path: string): { start: number; end: number } {
	const found = findValue(text, path);
	if (found === null) throw new Error(`no unique value at "${path}"`);
	return found;
}

// ---------------------------------------------------------------------------
// stripComments
// ---------------------------------------------------------------------------

describe('stripComments', () => {
	test('leaves a // inside a string alone, which is what a plain replace gets wrong', () => {
		// hex-web's tsconfig has URLs in its comments and this estate's configs carry them in
		// values. A scanner that blanked from the first `//` would cut the rest of the line
		// out of a value, and the result would still be valid JSON with a shorter string.
		const text = '{\n\t"docs": "https://example.invalid/a//b", // the note\n\t"n": 1\n}\n';
		const stripped = stripComments(text);
		expect(stripped).toContain('"https://example.invalid/a//b"');
		expect(stripped).not.toContain('the note');
		expect(JSON.parse(stripped)).toEqual({ docs: 'https://example.invalid/a//b', n: 1 });
	});

	test('an escaped quote does not end the string it is inside', () => {
		const text = '{\n\t"a": "he said \\"// not a comment\\" and stopped"\n}\n';
		expect(stripComments(text)).toBe(text);
	});

	test('blanks a block comment and keeps the file parseable', () => {
		const stripped = stripComments(TSCONFIG);
		expect(stripped).not.toContain('image converter');
		expect(JSON.parse(stripped)).toEqual({
			extends: '../../config/tsconfig.front.json',
			compilerOptions: {
				baseUrl: '.',
				rootDirs: ['.', '.react-router/types'],
				paths: {
					'~/*': ['./app/*'],
					'@hexpro/google-auth-secret-retriever': [
						'../../common/google-auth-secret-retriever/src/index.ts',
					],
					'@hexpro/google-auth-secret-retriever/dom': [
						'../../common/google-auth-secret-retriever/src/dom/index.ts',
					],
					'@hexpro/private-image-converter': ['../../common/private-image-converter/src/index.ts'],
					'@hexpro/private-image-converter/formats': [
						'../../common/private-image-converter/src/formats.ts',
					],
					'@hexpro/private-image-converter/dom': [
						'../../common/private-image-converter/src/dom/index.ts',
					],
				},
			},
			include: ['app/**/*.ts', 'app/**/*.tsx', 'app/types/**/*.d.ts', '.react-router/types/**/*'],
		});
	});

	test('the length and every newline survive, for every file both consumers carry', () => {
		// The property every scanner below rests on: an index means the same character in the
		// stripped text and in the original, so a span found in one can slice the other.
		// Deleting the comment bytes instead, which is what `check-tools.mjs` does, moves
		// every index after the first comment and silently relocates every edit.
		let swept = 0;
		for (const files of Object.values(FILES)) {
			for (const file of files) {
				const stripped = stripComments(file.contents);
				expect([file.path, stripped.length]).toEqual([file.path, file.contents.length]);
				expect([file.path, (stripped.match(/\n/g) ?? []).length]).toEqual([
					file.path,
					(file.contents.match(/\n/g) ?? []).length,
				]);
				swept += 1;
			}
		}
		expect(swept).toBe(GLOB_WORKSPACE.length + LITERAL_WORKSPACE.length);
	});

	test('a file with no comments comes back byte for byte', () => {
		// The control. Without it every assertion above is satisfied by a function that
		// returns its input, and the parse assertions would still pass on the bare JSON.
		expect(stripComments(BARE_TSCONFIG)).toBe(BARE_TSCONFIG);
		expect(stripComments(DEPLOY)).toBe(DEPLOY);
	});

	test('an unterminated block comment blanks to the end, so the parse reports it', () => {
		const text = '{\n\t"a": 1 /* and then nothing closes it\n}\n';
		const stripped = stripComments(text);
		expect(stripped).toHaveLength(text.length);
		expect(() => JSON.parse(stripped) as unknown).toThrow();
	});

	test('a slash that opens nothing is left where it is', () => {
		expect(stripComments('{"a": "x/y"}')).toBe('{"a": "x/y"}');
	});

	test('a YAML glob is read as opening a block comment, which is the honest limit', () => {
		// `common/*` on line 3 of the real `pnpm-workspace.yaml` opens what this reads as a
		// block comment, and nothing closes it, so everything after it is blanked. That is
		// stated in the module rather than worked around, and it is exactly why
		// `InsertOptions.commaBefore` is a request the JSON callers make rather than
		// something deduced from the file. The test below pins the consequence.
		const stripped = stripComments(WORKSPACE);
		expect(WORKSPACE).toContain('- common/*');
		expect(stripped).not.toContain('apps/front');
		expect(stripped).toHaveLength(WORKSPACE.length);
	});
});

// ---------------------------------------------------------------------------
// detectIndent and lineIndentAt
// ---------------------------------------------------------------------------

describe('detectIndent', () => {
	test.each([
		['a tab-indented tsconfig', TSCONFIG, '\t'],
		['a tab-indented deploy config', DEPLOY, '\t'],
		['a tab-indented mcp config', MCP, '\t'],
		['a two-space YAML file', WORKSPACE, '  '],
		['a four-space JSON file', '{\n    "a": 1\n}\n', '    '],
	])('reports %s as it is written', (_name, text, expected) => {
		expect(detectIndent(text)).toBe(expected);
	});

	test('a leading block comment cannot be mistaken for a one-space indent', () => {
		// The continuation line of a block comment starts with a single space and a star, so
		// a reader that scanned the raw text would call this file one-space indented and every
		// insert would be written at the wrong depth.
		const text = '/*\n * A note about this file.\n */\n{\n    "a": 1\n}\n';
		expect(detectIndent(text)).toBe('    ');
	});

	test('a file with no indented line at all defaults to a tab', () => {
		expect(detectIndent('{}\n')).toBe('\t');
		expect(detectIndent('')).toBe('\t');
	});
});

describe('lineIndentAt', () => {
	test('reports the whitespace before the line the index sits on', () => {
		const at = TSCONFIG.indexOf('"baseUrl"');
		expect(lineIndentAt(TSCONFIG, at)).toBe('\t\t');
		expect(lineIndentAt(WORKSPACE, WORKSPACE.indexOf('- config'))).toBe('  ');
	});

	test('the first line of a file has no indent and does not read past the start', () => {
		expect(lineIndentAt(TSCONFIG, 0)).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Locating things
// ---------------------------------------------------------------------------

describe('rootSpan and findValue', () => {
	test('the root of an object file is the whole object', () => {
		const root = rootSpan(TSCONFIG);
		expect(root).not.toBeNull();
		expect(TSCONFIG.slice(root?.start ?? 0, root?.end ?? 0)).toBe(TSCONFIG.trimEnd());
	});

	test('a file that is not a JSON object has no root', () => {
		expect(rootSpan(WORKSPACE)).toBeNull();
		expect(rootSpan('[1, 2]')).toBeNull();
		expect(rootSpan('{ "a": [1 }')).toBeNull();
	});

	test('a dotted path reaches a nested value, and the slice is the value itself', () => {
		const at = span(DEPLOY, 'hash.extra_dirs.front');
		expect(DEPLOY.slice(at.start, at.end)).toBe(
			[
				'[',
				'\t\t\t\t"common/ui", "common/i18n", "common/blog",',
				'\t\t\t\t"common/google-auth-secret-retriever",',
				'\t\t\t\t"common/private-image-converter"',
				'\t\t\t]',
			].join('\n'),
		);
	});

	test('a segment that names nothing, or names two things, is null rather than a guess', () => {
		expect(findValue(DEPLOY, 'hash.extra_dirs.worker')).toBeNull();
		expect(findValue(DEPLOY, 'hash.nothing.here')).toBeNull();
		// A file with the same key twice cannot be edited without choosing which one the
		// reader meant, and JSON.parse would silently take the last.
		expect(findValue('{"a": 1, "a": 2}', 'a')).toBeNull();
		expect(JSON.parse('{"a": 1, "a": 2}')).toEqual({ a: 2 });
	});

	test('a path into a non-object is null, not an exception', () => {
		expect(findValue(DEPLOY, 'hash.extra_dirs.front.0')).toBeNull();
	});
});

describe('arrayElements', () => {
	test('finds every element of a hand-packed array, in order', () => {
		const elements = arrayElements(DEPLOY, span(DEPLOY, 'hash.extra_dirs.front'));
		expect(elements?.map((element) => DEPLOY.slice(element.start, element.end))).toEqual([
			'"common/ui"',
			'"common/i18n"',
			'"common/blog"',
			'"common/google-auth-secret-retriever"',
			'"common/private-image-converter"',
		]);
	});

	test('an empty array has no elements, which is not the same as not being an array', () => {
		const text = '{\n\t"a": []\n}\n';
		expect(arrayElements(text, span(text, 'a'))).toEqual([]);
		expect(arrayElements(DEPLOY, span(DEPLOY, 'hash'))).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// appendToArray
// ---------------------------------------------------------------------------

describe('appendToArray', () => {
	test('puts the entry on its own line at the last element indent, leaving the packing alone', () => {
		// Line 245 of the real `deploy.config.json` puts three directory names on one line and
		// the two long ones on their own, so the array's indentation is not the entry's: the
		// line the last element starts on is the only thing that says how deep a new one sits.
		const next = appendToArray(DEPLOY, 'hash.extra_dirs.front', '"common/docs"');
		expect(next).toBe(
			[
				'{',
				'\t"sites": {',
				'\t\t"pro": {',
				'\t\t\t"projects": {',
				'\t\t\t\t"api": {',
				'\t\t\t\t\t"path": "pro/api",',
				'\t\t\t\t\t"build": "encore"',
				'\t\t\t\t},',
				'\t\t\t\t"front": {',
				'\t\t\t\t\t"path": "pro/front",',
				'\t\t\t\t\t"build": "docker"',
				'\t\t\t\t},',
				'\t\t\t\t"database": {',
				'\t\t\t\t\t"path": "pro/database"',
				'\t\t\t\t}',
				'\t\t\t}',
				'\t\t},',
				'\t\t"apps": {',
				'\t\t\t"projects": {',
				'\t\t\t\t"api": {',
				'\t\t\t\t\t"path": "apps/api",',
				'\t\t\t\t\t"build": "encore"',
				'\t\t\t\t},',
				'\t\t\t\t"front": {',
				'\t\t\t\t\t"path": "apps/front",',
				'\t\t\t\t\t"build": "docker"',
				'\t\t\t\t},',
				'\t\t\t\t"database": {',
				'\t\t\t\t\t"path": "apps/database"',
				'\t\t\t\t}',
				'\t\t\t}',
				'\t\t}',
				'\t},',
				'\t"hash": {',
				'\t\t"exclude_dirs": [',
				'\t\t\t"node_modules", ".encore", "encore.gen", ".react-router",',
				'\t\t\t"build", "dist", ".git", ".DS_Store"',
				'\t\t],',
				'\t\t"extra_dirs": {',
				'\t\t\t"front": [',
				'\t\t\t\t"common/ui", "common/i18n", "common/blog",',
				'\t\t\t\t"common/google-auth-secret-retriever",',
				'\t\t\t\t"common/private-image-converter",',
				'\t\t\t\t"common/docs"',
				'\t\t\t]',
				'\t\t}',
				'\t}',
				'}',
				'',
			].join('\n'),
		);
	});

	test('the array the file already had is unchanged except for the added entry', () => {
		const next = appendToArray(DEPLOY, 'hash.extra_dirs.front', '"common/docs"') ?? '';
		expect(JSON.parse(next)).toEqual({
			sites: {
				pro: {
					projects: {
						api: { path: 'pro/api', build: 'encore' },
						front: { path: 'pro/front', build: 'docker' },
						database: { path: 'pro/database' },
					},
				},
				apps: {
					projects: {
						api: { path: 'apps/api', build: 'encore' },
						front: { path: 'apps/front', build: 'docker' },
						database: { path: 'apps/database' },
					},
				},
			},
			hash: {
				exclude_dirs: [
					'node_modules',
					'.encore',
					'encore.gen',
					'.react-router',
					'build',
					'dist',
					'.git',
					'.DS_Store',
				],
				extra_dirs: {
					front: [
						'common/ui',
						'common/i18n',
						'common/blog',
						'common/google-auth-secret-retriever',
						'common/private-image-converter',
						'common/docs',
					],
				},
			},
		});
		// And the exclusion array beside it was not touched at all, which a reserialiser
		// would have reflowed onto eight lines.
		expect(next).toContain(
			'\t\t\t"node_modules", ".encore", "encore.gen", ".react-router",\n' +
				'\t\t\t"build", "dist", ".git", ".DS_Store"\n',
		);
	});

	test('an array that is not there is null, which is what the second consumer needs', () => {
		// kcalc's `extra_dirs` has only a `worker` key, so the `front` key has to be created
		// rather than appended to, and an append that invented one would produce a config the
		// deploy reads as unchanged.
		expect(appendToArray(DEPLOY_NO_FRONT, 'hash.extra_dirs.front', '"common/docs"')).toBeNull();
		expect(appendToArray(DEPLOY, 'hash.extra_dirs', '"common/docs"')).toBeNull();
		expect(appendToArray(WORKSPACE, 'packages', '"x"')).toBeNull();
	});

	test('an empty array gets the file own indent unit', () => {
		const text = '{\n  "a": []\n}\n';
		expect(appendToArray(text, 'a', '"x"')).toBe('{\n  "a": [\n    "x"\n  ]\n}\n');
	});

	test('a comment after the last element refuses rather than writing a comma into it', () => {
		const text = '{\n\t"a": [\n\t\t"one" // the only one\n\t]\n}\n';
		expect(appendToArray(text, 'a', '"two"')).toBeNull();
	});

	test('an entry that would not parse is refused, which is what makes verbatim safe', () => {
		// `entry` is inserted as written, so a caller passing a bare value rather than
		// `JSON.stringify(value)` is the ordinary mistake. The result is parsed before it is
		// returned, so the mistake is a null rather than a corrupted config.
		expect(appendToArray(DEPLOY, 'hash.extra_dirs.front', 'common/docs')).toBeNull();
		expect(appendToArray(DEPLOY, 'hash.extra_dirs.front', '}')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// setMember
// ---------------------------------------------------------------------------

describe('setMember', () => {
	test('adds a path entry to a tsconfig whose paths object carries block comments', () => {
		const next = setMember(
			TSCONFIG,
			span(TSCONFIG, 'compilerOptions.paths'),
			'@hex-pro/docs',
			'["../../common/docs/src/index.ts"]',
		);
		expect(next).toBe(
			[
				'{',
				'\t"extends": "../../config/tsconfig.front.json",',
				'\t"compilerOptions": {',
				'\t\t"baseUrl": ".",',
				'\t\t"rootDirs": [".", ".react-router/types"],',
				'\t\t"paths": {',
				'\t\t\t"~/*": ["./app/*"],',
				'\t\t\t/* The QR/authenticator package, resolved to its TypeScript source.',
				'\t\t\t *',
				'\t\t\t * It is a submodule (see pnpm-workspace.yaml) whose package `exports`',
				'\t\t\t * point at a `dist/` that nothing in this repo builds, and the deploy',
				'\t\t\t * never runs `pnpm install` \u2014 it builds in the working tree \u2014 so an',
				'\t\t\t * install-time compile step would be unreliable by construction.',
				'\t\t\t * Mapping straight to the source makes `pnpm dev`, `pnpm build`,',
				'\t\t\t * `pnpm typecheck` and the deploy behave identically, and',
				'\t\t\t * `vite-tsconfig-paths` turns this into the matching Vite alias so the',
				'\t\t\t * compiler and the bundler cannot disagree. Nothing commits a `dist/`,',
				'\t\t\t * so removing these entries fails loudly rather than quietly serving a',
				'\t\t\t * stale artefact.',
				'\t\t\t */',
				'\t\t\t"@hexpro/google-auth-secret-retriever": [',
				'\t\t\t\t"../../common/google-auth-secret-retriever/src/index.ts"',
				'\t\t\t],',
				'\t\t\t"@hexpro/google-auth-secret-retriever/dom": [',
				'\t\t\t\t"../../common/google-auth-secret-retriever/src/dom/index.ts"',
				'\t\t\t],',
				'\t\t\t/* The image converter, on the same terms and for the same reasons.',
				'\t\t\t * See the note above; nothing about it differs except the name.',
				'\t\t\t */',
				'\t\t\t"@hexpro/private-image-converter": [',
				'\t\t\t\t"../../common/private-image-converter/src/index.ts"',
				'\t\t\t],',
				'\t\t\t"@hexpro/private-image-converter/formats": [',
				'\t\t\t\t"../../common/private-image-converter/src/formats.ts"',
				'\t\t\t],',
				'\t\t\t"@hexpro/private-image-converter/dom": [',
				'\t\t\t\t"../../common/private-image-converter/src/dom/index.ts"',
				'\t\t\t],',
				'\t\t\t"@hex-pro/docs": ["../../common/docs/src/index.ts"]',
				'\t\t}',
				'\t},',
				'\t"include": [',
				'\t\t"app/**/*.ts",',
				'\t\t"app/**/*.tsx",',
				'\t\t"app/types/**/*.d.ts",',
				'\t\t".react-router/types/**/*"',
				'\t]',
				'}',
				'',
			].join('\n'),
		);
	});

	test('creates a key the second consumer does not have, at that file own depth', () => {
		const next = setMember(
			DEPLOY_NO_FRONT,
			span(DEPLOY_NO_FRONT, 'hash.extra_dirs'),
			'front',
			'["common/docs"]',
		);
		expect(next).toBe(
			[
				'{',
				'\t"sites": {',
				'\t\t"kcalc": {',
				'\t\t\t"projects": {',
				'\t\t\t\t"api": {',
				'\t\t\t\t\t"path": "kcalc-web/api",',
				'\t\t\t\t\t"build": "custom"',
				'\t\t\t\t},',
				'\t\t\t\t"front": {',
				'\t\t\t\t\t"path": "kcalc-web/front",',
				'\t\t\t\t\t"build": "docker"',
				'\t\t\t\t},',
				'\t\t\t\t"database": {',
				'\t\t\t\t\t"path": "kcalc-web/database"',
				'\t\t\t\t}',
				'\t\t\t}',
				'\t\t}',
				'\t},',
				'\t"hash": {',
				'\t\t"exclude_dirs": [',
				'\t\t\t"node_modules", ".encore", "encore.gen", ".react-router",',
				'\t\t\t"build", "dist", ".git", ".DS_Store"',
				'\t\t],',
				'\t\t"extra_dirs": {',
				'\t\t\t"worker": ["kcalc-web/database", "kcalc-web/push", "recipe-core", "dockerfiles"],',
				'\t\t\t"front": ["common/docs"]',
				'\t\t}',
				'\t}',
				'}',
				'',
			].join('\n'),
		);
	});

	test('replacing an existing member touches its value and nothing else', () => {
		const next = setMember(TSCONFIG, span(TSCONFIG, 'compilerOptions'), 'baseUrl', '"./app"') ?? '';
		expect(next).toBe(TSCONFIG.replace('"baseUrl": ".",', '"baseUrl": "./app",'));
		// The comment above the other member is still there, in one piece.
		expect(next).toContain(
			' * compiler and the bundler cannot disagree. Nothing commits a `dist/`,',
		);
	});

	test('the before option matches the key order a real config already has', () => {
		// `hexdocs sync` writes `hidden` above `pages`, which is the order the one checked-in
		// example of its output carries. A command that appended it below would produce a file
		// that differs from its own example on every run.
		const text = '{\n\t"a": 1,\n\t"pages": []\n}\n';
		expect(setMember(text, span(text, ''), 'hidden', '["x"]', { before: 'pages' })).toBe(
			'{\n\t"a": 1,\n\t"hidden": ["x"],\n\t"pages": []\n}\n',
		);
	});

	test('before naming a member that is not there falls back to last, as documented', () => {
		// Stated rather than refused: the named member being absent is the ordinary case for a
		// config that has not been synced yet, and last is what happens with no option at all.
		const text = '{\n\t"a": 1\n}\n';
		expect(setMember(text, span(text, ''), 'hidden', '["x"]', { before: 'pages' })).toBe(
			'{\n\t"a": 1,\n\t"hidden": ["x"]\n}\n',
		);
	});

	test('an empty object gets a body at the detected indent', () => {
		const text = '{\n  "a": {}\n}\n';
		expect(setMember(text, span(text, 'a'), 'b', '1')).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
	});

	test('a key that appears twice, or a before that does, is null rather than a guess', () => {
		const twice = '{\n\t"a": 1,\n\t"a": 2\n}\n';
		expect(setMember(twice, span(twice, ''), 'a', '3')).toBeNull();
		const beforeTwice = '{\n\t"p": 1,\n\t"p": 2\n}\n';
		expect(setMember(beforeTwice, span(beforeTwice, ''), 'n', '3', { before: 'p' })).toBeNull();
	});

	test('a comment after the last member refuses, because the comma would land inside it', () => {
		const text = '{\n\t"a": 1 // the only one\n}\n';
		expect(setMember(text, span(text, ''), 'b', '2')).toBeNull();
	});

	test('a span that is not an object is null', () => {
		expect(setMember(DEPLOY, span(DEPLOY, 'hash.extra_dirs.front'), 'a', '1')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// removeMember
// ---------------------------------------------------------------------------

describe('removeMember', () => {
	test('takes the member and the comma that joins it, and leaves the rest packed', () => {
		const text = '{\n\t"a": 1,\n\t"b": 2,\n\t"c": 3\n}\n';
		expect(removeMember(text, span(text, ''), 'b')).toBe('{\n\t"a": 1,\n\t"c": 3\n}\n');
		expect(removeMember(text, span(text, ''), 'a')).toBe('{\n\t"b": 2,\n\t"c": 3\n}\n');
		expect(removeMember(text, span(text, ''), 'c')).toBe('{\n\t"a": 1,\n\t"b": 2\n}\n');
	});

	test('the only member leaves an empty object', () => {
		const text = '{\n\t"a": 1\n}\n';
		expect(removeMember(text, span(text, ''), 'a')).toBe('{}\n');
	});

	test('a member that is not there returns the text, which is not the same as null', () => {
		// The one helper here whose missing anchor is not a refusal, because removal is a
		// statement about the end state and the text already is that end state. Asserted
		// explicitly so the difference from every other function in this module is deliberate
		// rather than inherited.
		const text = '{\n\t"a": 1\n}\n';
		expect(removeMember(text, span(text, ''), 'zzz')).toBe(text);
	});

	test('two members with the same key, or a comment in the cut, are null', () => {
		const twice = '{\n\t"a": 1,\n\t"a": 2\n}\n';
		expect(removeMember(twice, span(twice, ''), 'a')).toBeNull();
		const commented = '{\n\t"a": 1,\n\t// why b is here\n\t"b": 2\n}\n';
		expect(removeMember(commented, span(commented, ''), 'b')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// insertBefore
// ---------------------------------------------------------------------------

describe('insertBefore', () => {
	test('inserts into a YAML file above the one line that matches, trimmed', () => {
		// The exclusion is double quoted because the consumer's own guard matches that literal
		// string including the quotes, so this is a place `pnpm format` must never reach and a
		// place a reserialiser cannot go.
		const next = insertBefore(WORKSPACE, '- apps/front', [
			'  # The docs submodule, deliberately not a workspace member.',
			'  - "!common/docs"',
		]);
		expect(next).toBe(
			[
				'packages:',
				'  - config',
				'  - common/*',
				'  # Deliberately not a workspace member, despite living under common/.',
				'  #',
				'  # It is a submodule of its own repository (@hexpro/google-auth-secret-retriever,',
				'  # published to npm) with its own lockfile, its own CI and its own toolchain.',
				'  # Enrolling it here would make `pnpm install` inside that directory install this',
				"  # whole monorepo and ignore the lockfile the package's CI is pinned to.",
				'  #',
				'  # apps/front consumes its TypeScript source through one `paths` entry in',
				'  # apps/front/tsconfig.json, which is what resolves it in both tsc and Vite. Its',
				'  # package `exports` point at a `dist/` that nothing here builds, so a',
				'  # `workspace:*` link would resolve to nothing. It has no runtime dependencies,',
				"  # so there is nothing to install on the site's behalf either.",
				'  - "!common/google-auth-secret-retriever"',
				'  # Excluded for the same reasons as the package above: its own repository, its',
				'  # own lockfile, its own CI, and a `dist/` that nothing here builds. apps/front',
				'  # consumes its TypeScript source through `paths` entries in',
				'  # apps/front/tsconfig.json.',
				'  - "!common/private-image-converter"',
				'  - pro/database',
				'  - pro/api',
				'  - pro/front',
				'  - games/database',
				'  - games/api',
				'  - games/front',
				'  - citadel/database',
				'  - citadel/api',
				'  - citadel/front',
				'  - apps/database',
				'  - apps/api',
				'  # The docs submodule, deliberately not a workspace member.',
				'  - "!common/docs"',
				'  - apps/front',
				'',
				'onlyBuiltDependencies:',
				'  - esbuild',
				'',
			].join('\n'),
		);
	});

	test('a matcher that hits nothing, or hits twice, is null', () => {
		// A closing brace matches three lines of the tsconfig once trimmed, which is exactly
		// the case a string matcher cannot resolve and a caller has to pin with a pattern.
		expect(insertBefore(TSCONFIG, '}', ['\t\t\t"x": []'])).toBeNull();
		expect(insertBefore(TSCONFIG, '- nothing like this', ['x'])).toBeNull();
	});

	test('a pattern pins the indentation of one closing brace among many', () => {
		const inserted = '\t\t\t"@hex-pro/docs": ["x"]';
		const lines = (insertBefore(TSCONFIG, /^\t\t\}$/, [inserted]) ?? '').split('\n');
		const closing = lines.indexOf('\t\t}');
		expect(closing).toBeGreaterThan(0);
		expect(lines[closing - 1]).toBe(inserted);
		expect(lines.filter((line) => line === inserted)).toHaveLength(1);
	});

	test('commaBefore adds one comma and never a second', () => {
		const text = '{\n\t"a": [\n\t\t"one"\n\t]\n}\n';
		expect(insertBefore(text, ']', ['\t\t"two"'], { commaBefore: true })).toBe(
			'{\n\t"a": [\n\t\t"one",\n\t\t"two"\n\t]\n}\n',
		);
		const already = '{\n\t"a": [\n\t\t"one",\n\t]\n}\n';
		expect(insertBefore(already, ']', ['\t\t"two"'], { commaBefore: true })).toBe(
			'{\n\t"a": [\n\t\t"one",\n\t\t"two"\n\t]\n}\n',
		);
		const empty = '{\n\t"a": [\n\t]\n}\n';
		expect(insertBefore(empty, ']', ['\t\t"one"'], { commaBefore: true })).toBe(
			'{\n\t"a": [\n\t\t"one"\n\t]\n}\n',
		);
	});

	test('commaBefore keeps whatever followed the value on that line', () => {
		const text = '{\n\t"a": [\n\t\t"one"   \n\t]\n}\n';
		expect(insertBefore(text, ']', ['\t\t"two"'], { commaBefore: true })).toBe(
			'{\n\t"a": [\n\t\t"one",   \n\t\t"two"\n\t]\n}\n',
		);
	});

	test('commaBefore refuses when that line carries a comment', () => {
		// Putting the comma before the comment is a guess about which of them the author meant
		// to keep beside the value, and putting it after swallows it.
		const text = '{\n\t"a": [\n\t\t"one" // the only one\n\t]\n}\n';
		expect(insertBefore(text, ']', ['\t\t"two"'], { commaBefore: true })).toBeNull();
		// Without the option the same insert is fine, which is what makes the refusal about
		// the comma rather than about the comment.
		expect(insertBefore(text, ']', ['\t\t"two"'])).not.toBeNull();
	});

	test('commaBefore on the YAML file refuses, which is the blanking limit reaching a caller', () => {
		// `common/*` opens what `stripComments` reads as a block comment, so every line after
		// it looks commented and the comma check refuses. The option is documented as
		// belonging to the JSON callers and this is why: it is a request, not a deduction.
		expect(
			insertBefore(WORKSPACE, '- apps/front', ['  - "!common/docs"'], { commaBefore: true }),
		).toBeNull();
	});

	test('a CRLF file keeps its line endings', () => {
		// Mixing the two is invisible in a diff viewer and shows up as a whole-file change in
		// somebody else's editor.
		const text = '{\r\n\t"a": [\r\n\t\t"one"\r\n\t]\r\n}\r\n';
		expect(insertBefore(text, ']', ['\t\t"two"'], { commaBefore: true })).toBe(
			'{\r\n\t"a": [\r\n\t\t"one",\r\n\t\t"two"\r\n\t]\r\n}\r\n',
		);
		expect(appendToArray(text, 'a', '"two"')).toBe(
			'{\r\n\t"a": [\r\n\t\t"one",\r\n\t\t"two"\r\n\t]\r\n}\r\n',
		);
	});
});

// ---------------------------------------------------------------------------
// The .mcp.json shape, which is the one file both consumers already have servers in
// ---------------------------------------------------------------------------

describe('the mcp config', () => {
	test('a server is added beside the ones already there, with theirs untouched', () => {
		const next = setMember(
			MCP,
			span(MCP, 'mcpServers'),
			'hexdocs',
			'{ "command": "node", "args": ["common/docs/kit/bin/hexdocs", "mcp"] }',
		);
		expect(next).toBe(
			[
				'{',
				'\t"mcpServers": {',
				'\t\t"encore-mcp": {',
				'\t\t\t"command": "encore",',
				'\t\t\t"args": ["mcp", "run"]',
				'\t\t},',
				'\t\t"shadcn": {',
				'\t\t\t"command": "pnpx",',
				'\t\t\t"args": ["shadcn@latest", "mcp"]',
				'\t\t},',
				'\t\t"cloudflare": {',
				'\t\t\t"command": "pnpx",',
				'\t\t\t"args": ["mcp-remote", "https://docs.mcp.cloudflare.com/mcp"]',
				'\t\t},',
				'\t\t"hexdocs": { "command": "node", "args": ["common/docs/kit/bin/hexdocs", "mcp"] }',
				'\t}',
				'}',
				'',
			].join('\n'),
		);
	});
});
