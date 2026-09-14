/**
 * Raw findings from a structural check to reportable ones, with no project to read.
 *
 * Here rather than in `kit/src/s3/client.ts`, where it started. It was written for the two
 * commands that talk to a bucket, and the comment on it said a third caller was the signal
 * to move it. The MCP server's refusal of a path outside the project is that caller, and a
 * server importing the S3 client to build one finding would be an import the tool graph
 * test exists to keep out of that half of the package.
 */

import type { Finding } from '../../../../src/contracts/diagnostics.js';
import { DEFAULT_AUDIENCE } from '../../../../src/contracts/frontmatter.js';
import { CHECK_IDS } from '../../../../src/contracts/lint.js';
import {
	DEFAULT_BUDGETS,
	DOCS_CONFIG_VERSION,
	PLAIN_CODE_LANGUAGE,
	type DocsProjectConfig,
} from '../../../../src/contracts/project.js';
import type { RawFinding } from '../types.js';

import { runLint } from './run.js';

/**
 * The project config `runLint` is given when there is no project to read one from.
 *
 * `publish` is handed a compiled bundle directory, `prefetch` is handed a consuming
 * website, and the MCP server is refusing a call before any command reads anything: none
 * of them has a `docs/site/docs.json` to read. Every value below is a placeholder, and
 * `checkFindings` is what makes that safe: `severityFor` in `runLint` pins a `CheckId` to
 * `error` before it reads the config at all, so a config that decides nothing cannot
 * decide anything wrongly.
 */
const NO_PROJECT_CONFIG: DocsProjectConfig = {
	docs: DOCS_CONFIG_VERSION,
	project: 'unknown',
	productName: 'unknown',
	repo: 'unknown/unknown',
	defaultAudience: DEFAULT_AUDIENCE,
	headingIds: 'slug',
	sections: [],
	i18n: { locales: ['en'], sourceLocale: 'en', parity: 'graceful' },
	budgets: DEFAULT_BUDGETS,
	code: { languages: [PLAIN_CODE_LANGUAGE] },
	toc: { enabled: true, maxDepth: 3, minHeadings: 3 },
	lint: { extends: 'house', maxDisables: 0 },
};

/**
 * Raw findings to reportable ones.
 *
 * It exists so nothing hand assembles a `Finding`. Severity, category and consequence are
 * the registry's to decide, and a literal written at a call site is how a check ends up
 * with a consequence sentence nobody wrote and a category nothing groups by.
 * `kit/src/compile/bundle.ts` still builds two of them by hand, which predates this and is
 * the shape not to copy.
 *
 * The refusal is the load-bearing half. This function must only ever be handed a
 * `CheckId`, because a `LintRuleId` would resolve its severity against
 * `NO_PROJECT_CONFIG`, which is a config nobody wrote, and the answer would be that rule's
 * house default presented as if a project had chosen it. Refusing by name is cheap and the
 * alternative is silent.
 */
export function checkFindings(entries: readonly RawFinding[], kitVersion: string): Finding[] {
	const checks = new Set<string>(CHECK_IDS);
	for (const entry of entries) {
		if (!checks.has(entry.rule)) {
			throw new Error(
				`checkFindings was given "${entry.rule}", which is not a CheckId. Its severity would ` +
					`be resolved against a placeholder project config, so the report would state a ` +
					`severity no project chose.`,
			);
		}
	}
	return runLint(entries, { config: NO_PROJECT_CONFIG, disables: [], kitVersion }).envelope
		.findings;
}
