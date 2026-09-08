# The toolchain, and what each part is guarding against

`kit/src/compile/` is the compiler (step 3). Everything else here is step 5: the `hexdocs`
CLI, the MCP server, the consumer wiring, and the tables both front doors are derived from.

Read `../../CLAUDE.md` first. This file is the part that is specific to step 5 and would
otherwise have to be rediscovered from the code.

## The failure catalogue

Every structure in step 5 exists to close one of these, and the fourth column is the point
of the table: a guard whose failure has never been observed is a guard nobody has tested.
`kit/test/failure-catalogue.test.ts` walks this table and asserts each named test file
exists, so a row cannot be deleted quietly and a test cannot be renamed out from under it.

| #   | Failure, in the reassuring direction                 | The structure that answers it                                                                                                                                                                                                                                                                                                                                                                                                | Proving test                                                                  | Mutation that must turn it red                                                                                                                       |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A wiring check silently never runs                   | `CONSUMER_PROBES` is `satisfies Record<ConsumerCheckId, WiringProbe>`, and `verifyInstall` asserts its emitted row ids equal the probe key set in both directions before returning                                                                                                                                                                                                                                           | `kit/test/wiring/checks-fire.test.ts`                                         | delete one probe entry (typecheck fails by name); filter a row out of the returned array (the row-set assertion fires)                               |
| 2   | `verify-install` and the MCP tool disagree           | One implementation. The tool returns `CommandOutput.data` verbatim, and the shim holds no copy of what is checked: it renders the JSON and nothing else                                                                                                                                                                                                                                                                      | `kit/test/mcp/parity.test.ts`, `kit/test/wiring/shim.test.ts`                 | make the MCP handler recompute the summary (deep equality fails); put a `CheckId` string in the shim template (the shim-has-no-knowledge test fails) |
| 3   | `install` run twice gives a different result         | The writer and the checker share one `present` predicate, compared by **reference identity** in the test. `install` writes only edits whose `present` returned false                                                                                                                                                                                                                                                         | `kit/test/wiring/install.test.ts`                                             | copy the predicate instead of sharing it (the `===` assertion fails where a behavioural one would pass)                                              |
| 4   | `init` widens a public-mirror allowlist              | The inserted literal is derived from `SITE_ROOT_RELATIVE`, the same constant `loadProject` resolves the compiled tree against, and the editor refuses unless it parsed one real `ALLOW_PATHS` array with no bare `docs` entry                                                                                                                                                                                                | `kit/test/source/allow-paths.test.ts`, and `kit/test/compile/project.test.ts` | set `SITE_ROOT_RELATIVE = 'docs'` (the compiler's own project tests fail first, then the refusal test)                                               |
| 5   | The exec boundary admits a mutating command          | There is no argv parameter. `runRecipe(id, holes)` fills a fixed template from a closed table, so `git clean -fd` is unrepresentable rather than denied                                                                                                                                                                                                                                                                      | `kit/test/exec/recipes.test.ts`, `kit/test/exec/one-spawn-site.test.ts`       | add a recipe (the pinned-id test fails naming it); call `spawnSync` anywhere else under `kit/src` (the one-spawn-site scan fails)                    |
| 6   | A scaffolder claims a translation it did not perform | A scaffolded non-source locale carries `translated: false` **and** a body that is not the source's bytes, and the test proves it through the real `buildBundle` rather than by reading the string                                                                                                                                                                                                                            | `kit/test/source/scaffold.test.ts`                                            | drop the flag from the template (the state becomes `current` and the assertion fails)                                                                |
| 7   | A publish overwrites a labelled bundle               | Write-once three times: `writeBundle` locally, a checksum preflight, and `--if-none-match '*'` inside the put template rather than at the call site                                                                                                                                                                                                                                                                          | `kit/test/s3/publish.test.ts`                                                 | drop the conditional header from the recipe (the pinned-argv test fails)                                                                             |
| 8   | A skill names a tool or a flag that no longer exists | Every invocation is inside a `hexdocs-cli` or `hexdocs-mcp` fence and is validated against the registry, and an unfenced `hexdocs ` or `docs_` mention is itself a failure                                                                                                                                                                                                                                                   | `kit/test/skills/references.test.ts`                                          | rename a command (every skill naming it fails); move a command into prose (the unfenced-mention test fails)                                          |
| 9   | A report that examined nothing and exited 0          | `checkRow` coerces a zero-examined pass into a failure, and the report is validated with `zeroExaminedPasses` and `rowsWithoutReason` before it is printed                                                                                                                                                                                                                                                                   | `kit/test/wiring/report.test.ts`                                              | make a probe return `examined: 0` with no findings (the row is `fail`, not `pass`)                                                                   |
| 10  | The MCP server mutates something                     | The `Command` union has no shape for a writer with a tool name; `Ctx.write` is `null` there; and the import graph **from each of the nine tool handlers** reaches no writer. It is rooted at the handlers rather than at `mcp/server.ts`, because the server imports the registry and the registry is one flat array of all sixteen commands, so a walk from the server reaches every writer by construction and always will | `kit/test/exec/no-write.test.ts`, `kit/test/registry/registry.test.ts`        | give `install` a tool name (typecheck fails); import a writer from a module a tool handler reaches (the graph walk fails)                            |
| 11  | A labelled sha with no bundle                        | `label` resolves every version's commit against the local cache and then the bucket, and an unreachable bucket is `skipped` with the sha named, never a pass                                                                                                                                                                                                                                                                 | `kit/test/commands/label.test.ts`                                             | make the unreachable arm return a pass (the skipped-not-pass assertion fires)                                                                        |
| 12  | `sync` produces a spurious diff every run            | Page order is pinned to `manifest.llmsOrder`, and the file is written with tabs and a trailing newline and compared byte for byte                                                                                                                                                                                                                                                                                            | `kit/test/commands/sync.test.ts`                                              | sort `pages` alphabetically instead (byte equality against the fixture fails)                                                                        |

## Two namespaces that look like one

`Finding.rule` is a closed union: `LintRuleId | CheckId`. `CheckRow.id` is a plain string,
and it is a **row** id rather than a check id. `verifyBundle` has emitted
`bundle-manifest`, `bundle-objects`, `bundle-digests` and `bundle-payloads` as row ids
since step 3 and none of them is in `CHECK_IDS`, which is correct: a row groups findings
and a check id names one.

The consequence is that a both-directions coverage test keyed on row ids fails against the
compiler's own existing output, and one keyed on `Finding.rule` is the one worth having.
`checks-fire.test.ts` proves `CHECK_IDS` by **firing** each of them, which is
`rules-fire.test.ts`'s shape, and not by scanning the source for a string literal: a
literal in an unreachable branch satisfies a grep, and that is how eleven check ids sat
unimplemented through four steps with a green suite.

## Why the MCP server is written here rather than taken as a dependency

`@modelcontextprotocol/sdk@1.30.0` declares seventeen direct dependencies, including
express, hono, cors, jose and ajv, and resolves to roughly a hundred packages. `kit/` ships
two. That weight would travel into every app repository that mounts this submodule, and
one of them is a Swift project whose first agent session pays for the install before the
server answers `initialize`, for transports this server does not use.

The wire format is newline-delimited JSON and a tools-only server answers five methods, so
`mcp/protocol.ts` is about two hundred lines. The SDK is a **devDependency** and
`kit/test/mcp/protocol.test.ts` drives this server with its real `Client`, so the protocol
claim is proved against the reference implementation while the reference implementation
stays out of every consumer's tree. `bin/hexdocs` installs production dependencies only.

## Where the exit codes come from

`exitCodeFor` decides, and no command decides for itself. A command that could set its own
code could report a clean run over a failing envelope.

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| 0    | Clean                                                                                        |
| 1    | The toolchain threw. A bug in hexdocs, printed with its stack                                |
| 2    | Usage: no command, an unknown one, an unknown flag, a missing argument. Nothing was examined |
| 3    | The run found something wrong: an envelope with errors, or a failing or non-running row      |

An input hexdocs could not read is deliberately **not** a usage error. It is a `not-run`
row and therefore 3, because "I could not read the registry" and "the registry is broken"
are both "no verdict, and it is not clean".
