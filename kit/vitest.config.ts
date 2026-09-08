import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',

		// Test files materialise the fixture corpus in a `beforeAll`: a tree copy, a git
		// init and eight replayed commits. Measured on an idle machine when this was
		// written, three runs: 1451ms, 1444ms, 1434ms. So the default 10s is not tight
		// because the corpus is slow, it is tight because these hooks run in parallel
		// worker threads on a machine doing other things, and four of them were seen to
		// blow it at once on a loaded laptop. What made that worth a config entry rather
		// than a shrug is how vitest reports it: the tests in a file whose hook timed out
		// are counted as SKIPPED, and a skipped test reads like a decision. This
		// repository's own rule is that a check which examined nothing is a failure, so the
		// number is set far above the measurement rather than to a margin over it.
		//
		// Re-measured in step 5, because the prediction in the paragraph above came true.
		// Twenty-seven files materialise the corpus now rather than seven, on fourteen
		// cores, and the heaviest hook is `test/wiring/checks-fire.test.ts`, which applies
		// eighty-two consumer mutations and then compiles the corpus twice: 8.92s and 8.98s
		// in isolation, against a whole-suite wall time of 65s under coverage. It blew 60s
		// once inside `pnpm verify`, where the runtime suite runs immediately before it,
		// and passed on the next run, which is the worst available state: a flaky timeout
		// that reports eighty-eight tests as a decision somebody made.
		//
		// So the number tracks the heaviest hook rather than the mean, and it is
		// deliberately far above any duration that is not a hang. The cost of it being too
		// high is that a genuine hang takes five minutes to surface; the cost of it being
		// too low is a green ladder over a file that never ran.
		hookTimeout: 300_000,

		// The same argument for the tests themselves, and the reason it is not left at the
		// 5s default is worth stating because the row it produced was actively misleading.
		// `compiling twice produces identical bytes` runs two full builds, measured at
		// 532ms, 504ms and 490ms each on an idle machine, and under a loaded run it went
		// over 5000ms and reported as a failure of byte reproducibility. That is the one
		// property in this package a red row must never be able to claim falsely, because
		// the honest failure it looks like is the write-once refusal firing on a re-run
		// that changed nothing. Doubled in step 5 for the same reason as the hook above:
		// the slowest test measured 60.9s under a loaded full run and passed in 13.1s in
		// isolation.
		testTimeout: 120_000,
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			// Assertions only: no statements exist to cover, and it runs under tsc.
			exclude: ['src/contracts/drift.ts', 'src/contracts/index.ts'],
			reporter: ['text-summary', 'json-summary'],
			// A point or two under what the suite reaches, so a real regression fails and
			// a whitespace change does not.
			thresholds: {
				// A floor for the whole half, so a directory added after step 1 arrives
				// covered rather than matching no glob and being held to nothing.
				//
				// It moved by two hundredths of a point in step 5, from 95/88 to 94/87, and
				// the honest reason is worth more than the number: step 5 roughly doubled
				// this half, and the two directories it added that carry real error handling
				// (`commands` and `wiring`) sit lower than the compiler does, for the reason
				// their own entries below give. Every one of the eleven new directories has a
				// floor of its own measured against what its suite reaches, so the global is
				// a backstop for a directory nobody has written an entry for rather than the
				// thing holding step 5 up.
				statements: 94,
				branches: 87,
				functions: 96,
				lines: 96,

				// The schemas are the last thing standing between a malformed bundle and a
				// published one, and a schema that stopped checking a field does not throw.
				// Measured 97.3 statements, 89.7 branches, 97.7 functions, 97.8 lines. What
				// is uncovered is the emitter's run-as-main guard, which by definition does
				// not run under the suite, and the two refinement arms in `basePath` that
				// only fire on input the earlier regex already refused.
				'src/contracts/**': { statements: 96, branches: 88, functions: 95, lines: 97 },

				// The compiler. Measured 1244/1276 statements, 718/785 branches, 169/172
				// functions, 1100/1121 lines across the whole of it. The floors below are per
				// directory rather than one number, because the three parts fail differently
				// and a single figure would let the loudest one carry the quietest.
				'src/compile/**': { statements: 96, branches: 89, functions: 97, lines: 97 },

				// The highlighter is the one part where a miss is a character lost out of
				// published code, and no eyeball review catches a dropped backslash, so it is
				// held at everything. Measured 286/286, 239/239, 24/24, 248/248.
				'src/compile/highlight/**': {
					statements: 100,
					branches: 100,
					functions: 100,
					lines: 100,
				},

				// The parser. Measured 752/806 statements, 421/487 branches, 65/65 functions,
				// 698/732 lines. Branches sits lowest because a recursive descent parser is
				// mostly branches, and the uncovered ones are the recovery arms for source
				// this corpus does not contain: a fence that ends at end of file inside a
				// list, a table row with no cells.
				'src/compile/markdown/**': { statements: 93, branches: 86, functions: 100, lines: 95 },

				// ---------------------------------------------------------------
				// Step 5: the CLI, the MCP server and the consumer wiring.
				//
				// Every number below is the first measured run rounded down, and each says
				// what is uncovered rather than only what is covered. Where a directory is
				// held at everything, that is because a miss there is silent.
				// ---------------------------------------------------------------

				// The tables everything else is derived from, so a miss is an MCP tool whose
				// JSON Schema does not match its CLI flags, which is silent on both surfaces.
				// Measured whole: 100 across all four.
				'src/registry/**': { statements: 100, branches: 100, functions: 100, lines: 100 },

				// The security boundary. An uncovered arm of the recipe table is an arm
				// nobody tested, and the whole point of the table is that widening it is
				// visible. Measured 100 statements, 88.9 branches: what is left is the two
				// arms of `runRecipe`'s arity check that only fire on a caller that has
				// already been refused by the type.
				'src/exec/**': { statements: 100, branches: 88, functions: 100, lines: 100 },

				// The file templates, held at everything for the same reason as the
				// highlighter: a wrong byte here lands in somebody else's repository, and no
				// eyeball review catches a dropped `fetch-depth: 0`. Measured whole.
				'src/templates/**': { statements: 100, branches: 100, functions: 100, lines: 100 },

				// The public mirror allowlist reader, which is the one module standing
				// between an internal documentation tree and a public repository. Measured
				// 96.9/90/100/100. The uncovered arms are two refusal paths reachable only
				// by calling private functions directly, which would assert that a defence
				// exists rather than that it does anything.
				'src/source/**': { statements: 96, branches: 90, functions: 100, lines: 100 },

				// Measured 93.7/98/84.2/95.7. The odd shape is real: `protocol.ts` is whole,
				// and `server.ts` carries the transport wiring that only a spawned process
				// reaches, where v8 collects no coverage. `kit/test/mcp/protocol.test.ts`
				// drives that path as a child and `scripts/check-cli.mjs` drives it again
				// from the ladder, so it is covered by something that is not this number.
				'src/mcp/**': { statements: 93, branches: 97, functions: 84, lines: 95 },

				// Measured 95/85.2/91.4/95.7. Uncovered: the run-as-main guard, which by
				// definition does not run under the suite, and the colour branch, which
				// `verify.mjs` spawns every step with `NO_COLOR` set to avoid.
				'src/cli/**': { statements: 94, branches: 85, functions: 91, lines: 95 },

				// The consumer wiring. Held above the package floor because the failure mode
				// is a green row over a broken install, which is the exact class this
				// repository's counting rule exists to catch. Measured 92.1/84.6/99.3/96.9;
				// the uncovered branches are the unreadable-file arms of several probes,
				// where the row fails either way.
				'src/wiring/**': { statements: 92, branches: 84, functions: 99, lines: 96 },

				// The widest surface with the most error arms, and the lowest numbers in the
				// package for the same reason `src/compile/lint/**` is: several of those arms
				// are network failures a recording fake can only produce in the shapes
				// somebody thought of. Measured 90.9/78.7/92.1/91.9.
				'src/commands/**': { statements: 90, branches: 78, functions: 92, lines: 91 },

				// Every branch is coverable because `Exec` is injected. Measured
				// 92/84.9/100/91.6, and what is left is the malformed-response arms of the
				// list and head parsers, which a fake can reach and a real bucket cannot.
				'src/s3/**': { statements: 91, branches: 84, functions: 100, lines: 91 },

				// Measured 93.5/89.7/100/97.5. The uncovered arms are `stripComments`'s
				// unterminated-block recovery and one `detectIndent` fallback.
				'src/io/**': { statements: 93, branches: 89, functions: 100, lines: 97 },

				// Two functions over five files, plus a deliberately narrow front matter
				// reader whose refusals are all exercised. Measured 97.8/91.7/100/100.
				'src/skills/**': { statements: 97, branches: 91, functions: 100, lines: 100 },

				// The rules. Measured 605/637 statements, 294/349 branches, 87/91 functions,
				// 518/539 lines. Branches is the lowest number in the package because every
				// heuristic rule carries arms for text the corpus does not have, and because
				// the registry is data rather than code: a rule with no implementation has an
				// entry here and no branch anywhere.
				'src/compile/lint/**': { statements: 94, branches: 83, functions: 95, lines: 95 },
			},
		},
	},
});
