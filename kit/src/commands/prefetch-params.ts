/**
 * `hexdocs prefetch`'s parameter table, in a module that imports no writer.
 *
 * Two readers need it. The command itself, and the wiring check that decides whether a
 * consuming site's prebuild string is a prefetch invocation this CLI would accept. That
 * check is reachable from the read-only MCP tools, and `prefetch.ts` imports the S3 client
 * and declares `writes`, so importing the command there would put a writer into the tool
 * graph `kit/test/exec/no-write.test.ts` exists to keep clean. Step 5 shipped a prebuild
 * string the CLI refused because the check matched substrings rather than binding the
 * arguments, and binding them needs exactly this table.
 */

import type { Params } from '../registry/params.js';

import { BUCKET, PROFILE, REGION, ROOT, SITE } from './common.js';

export const PREFETCH_PARAMS = {
	root: ROOT,
	site: SITE,
	bucket: BUCKET,
	region: REGION,
	profile: PROFILE,
	cache: {
		help: 'where downloaded bundles are cached; defaults to $XDG_CACHE_HOME/hexdocs, or ~/.cache/hexdocs',
		type: 'string',
	},
	offline: {
		help: 'make no network call at all; a bundle missing from the cache then fails rather than downloading',
		type: 'boolean',
	},
} as const satisfies Params;

/** `root` is positional: `hexdocs prefetch ../.. --site apps/front`, never `--root`. */
export const PREFETCH_POSITIONALS = ['root'] as const;
