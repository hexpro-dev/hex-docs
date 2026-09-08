/**
 * The Zod half of the contracts.
 *
 * Import shapes from here inside `kit/`. The canonical *types* still come from
 * `src/contracts/`, and `drift.ts` is what holds the two together: it runs as part of
 * `tsc --noEmit`, so a schema that stopped matching its type fails the same command
 * that catches a syntax error.
 */

export * from './primitives.js';
export * from './ast.schema.js';
export * from './config.schema.js';
export * from './bundle.schema.js';
export * from './diagnostics.schema.js';

// Type-only: importing it is what puts the drift assertions in the program.
import './drift.js';
