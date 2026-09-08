/**
 * The toolchain's barrel, which `kit/package.json`'s `"."` export has always named and
 * which did not exist until step 5.
 *
 * Nothing in a consuming website imports this. `kit/` is the half with dependencies and
 * a lockfile of its own, and the runtime half at the repository root is what a site
 * consumes through a `tsconfig` `paths` entry. What this is for is the two things that
 * import the toolchain as a library rather than running it: the test suite, and a future
 * script that wants the registry without spawning a process.
 *
 * It deliberately does not re-export the compiler. `buildBundle` pulls in the parser, the
 * highlighter, the search index builder and the asset prober, and a barrel that dragged
 * all of that in would make `import { COMMANDS } from '@hex-pro/docs-kit'` cost a full
 * compile's worth of module evaluation to read a table of names.
 */

export { COMMANDS, BY_NAME, TOOLS, BY_TOOL } from './registry/index.js';
export { defineCommand, exitCodeFor, invoke } from './registry/command.js';
export type { Command, CommandOutput, Ctx, Writer, Writes } from './registry/command.js';
export { jsonSchemaOf, shapeOf } from './registry/params.js';
export type { Input, Param, Params } from './registry/params.js';

export { ALL_RECIPES, HOLE, READ_RECIPES, WRITE_RECIPES, holeCount } from './exec/recipes.js';
export type { Recipe, RecipeId, ReadRecipeId, WriteRecipeId } from './exec/recipes.js';
export { ExecRefusal, NO_EXEC, runRecipe } from './exec/run.js';
export type { Exec, RunOptions, RunResult } from './exec/run.js';

export { SKILL_IDS, isSkillId } from './skills/ids.js';
export type { SkillId } from './skills/ids.js';

export { defaultContext, kitVersion, run } from './cli/main.js';
