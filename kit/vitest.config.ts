import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',

		// Seven test files materialise the fixture corpus in a `beforeAll`: a tree copy, a
		// git init and eight replayed commits. Measured on an idle machine, three runs:
		// 1451ms, 1444ms, 1434ms. So the default 10s is not tight because the corpus is
		// slow, it is tight because these hooks run in parallel worker threads on a machine
		// doing other things, and four of them were seen to blow it at once on a loaded
		// laptop. What made that worth a config entry rather than a shrug is how vitest
		// reports it: the 123 tests in a file whose hook timed out are counted as SKIPPED,
		// and a skipped test reads like a decision. This repository's own rule is that a
		// check which examined nothing is a failure, so the one number here is set to
		// forty times the measurement rather than to a margin over it.
		hookTimeout: 60_000,

		// The same argument for the tests themselves, and the reason it is not left at the
		// 5s default is worth stating because the row it produced was actively misleading.
		// `compiling twice produces identical bytes` runs two full builds, measured at
		// 532ms, 504ms and 490ms each on an idle machine, and under a loaded run it went
		// over 5000ms and reported as a failure of byte reproducibility. That is the one
		// property in this package a red row must never be able to claim falsely, because
		// the honest failure it looks like is the write-once refusal firing on a re-run
		// that changed nothing.
		testTimeout: 60_000,
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
				statements: 95,
				branches: 88,
				functions: 94,
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
