/**
 * What a consumer's templates pass this package typechecks without a cast or a wrapper,
 * checked by the compiler.
 *
 * A type-level claim with no runtime statement cannot fail a runtime test, and the obvious
 * home for it cannot fail the typecheck either: `tsconfig.test.json` extends `tsconfig.json`
 * and inherits its `exclude`, which lists `test`, so nothing under `test/` is compiled by
 * `pnpm typecheck`. So this test compiles `test/types/consumer.ts` itself, with the test
 * configuration's own options, and fails on any diagnostic in it.
 *
 * The positive control is what makes a clean result mean something. A checker that could
 * not resolve `react-router`, or that was handed the wrong file, reports nothing for the
 * real assertions too, so the same program is asked to accept a link component returning a
 * symbol, which is not a React node, and has to refuse it by code.
 */

import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { REPO_ROOT } from '../support/golden.js';

const ASSERTIONS = join(REPO_ROOT, 'test', 'types', 'consumer.ts');
const PROBE = join(REPO_ROOT, 'test', 'types', '__refused__.ts');
const PROBE_TEXT = [
	"import type { DocsLinkComponent } from '../../src/render/context.js';",
	"export const refused: DocsLinkComponent = () => Symbol('not a node');",
].join('\n');

function compile(): Map<string, readonly ts.Diagnostic[]> {
	const read = ts.readConfigFile(join(REPO_ROOT, 'tsconfig.test.json'), ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT);
	const host = ts.createCompilerHost(parsed.options);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (name, version, ...rest) =>
		name === PROBE
			? ts.createSourceFile(name, PROBE_TEXT, version)
			: getSourceFile(name, version, ...rest);
	const fileExists = host.fileExists.bind(host);
	host.fileExists = (name) => name === PROBE || fileExists(name);
	const program = ts.createProgram({
		rootNames: [ASSERTIONS, PROBE],
		options: parsed.options,
		host,
	});
	const found = new Map<string, readonly ts.Diagnostic[]>();
	for (const name of [ASSERTIONS, PROBE]) {
		const source = program.getSourceFile(name);
		expect(source, `${name} was not part of the program`).toBeDefined();
		found.set(name, ts.getPreEmitDiagnostics(program, source));
	}
	return found;
}

describe('what a consumer passes', () => {
	const diagnostics = compile();

	test("React Router's Link and Vite's globs are accepted exactly as the templates pass them", () => {
		const messages = (diagnostics.get(ASSERTIONS) ?? []).map(
			(diagnostic) =>
				`TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
		);
		expect(messages).toEqual([]);
	});

	test('the same program refuses a link component that returns something other than a node', () => {
		const codes = (diagnostics.get(PROBE) ?? []).map((diagnostic) => diagnostic.code);
		expect(codes).toContain(2322);
	});
});
