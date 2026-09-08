import { defineConfig } from 'vitest/config';

/**
 * The runtime half's suite.
 *
 * Tests live in `test/`, mirroring `src/`, rather than beside the code. That is what
 * lets `scripts/check-imports.mjs` have no exemptions: there is no file under `src/`
 * allowed to import something a consumer will not have, so there is no rule for
 * anyone to widen. It also keeps test files out of what a website compiles.
 */
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			// `fixtures/` is not here on purpose. It is test input, like `test/` itself,
			// and holding it to a coverage floor would reward writing tests for the
			// corpus reader rather than for the corpus. What keeps it honest instead is
			// that both suites read it and both fail on a declaration with no file or a
			// file with no declaration.
			include: ['src/**/*.ts', 'scripts/**/*.mjs'],
			// Type-only modules have no statements to cover and v8 reports them as 0%.
			exclude: ['src/contracts/exact.ts', 'src/index.ts', 'src/contracts/index.ts'],
			reporter: ['text-summary', 'json-summary'],
			// Each number is a point or two under what the suite actually reaches, so a
			// real regression fails and a whitespace change does not. They go up when the
			// suite improves; they never come down to match a bad run.
			thresholds: {
				// A floor for the whole project, so a directory added after step 1 arrives
				// covered rather than arriving exempt. Without it, a new `src/render/` would
				// match no glob and be held to nothing. Measured 1148/1181 statements,
				// 605/675 branches, 161/163 functions, 1036/1065 lines.
				statements: 96,
				branches: 88,
				functions: 97,
				lines: 96,

				// The contracts are where a bug is silent rather than loud: a schema that
				// stopped validating a field does not throw, it publishes. Measured
				// 475/477 statements, 243/258 branches, 77/77 functions, 431/433 lines.
				// Counts rather than percentages, so an edit that changes a denominator
				// makes a stale comment self-evident. Branches sits lowest because of
				// unreachable defensive arms in `unhandledNode` and the slug comparator's
				// total-order tail.
				'src/contracts/**': { statements: 99, branches: 94, functions: 100, lines: 99 },

				// The shared reporter and the import scanner. Measured 175/178 statements,
				// 138/156 branches, 23/24 functions, 151/153 lines. What is uncovered is
				// colour output, which only differs on a TTY.
				'scripts/lib/**': { statements: 97, branches: 87, functions: 95, lines: 97 },

				// The tokeniser and the BM25 client, which the compiler and the browser both
				// run. Measured 151/152 statements, 60/61 branches, 27/27 functions, 129/130
				// lines. Held high because every failure in search is silent: an index built
				// with one tokeniser and queried with another returns nothing, in one
				// language, with no error.
				'src/search/**': { statements: 99, branches: 97, functions: 100, lines: 99 },

				// Flattening the tree back to text, for the table of contents, the search
				// index, the reading estimate and llms.txt. Measured 58/58 statements, 32/35
				// branches, 8/8 functions, 50/50 lines. The three uncovered branches are the
				// `unhandledNode` arms for node types this AST major does not have.
				'src/ast/**': { statements: 100, branches: 90, functions: 100, lines: 100 },

				// The guards, driven against a deliberately broken fixture, a throwaway git
				// repository and a shallow clone as well as against this repository.
				// Measured 287/314 statements, 132/165 branches, 25/26 functions, 273/297
				// lines. Branches sits lowest because each guard has arms for filesystem
				// states this repository cannot be in, such as an unreadable directory.
				'scripts/*.mjs': { statements: 90, branches: 78, functions: 95, lines: 90 },
			},
		},
	},
});
