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
			// The first three are type-only modules: no statements exist to cover and v8
			// reports them as 0%.
			//
			// `scripts/check-stack.mjs` is the only exclusion here that is not a file with
			// nothing in it, so its reason is written out rather than left to be inferred.
			// Every row it has is a call against a real account: five `s3api` reads, an
			// Access Analyzer validation per rendered document, three simulations per
			// publisher and a caller identity. Nothing a suite without credentials can do
			// reaches any of them, and the states that are reachable are the three that end
			// the run before the first call, which `test/infra.test.ts` drives.
			//
			// Everything underneath those calls moved to `scripts/lib/policy-diff.mjs` in
			// step 6 and is held at a real number there, which is where a bug would
			// actually be: a wrong policy comparison reports no drift on a bucket policy
			// that has changed, and that is the one control in the stack binding the
			// account root user. What covers what is left is `pnpm check:stack` against a
			// real account after every apply, and not this suite. It is the same division
			// `kit/test/s3/` already makes for `publish` and `prefetch`.
			//
			// A floor written over this file instead would be a floor set by what cannot be
			// tested rather than by what is, and it would pull two other numbers down with
			// it. Measured after the split: 231 statements at 13.4%, which takes
			// `scripts/*.mjs` from 90.5 to 74.2 and the project statement figure from 95.2
			// to 88.1.
			exclude: [
				'src/contracts/exact.ts',
				'src/index.ts',
				'src/contracts/index.ts',
				'scripts/check-stack.mjs',
			],
			reporter: ['text-summary', 'json-summary'],
			// Each number is a point or two under what the suite actually reaches, so a
			// real regression fails and a whitespace change does not. They go up when the
			// suite improves; they never come down to match a bad run.
			thresholds: {
				// A floor for the whole project, so a directory added after step 1 arrives
				// covered rather than arriving exempt. Without it, a new `src/render/` would
				// match no glob and be held to nothing. Measured at step 3: 1148/1181
				// statements, 605/675 branches, 161/163 functions, 1036/1065 lines.
				// At step 4: 1750/1823 statements, 1016/1124 branches, 312/323 functions,
				// 1570/1626 lines. The functions floor came down a point when
				// `scripts/check-paint.mjs` landed: it drives a real browser, and two of its
				// helpers only run on a path that needs a broken stylesheet and a launch
				// failure at the same time. The row it feeds is what covers it in anger.
				//
				// Step 5 moved functions and lines down half a point each, from 96 to 95, and
				// the cause is the same shape one step along: `scripts/check-cli.mjs` spawns
				// the real launcher and the real MCP server, so its own error arms need a
				// broken environment to reach. `test/cli-surface.test.ts` drives four of them
				// against a doctored copy of the repository, which is what the number below
				// is measured with; what is left needs a launcher that starts and then dies
				// mid-handshake.
				//
				// Step 6 moved branches down a point, from 88 to 87, and the cause is the same
				// shape a third time: `scripts/check-infra.mjs` runs `terraform fmt`, `validate`
				// and `test` and reads what each of them printed, and 43 of its 163 branches are
				// the arms that answer a terraform which started and then failed in one
				// particular way. `test/infra.test.ts` drives its mutations through it and every
				// one of them is a terraform that worked. The project branch figure was 1064/1194
				// before that module landed, so the point this floor loses is the one that module
				// costs and nothing else.
				//
				// Re-measured after the step 6 review fixes, which added a second git-history row
				// to the house lint and a resolved run-as-main predicate to the ladder: 2348/2466
				// statements, 1298/1474 branches, 437/454 functions, 2088/2181 lines. Every floor
				// still clears, and branches moved up rather than down.
				//
				// Re-measured at step 8, after the step 8 review fixes: 2655/2766 statements,
				// 1479/1642 branches, 479/495 functions, 2355/2440 lines.
				statements: 95,
				branches: 87,
				functions: 95,
				lines: 95,

				// The contracts are where a bug is silent rather than loud: a schema that
				// stopped validating a field does not throw, it publishes. Re-measured at step 8:
				// 519/520 statements, 262/272 branches, 83/83 functions, 472/473 lines.
				// Counts rather than percentages, so an edit that changes a denominator
				// makes a stale comment self-evident. Branches sits lowest because of
				// unreachable defensive arms in `unhandledNode` and the slug comparator's
				// total-order tail.
				'src/contracts/**': { statements: 99, branches: 94, functions: 100, lines: 99 },

				// The shared reporter, the import scanner and, since step 6, the policy
				// comparison the stack guard reads a bucket policy with. Re-measured after the
				// step 6 review: 317/320 statements, 246/269 branches, 56/57 functions, 272/274
				// lines. What is
				// uncovered is colour output, which only differs on a TTY, and two
				// `instanceof Error` arms behind a `JSON.parse` that can throw nothing else.
				'scripts/lib/**': { statements: 97, branches: 87, functions: 95, lines: 97 },

				// The one module in this directory where a bug is silent rather than loud, so
				// it is held on its own rather than averaged into the group above. A wrong
				// comparison here reports no drift on a bucket policy that has actually
				// changed, which is a green row over a store whose write-once guarantee has
				// gone, and the bucket policy is the only control in the stack that binds the
				// account root user. Re-measured after the step 6 review, which added the
				// identifier scrub and the decision reader: 140/140 statements, 106/109
				// branches, 32/32 functions, 120/120 lines. The three uncovered branches are
				// the two
				// `instanceof Error` arms above and the implicit else of `formatPath`'s chain,
				// which is a path element Access Analyzer's own model does not have.
				//
				// Nothing in it spawns anything, so there is no arm here that needs a broken
				// machine and no reason for any of these to be lower.
				'scripts/lib/policy-diff.mjs': {
					statements: 100,
					branches: 95,
					functions: 100,
					lines: 100,
				},

				// The tokeniser and the BM25 client, which the compiler and the browser both
				// run. Re-measured at step 6: 158/159 statements, 67/69 branches, 27/27
				// functions, 134/135 lines. Held high because every failure in search is silent: an index built
				// with one tokeniser and queried with another returns nothing, in one
				// language, with no error.
				'src/search/**': { statements: 99, branches: 97, functions: 100, lines: 99 },

				// The address, notice, direction and id rules the consuming site reads outside
				// a React tree, and since step 8 the docs server and the root's SEO read.
				// Re-measured at step 8, after the step 8 review fixes: 429/429 statements,
				// 294/296 branches, 73/73 functions, 359/359 lines. Held at the top because every
				// function here takes contract types and injected sources and returns a string, a
				// small object or a `Response`, so there is nothing in it that is expensive to
				// cover. `serve.ts`
				// is every one of its refusals driven by `test/site/serve.test.ts`, because a
				// defensive arm nobody has run is one nobody has seen work. The two uncovered
				// branches are `labelOf`'s last fallback in `route.ts`, a nav entry with no record
				// in the reader's locale or the source's, which the compiler never writes: a
				// page with no source-locale file gets no page record at all.
				//
				// Branches is 98 and not the 95 it was at step 6, because 95 let four
				// `serve.test.ts` tests be skipped with no threshold error while four `serve.ts`
				// branches went dark. Over 296 branches, 98 fails when four more are lost beyond
				// the two above and not when three are, which is as close under the measurement
				// as a floor can sit without one new defensive arm being a failure.
				'src/site/**': { statements: 100, branches: 98, functions: 100, lines: 100 },

				// The React half. Re-measured at step 8: 265/285 statements, 177/195 branches,
				// 91/96 functions, 235/248 lines. It sits a little below the project floor and
				// the reason is named here rather than left to be inferred.
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
				// index, the reading estimate and llms.txt. Re-measured at step 8: 58/58
				// statements, 35/35 branches, 8/8 functions, 50/50 lines. Every branch is
				// reached, the `unhandledNode` arms for node types this AST major does not have
				// included.
				'src/ast/**': { statements: 100, branches: 90, functions: 100, lines: 100 },

				// The hand-run guards, each of which spawns something. Re-measured at step 8,
				// after the step 8 review fixes: 873/959 statements 91.03, 365/472 branches
				// 77.33, 132/142 functions 92.96, 802/870 lines 92.18, across `lint.mjs`,
				// `check-imports.mjs`, `check-paint.mjs`, `check-cli.mjs`, `verify.mjs` and, since
				// step 6, `check-infra.mjs`.
				// `check-stack.mjs` is not in the group because it is not in the report at all,
				// and the exclusion above says why.
				//
				// The floors came down when `check-cli.mjs` joined the group in step 5, and
				// the reason is worth stating rather than absorbing: these are the only
				// modules in the repository whose job is to run other programs, so their
				// uncovered arms are the ones that need a missing browser, a launcher that
				// starts and dies, a catalogue that is present and malformed, or a terraform
				// that answers with something no correct one would. Each has a test driving
				// its failure paths against a doctored copy (`test/paint.test.ts`,
				// `test/cli-surface.test.ts`, `test/guards.test.ts`, `test/infra.test.ts`),
				// which is what these numbers are measured with. Holding them higher would
				// mean simulating a broken machine rather than testing a guard.
				//
				// Branches is the one to watch, and it is said here rather than left to be
				// found. It was 344 of 450 at step 6, four tenths of a point over the floor, and
				// the tight module was `check-infra.mjs` at 120 of 163. Re-measured at step 8,
				// after `check-cli.mjs` grew the first-run row that installs the kit inside a
				// pnpm workspace, and the `scripts/verify.mjs` diagnostic line: 873/959
				// statements, 365/472 branches, 132/142 functions, 802/870 lines, so branches now
				// clear by a point and a third. Raising the floor to the measurement would make a
				// rounding change a failure, and lowering it would be lowering a floor to fit a
				// module whose failure paths are in fact tested, so it stays at 76.
				'scripts/*.mjs': { statements: 88, branches: 76, functions: 88, lines: 89 },
			},
		},
	},
});
