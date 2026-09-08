import { describe, expect, test } from 'vitest';

// @ts-expect-error -- a zero-dependency .mjs guard, deliberately untyped.
import {
	blankComments,
	classifySpecifier,
	packageOf,
	scanImports,
} from '../scripts/lib/scan-imports.mjs';

describe('comment blanking', () => {
	test('never blanks real code, which is the only correctness requirement', () => {
		const source = [
			"// import { evil } from 'evil'",
			"/* import { alsoEvil } from 'also-evil' */",
			"import { real } from 'react';",
		].join('\n');
		const specifiers = scanImports(source).map((r: { specifier: string }) => r.specifier);
		expect(specifiers).toEqual(['react']);
	});

	test('a double slash inside a string is not a comment', () => {
		const source = "const u = 'https://x.dev';\nimport { a } from 'react';";
		expect(scanImports(source).map((r: { specifier: string }) => r.specifier)).toEqual(['react']);
	});

	test('a comment opener inside a regex literal does not swallow the file', () => {
		// `/a\/*b/` contains the byte pair that starts a block comment. Treating it as
		// one would blank everything after it, hiding a real import.
		const source = "const r = /a\\/*b/;\nimport { a } from 'react';";
		expect(scanImports(source).map((r: { specifier: string }) => r.specifier)).toEqual(['react']);
	});

	test('a comment opener inside a template literal does not swallow the file', () => {
		const source = 'const t = `/* not a comment */`;\n' + "import { a } from 'react';";
		expect(scanImports(source).map((r: { specifier: string }) => r.specifier)).toEqual(['react']);
	});

	test('blanking preserves length, so reported line numbers stay true', () => {
		const source = "/* four lines\n of\n comment\n here */\nimport { a } from 'react';";
		expect(blankComments(source).length).toBe(source.length);
		expect(scanImports(source)[0].line).toBe(5);
	});

	test('an unterminated quote recovers at the newline rather than blanking the rest', () => {
		const source = "const broken = 'oops\nimport { a } from 'react';";
		expect(scanImports(source).length).toBeGreaterThan(0);
	});
});

describe('specifier extraction', () => {
	test.each([
		["import a from 'x';", 'x'],
		['import a from "x";', 'x'],
		["import type { A } from 'x';", 'x'],
		["export { a } from 'x';", 'x'],
		["export * from 'x';", 'x'],
		["import 'x';", 'x'],
		["const m = await import('x');", 'x'],
		["import {\n  a,\n  b,\n} from 'x';", 'x'],
	])('%p yields %p', (source, expected) => {
		expect(scanImports(source).map((r: { specifier: string }) => r.specifier)).toContain(expected);
	});

	test('records the line and the form', () => {
		const found = scanImports("import a from 'x';\nconst m = import('y');");
		expect(found[0]).toMatchObject({ specifier: 'x', line: 1, form: 'static' });
		expect(found[1]).toMatchObject({ specifier: 'y', line: 2, form: 'dynamic' });
	});
});

describe('classification', () => {
	test.each([
		['./foo.js', 'relative'],
		['../foo.js', 'relative'],
		['node:fs', 'builtin'],
		['/abs/path.js', 'absolute'],
		['react', 'bare'],
		['@scope/pkg', 'bare'],
	])('%s is %s', (specifier, kind) => {
		expect(classifySpecifier(specifier)).toBe(kind);
	});

	test('a subpath is checked against its package', () => {
		expect(packageOf('react/jsx-runtime')).toBe('react');
		expect(packageOf('@scope/pkg/deep/path')).toBe('@scope/pkg');
		expect(packageOf('react')).toBe('react');
	});
});

describe('dynamic imports', () => {
	test('a template literal with no substitution is seen', () => {
		// The previous patterns only matched quotes, so this form was invisible to the
		// dependency gate entirely.
		const found = scanImports('const m = await import(`./thing.js`);');
		expect(found.map((r: { specifier: string }) => r.specifier)).toEqual(['./thing.js']);
		expect(found[0].form).toBe('dynamic');
	});

	test('a backtick static import is seen too', () => {
		expect(
			scanImports('import a from `react`;').map((r: { specifier: string }) => r.specifier),
		).toEqual(['react']);
	});

	test('a computed specifier is reported rather than half-read', () => {
		// The character class stops at the interpolation, so this used to be read as the
		// specifier "./locales/".
		const found = scanImports('const m = await import(`./locales/${locale}.json`);');
		expect(found.some((r: { form: string }) => r.form === 'computed')).toBe(true);
		expect(found.some((r: { specifier: string }) => r.specifier === './locales/')).toBe(false);
	});

	// Four forms the scanner used to get wrong, three of them silently. The rule now
	// matches the `import(` call site and asks whether its argument is one complete
	// literal, so all four fall out of the same decision rather than needing a pattern
	// each.
	test.each([
		['an identifier argument', 'export const load = (n: string) => import(n);'],
		['a concatenation', "await import('./locales/' + locale + '.json');"],
		['a conditional', "await import(flag ? './a.js' : './b.js');"],
		['a template with an interpolation', 'await import(`./x/${y}.js`);'],
	])('%s is reported as computed, not resolved and not dropped', (_label, source) => {
		const found = scanImports(source);
		expect(found.length).toBe(1);
		expect(found[0]?.form).toBe('computed');
		expect(found[0]?.specifier).toBe('');
	});

	test('an identifier argument used to produce no record at all, which the gate passed', () => {
		// This is the one that mattered: zero records meant every check in the
		// dependency gate had nothing to look at and reported PASS.
		expect(
			scanImports('export async function load(name: string) { return await import(name); }'),
		).not.toEqual([]);
	});

	test('a method named import is not a dynamic import', () => {
		// `\b` matches after a dot, so this was read as an import of ./not-a-module.js
		// and the diagnostic named a line containing no import at all.
		expect(scanImports("registry.import('./not-a-module.js');")).toEqual([]);
		expect(scanImports('const u = import.meta.url;')).toEqual([]);
	});

	test('an escaped quote does not truncate the specifier', () => {
		// This used to yield "./we\\", which then failed the extension rule with a
		// message quoting something that is not in the source.
		const found = scanImports("await import('./we\\'ird.js');");
		expect(found.length).toBe(1);
		expect(found[0]?.specifier).toBe("./we'ird.js");
		expect(found[0]?.form).toBe('dynamic');
	});

	test('an unterminated literal is computed, not a specifier running to end of file', () => {
		// Truncated source, a merge conflict marker, a file being written. Reading to the
		// end and calling the remainder a specifier is worse than saying it is unknown.
		const found = scanImports("await import('./unfinished");
		expect(found.length).toBe(1);
		expect(found[0]?.form).toBe('computed');
	});

	test('a newline inside a quoted literal ends it, so the scan does not run on', () => {
		// Only a backtick literal may span lines. Without this the scanner would swallow
		// everything up to the next quote, several lines away, and any import in between.
		const found = scanImports("await import('./a\n./b');\nimport './real.js';");
		expect(found.some((r: { form: string }) => r.form === 'computed')).toBe(true);
		expect(found.some((r: { specifier: string }) => r.specifier === './real.js')).toBe(true);
	});

	test('a from-clause specifier containing an interpolation is dropped, not reported', () => {
		// Static `from` cannot legally carry one, so this only fires on a false positive
		// inside a string literal, where reporting a specifier nobody wrote is noise.
		const found = scanImports('const message = `from `${name}``;');
		expect(found.some((r: { specifier: string }) => r.specifier.includes('${'))).toBe(false);
	});

	test('a plain literal argument is still read as its specifier', () => {
		for (const source of [
			"await import('./ok.js');",
			'await import("./ok.js");',
			'await import(`./ok.js`);',
			"await import( './ok.js' );",
		]) {
			expect(scanImports(source).map((r: { specifier: string }) => r.specifier)).toEqual([
				'./ok.js',
			]);
		}
	});
});
