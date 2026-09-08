/**
 * The files `install` writes into a consuming site, as string builders.
 *
 * Two of them ship into somebody else's repository and are then read, reviewed and
 * linted by that repository's own tooling, so they are written in that repository's
 * style rather than this one's: tabs, double quotes, and relative imports with no `.js`
 * extension, which is the opposite of this package's own rule and is what both
 * consumers' app code actually does. kcalc's front package runs `eslint app scripts
 * --max-warnings 0`, so a shim that satisfied hex-web (which has no lint at all) and not
 * kcalc would break the build it was installed to protect.
 *
 * The shim holds no copy of what is checked, and that is the property worth defending.
 * Every string it prints, the closing "not checked here" paragraph included, comes out
 * of the JSON. A shim with its own list goes stale the first time a check is added, and
 * it goes stale in the reassuring direction. `kit/test/wiring/shim.test.ts` asserts that
 * the generated text contains no `CheckId` and no `LintRuleId`, so a special case for
 * one row cannot be added without a test turning red.
 */

import type { SiteDescriptor } from './site.js';

/**
 * `<site>/app/lib/docs.ts`.
 *
 * The glob rather than a named import per project, and the reason is the second
 * documented project rather than the first. Vite has to see the pattern literally to
 * expand it, which kcalc's own `i18n.server.ts` says at the code and proves for JSON in
 * this exact stack, and expanding it means adding a docs site is one JSON file with no
 * edit here at all. Sorted, so route order does not depend on filesystem order.
 *
 * The three exported identifiers are constants of this package, not of a consumer. That
 * is what makes one needle table work for two sites whose route files, path registries
 * and sitemaps have nothing else in common.
 */
export function docsLibModule(): string {
	return `// Written by \`hexdocs install\`. Safe to edit; \`hexdocs verify-install\` reads it.
//
// The glob is literal because Vite has to see the pattern to expand it: a computed path
// here produces a dynamic import that fails in the server bundle rather than an error at
// build time. Adding a second documented project is one JSON file in ../docs and no edit
// to this module.
//
// This needs \`resolveJsonModule\` in the TypeScript configuration this site extends.
// Both existing consumers set it in their shared config/tsconfig.front.json.
import { docsLocalisedPathsFor, docsRouteRows, docsSitemapRows } from "@hex-pro/docs";
import type { DocsSiteConfig } from "@hex-pro/docs";

const CONFIGS = import.meta.glob("../docs/*.docs.json", {
	eager: true,
	import: "default",
}) as Record<string, DocsSiteConfig>;

export const DOCS_SITES: DocsSiteConfig[] = Object.keys(CONFIGS)
	.sort()
	.map((key) => CONFIGS[key] as DocsSiteConfig);

/** Every docs address, for LOCALISED_PATHS. Hidden pages are included: they are indexable. */
export const DOCS_PATHS = docsLocalisedPathsFor(DOCS_SITES);

/** Every route row, machine endpoints first, in the order the tie-breaks require. */
export const DOCS_ROUTES = docsRouteRows(DOCS_SITES);

/** The sitemap rows, with hidden pages already excluded. */
export const DOCS_SITEMAP = docsSitemapRows(DOCS_SITES);
`;
}

/** The two directories `hexdocs prefetch` writes into, for the site's `.gitignore`. */
export const GITIGNORE_ENTRIES = ['app/docs/_bundles/', 'public/_docs/'] as const;

/**
 * `<site>/scripts/check-docs.mjs`.
 *
 * Node builtins only, which is what every guard in both consumers already is. It runs
 * from `prebuild` because there is no CI on either repository, exactly as
 * `check-locales.mjs` says about itself, so a check that only runs when somebody types
 * it is not a guard.
 *
 * The exit codes translate one convention into another and the choice is deliberate.
 * hex-web's own guards use 1 for "problems found" and 2 for "could not read what it was
 * meant to check". This shim passes `report.exitCode` straight through instead, which is
 * 0 or 3, because `VerifyInstallReport.exitCode` is a documented contract field and a
 * shim that remapped it would be carrying its own table of what hexdocs' codes mean:
 * a second copy of a fact, in the file whose whole design principle is that it holds
 * none. A spawn that failed or output that did not parse exits 1, which is the "no
 * verdict" case and is the one thing that must stay distinguishable from a run that
 * reached a verdict and found problems. Every non-zero code fails `prebuild` either way.
 */
export function checkDocsShim(site: SiteDescriptor): string {
	const launcher = `${site.mountFromSite}/kit/bin/hexdocs`;
	return `#!/usr/bin/env node
/**
 * The docs wiring guard. Written by \`hexdocs install\`.
 *
 * There is no CI on this repository, so this runs from \`prebuild\` rather than from a
 * script somebody has to remember. \`prebuild\` is the one thing that always runs: the
 * deploy builds on the host before the Docker build, and the container's own install
 * runs with scripts disabled and never repeats it.
 *
 * It holds no copy of what is checked. Every row, every message and the closing
 * paragraph come out of the JSON, because a shim with its own list goes stale the first
 * time a check is added and it goes stale in the reassuring direction.
 *
 * Exit codes:
 *   0  clean
 *   3  problems found; this is \`hexdocs verify-install\`'s own code, passed through
 *   1  the launcher could not be spawned, or its output did not parse. No verdict.
 *
 * Node builtins only.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONT = resolve(HERE, "..");
const REPO = resolve(FRONT, ${JSON.stringify(site.repoFromSite)});
const LAUNCHER = resolve(FRONT, ${JSON.stringify(launcher)});
const SITE = ${JSON.stringify(site.site)};

const LABELS = {
	pass: "PASS",
	fail: "FAIL",
	skipped: "SKIPPED",
	"not-run": "NOT RUN",
};

function noVerdict(reason, detail) {
	console.error(\`check-docs: \${reason}\`);
	if (detail) console.error(detail.trimEnd());
	console.error(
		"Refusing to report success either way. This is not the same as a clean run:\\n" +
			"nothing was checked, so nothing was cleared.",
	);
	process.exit(1);
}

let stdout = "";
try {
	stdout = execFileSync(LAUNCHER, ["verify-install", "--site", SITE, "--json"], {
		cwd: REPO,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
} catch (error) {
	// A non-zero exit is the ordinary case: the report is still on stdout and is what
	// this prints. Only a spawn that produced nothing is a failure of the shim itself.
	stdout = typeof error?.stdout === "string" ? error.stdout : "";
	if (stdout.trim() === "") {
		noVerdict(
			\`could not run \${LAUNCHER}\`,
			typeof error?.stderr === "string" ? error.stderr : String(error?.message ?? error),
		);
	}
}

let report;
try {
	report = JSON.parse(stdout);
} catch {
	noVerdict("the output of hexdocs verify-install did not parse as JSON", stdout.slice(0, 2000));
}

const rows = Array.isArray(report?.rows) ? report.rows : null;
if (rows === null || rows.length === 0) {
	noVerdict("hexdocs verify-install returned no rows");
}

const width = rows.reduce((max, row) => Math.max(max, String(row.id).length), 0);
console.log(\`docs wiring for \${report.site} (\${report.kitVersion})\\n\`);
for (const row of rows) {
	const label = (LABELS[row.status] ?? String(row.status)).padEnd(7);
	const tail =
		row.status === "pass" || row.status === "fail"
			? \`\${row.examined} \${row.unit}\`
			: (row.note ?? "");
	console.log(\`  \${String(row.id).padEnd(width)}  \${label}  \${tail}\`);
	if ((row.status === "pass" || row.status === "fail") && row.note) {
		console.log(\`  \${" ".repeat(width)}  \${" ".repeat(7)}  \${row.note}\`);
	}
	for (const finding of row.findings ?? []) {
		console.log(\`  \${" ".repeat(width)}  |        \${finding.message}\`);
		if (finding.remediation) {
			console.log(\`  \${" ".repeat(width)}  |        \${finding.remediation}\`);
		}
		if (finding.consequence) {
			console.log(\`  \${" ".repeat(width)}  |        \${finding.consequence}\`);
		}
	}
}

const failed = rows.filter((row) => row.status === "fail").length;
const notRun = rows.filter((row) => row.status === "not-run").length;
const skipped = rows.filter((row) => row.status === "skipped").length;
console.log(
	\`\\n  \${failed} failed, \${notRun} did not run, \${skipped} skipped, \` +
		\`\${rows.length - failed - notRun - skipped} passed\`,
);
if (skipped > 0) {
	console.log("\\nA skipped check did not run. It is not a pass:");
	for (const row of rows.filter((entry) => entry.status === "skipped")) {
		console.log(\`  \${row.id}: \${row.note ?? "no reason given"}\`);
	}
}

if (Array.isArray(report.notCheckedHere) && report.notCheckedHere.length > 0) {
	console.log("\\nNot checked here, and still a person's job:");
	for (const line of report.notCheckedHere) console.log(\`  \${line}\`);
}

if (report.nextAction?.why) console.log(\`\\nNext: \${report.nextAction.why}\`);

process.exit(typeof report.exitCode === "number" ? report.exitCode : 3);
`;
}

/**
 * The `.mcp.json` entry, as an object so the file is edited by parse and re-serialise.
 *
 * Safe here and nowhere else in the install table: `.mcp.json` is strict JSON with no
 * comments in both consumers, so a round trip loses nothing as long as the indent is
 * preserved, and both files are tab indented. `tsconfig.json` is the counter-example and
 * is why every other JSON edit in this package is an insertion into the original bytes.
 */
export function mcpServerEntry(site: SiteDescriptor): { command: string; args: string[] } {
	return { command: `./${site.mount}/kit/start.sh`, args: [] };
}

/**
 * The settings a person has to apply, printed and never written.
 *
 * It could not be established whether Claude Code merges `enabledMcpjsonServers` across
 * `.claude/settings.json` and `.claude/settings.local.json` or lets the local file
 * override the project one wholesale. If it overrides, an installer writing a
 * `settings.json` naming only this server would silently disable every other MCP server
 * the repository has, and hex-web has three. So the edit is printed, the row fails until
 * somebody applies it, and this comment is the reason rather than an omission.
 */
export function settingsInstruction(site: SiteDescriptor): string {
	const skills = `${site.mount}/.claude/skills`;
	return [
		'Add to .claude/settings.json (create it if it does not exist), or to your own',
		'.claude/settings.local.json:',
		'',
		'  {',
		'    "enabledMcpjsonServers": ["hexdocs"],',
		'    "permissions": {',
		`      "additionalDirectories": [${JSON.stringify(skills)}]`,
		'    }',
		'  }',
		'',
		'This install writes neither file. Whether a local settings file merges with the',
		'project one or replaces it could not be established, and guessing wrong disables',
		'every other MCP server in the repository. Merge by hand with what is already there.',
	].join('\n');
}
