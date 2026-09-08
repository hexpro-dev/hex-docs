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
		// `.tsx` as well as `.ts`. Measured with the installed picomatch:
		// `test/**/*.test.ts` does not match `test/render/page.test.tsx`, so a suite added
		// under the old glob would collect zero tests and the ladder would report PASS on a
		// smaller number. `test/config.test.ts` asserts both globs against a `.tsx` path.
		include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
		// `node` everywhere except the handful of files that carry a
		// `@vitest-environment happy-dom` docblock, which are the tests that drive the
		// search dialog and the copy button. The declaration is in the file rather than in
		// a glob here, so the one thing that must never be written against happy-dom is
		// refused where somebody would write it: measured this session, it resolves a CSS
		// custom property at the point of use rather than at the point of declaration,
		// which is the opposite of what a browser does, so a theme test written against it
		// passes on the exact stylesheet bug `src/contracts/theme.ts` exists to prevent.
		// jsdom is no better and does not resolve `var()` at all. The token contract is
		// checked in a real browser by `scripts/check-paint.mjs` and nowhere else.
		environment: 'node',

		coverage: {
			provider: 'v8',
			// `fixtures/` is not here on purpose. It is test input, like `test/` itself,
			// and holding it to a coverage floor would reward writing tests for the
			// corpus reader rather than for the corpus. What keeps it honest instead is
			// that both suites read it and both fail on a declaration with no file or a
			// file with no declaration.
			include: ['src/**/*.ts', 'src/**/*.tsx', 'scripts/**/*.mjs'],
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
				// Measured 1750/1823 statements, 1016/1124 branches, 312/323 functions,
				// 1570/1626 lines. The functions floor came down a point when
				// `scripts/check-paint.mjs` landed: it drives a real browser, and two of its
				// helpers only run on a path that needs a broken stylesheet and a launch
				// failure at the same time. The row it feeds is what covers it in anger.
				statements: 95,
				branches: 88,
				functions: 96,
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

				// The address, notice, direction and id rules the consuming site reads outside
				// a React tree. Measured 30/30 statements, 27/28 branches, 12/12 functions,
				// 27/27 lines. Held at the top because every function here is pure, takes a
				// contract type and returns a string or a small object, so there is nothing
				// in it that is expensive to cover and nothing that is unreachable. The one
				// uncovered branch is the equal arm of `docsLocalisedPaths`'s comparator,
				// which cannot fire because two pages cannot share a slug: the same
				// total-order tail `src/contracts/**` already carries.
				'src/site/**': { statements: 100, branches: 95, functions: 100, lines: 100 },

				// The React half. Measured 246/272 statements, 170/191 branches, 87/93
				// functions, 220/238 lines. It sits a little below the project floor and the
				// reason is named here rather than left to be inferred.
				//
				// Everything uncovered is browser-only: `renderToStaticMarkup` produces the
				// markup an `onClick` is attached to and never calls it, and an effect never
				// runs at all. Most of that gap is closed by the files under
				// `test/render/dom/`, which drive the search dialog and the copy button under
				// happy-dom. What is left is the small residue those cannot reach, chiefly
				// the media-query listener and the focus and scroll calls in
				// `useNavigationAnnounce`, which need a viewport rather than a document.
				//
				// One thing must never move into that directory to lift these numbers.
				// Measured this session: happy-dom resolves a CSS custom property at the point
				// of use rather than at the point of declaration, which is the opposite of
				// what a browser does, so a theme test written against it passes on the exact
				// stylesheet bug `src/contracts/theme.ts` exists to prevent. jsdom is worse
				// and does not resolve `var()` at all. That check belongs to a real browser.
				'src/render/**': { statements: 89, branches: 87, functions: 92, lines: 91 },

				// The seven-language string tables and the plural rules. Measured 36/36
				// statements, 33/34 branches, 9/9 functions, 31/31 lines. The uncovered
				// branch is `pluralForm`'s fallback to `other`, which the parity test in
				// `test/ui/strings.test.ts` makes unreachable by refusing a table that omits
				// a category its language uses.
				'src/ui/**': { statements: 100, branches: 96, functions: 100, lines: 100 },

				// Flattening the tree back to text, for the table of contents, the search
				// index, the reading estimate and llms.txt. Measured 58/58 statements, 32/35
				// branches, 8/8 functions, 50/50 lines. The three uncovered branches are the
				// `unhandledNode` arms for node types this AST major does not have.
				'src/ast/**': { statements: 100, branches: 90, functions: 100, lines: 100 },

				// The guards, driven against a deliberately broken fixture, a throwaway git
				// repository, a shallow clone and, for the paint check, a stylesheet with the
				// aliasing defect deliberately reintroduced, as well as against this
				// repository. Measured 305/336 statements, 155/195 branches, 22/24 functions,
				// 292/317 lines.
				// Measured 287/314 statements, 132/165 branches, 25/26 functions, 273/297
				// lines. Branches sits lowest because each guard has arms for filesystem
				// states this repository cannot be in, such as an unreadable directory.
				'scripts/*.mjs': { statements: 90, branches: 78, functions: 91, lines: 91 },
			},
		},
	},
});
