/**
 * The files `install` writes into a consuming site, as string builders.
 *
 * Four of them ship into somebody else's repository and are then read, reviewed and
 * linted by that repository's own tooling, so they are written in that repository's
 * style rather than this one's: tabs, double quotes, and relative imports with no
 * extension, which is the opposite of this package's own rule and is what both
 * consumers' app code actually does. A `.ts` extension there is TS5097 under their
 * configuration. Both consumers carry an eslint config whose scope is the site directory
 * `install` writes into, and the two disagree about `.mjs`. kcalc's front package also runs
 * `eslint app scripts --max-warnings 0` as a script; hex-web has no lint script, which is a
 * different fact from having no lint: the shim that failed its config was the one file with
 * errors in a scripts directory that otherwise lints clean. Measure a template change with
 * both consumers' eslint, not one.
 *
 * Every one of them is written when absent and never rewritten afterwards. A file that
 * exists and does not satisfy its predicate is a file somebody wrote, so `install` refuses
 * it and prints what the predicate wants rather than replacing a consumer's edit.
 *
 * The shim holds no copy of what is checked, and that is the property worth defending.
 * Every string it prints, the closing "not checked here" paragraph included, comes out
 * of the JSON. A shim with its own list goes stale the first time a check is added, and
 * it goes stale in the reassuring direction. `kit/test/wiring/shim.test.ts` asserts that
 * the generated text contains no `CheckId` and no `LintRuleId`, so a special case for
 * one row cannot be added without a test turning red.
 */

import { BUNDLE_TREE, PUBLIC_TREE } from '../../../src/contracts/manifest.js';

import {
	DOCS_SERVER_MODULE,
	dirnamePosix,
	joinPosix,
	relativePosix,
	type SiteDescriptor,
} from './site.js';

/**
 * The package's node-safe barrel, as a relative specifier from a file in the site.
 *
 * Relative and extensionless, never `@hex-pro/docs`, for the server module. React Router
 * loads `app/routes.ts` through a Vite runner with no config file and no plugins, so
 * `vite-tsconfig-paths` is not there and the alias does not exist, and `routes.ts` imports
 * `DOCS_ROUTES` from the server module. An aliased import there is a route config that
 * refuses to load, measured on both consumers as "Cannot find package '@hex-pro/docs'". The
 * route modules may use the alias, because nothing evaluates them without the plugins.
 */
export function packageIndexFrom(site: SiteDescriptor, fromFile: string): string {
	return relativePosix(
		dirnamePosix(joinPosix(site.site, fromFile)),
		joinPosix(site.mount, 'src/index'),
	);
}

/**
 * `<site>/app/lib/docs.server.ts`: the one module that reads bundles.
 *
 * One server module and not two. A client-reachable module inlines every config it globs
 * into every page's JavaScript, whole objects included, and the only reason an earlier
 * design split this was a path list that had to reach the client through `paths.ts`.
 * Nothing does now, so the configs, the route rows and the bundle reader live together,
 * and the `.server` suffix makes React Router's own guard fail the build if a client
 * module ever imports it.
 *
 * The globs are literal because Vite has to see a pattern to expand it: a computed path
 * produces a dynamic import that fails in the server bundle rather than an error at build
 * time. `BUNDLE_TREE` is interpolated here, in the generator, so the consumer's file
 * carries the literal and this package still spells the directory once.
 */
export function docsServerModule(site: SiteDescriptor): string {
	const index = packageIndexFrom(site, DOCS_SERVER_MODULE);
	const bundles = `../docs/${BUNDLE_TREE}/*/*`;
	return `// Written by \`hexdocs install\`. Safe to edit; \`hexdocs verify-install\` reads it.
//
// The one module in this site that reads documentation bundles, and a .server module so
// React Router refuses the build if a client module ever imports it.
//
// app/routes.ts imports DOCS_ROUTES from here, and React Router evaluates routes.ts with
// no Vite plugins, so the package is imported by a relative path rather than through the
// @hex-pro/docs alias, which does not exist there. The globs are literal because Vite has
// to see a pattern to expand it. Adding a second documented project is one JSON file in
// ../docs and no edit here.
import { docsRouteRows, docsServer } from "${index}";
import type { DocsSiteConfig } from "${index}";

const CONFIGS = import.meta.glob("../docs/*.docs.json", {
	eager: true,
	import: "default",
}) as Record<string, DocsSiteConfig>;

/** Sorted, so the route order does not depend on the filesystem. */
export const DOCS_SITES: DocsSiteConfig[] = Object.keys(CONFIGS)
	.sort()
	.map((key) => CONFIGS[key] as DocsSiteConfig);

/** Every route this site declares for its documentation. */
export const DOCS_ROUTES = docsRouteRows(DOCS_SITES);

/** Pages, machine text and sitemap rows, read from the prefetched bundles. */
export const DOCS = docsServer({
	configs: DOCS_SITES,
	manifests: import.meta.glob("${bundles}/manifest.json", {
		eager: true,
		import: "default",
	}),
	pages: import.meta.glob("${bundles}/pages/**/*.json", { import: "default" }),
	text: import.meta.glob<string>(
		["${bundles}/raw/**/*.md", "${bundles}/llms/*.txt"],
		{ query: "?raw", import: "default" },
	),
});
`;
}

/**
 * `<site>/app/routes/docs.tsx`: every docs page and every redirect source.
 *
 * Three exports carry a contract and one deliberately does not exist.
 *
 * `handle` is what `root.tsx` reads through `docsSeoFromMatches(useMatches())` to decide the
 * canonical, the alternates and the robots tag. Without it root treats a docs page like any
 * address missing from `LOCALISED_PATHS` and ships it noindex, which fails closed and still
 * keeps every docs page out of the index.
 *
 * The loader throws a `Response` for a redirect, a 404 and a 500, and React Router turns
 * those into a redirect and the root error boundary, so nothing here maps an outcome.
 *
 * There is no `headers` export. React Router copies only Set-Cookie from a parent into a
 * child's headers, so one here ships docs pages with no Content-Security-Policy on hex-web,
 * where the page then never hydrates, and without the root's Vary and cache policy on kcalc.
 *
 * `meta` is the title and the description and nothing else, because root owns robots, the
 * canonical and the alternates, and a route can add tags but never remove one root wrote.
 */
export function docsPageRouteModule(): string {
	return `// Written by \`hexdocs install\`. Safe to edit; \`hexdocs verify-install\` reads it.
//
// Every docs page and every redirect source. The loader throws a Response for a redirect,
// a 404 and a 500, which React Router turns into the redirect and the root error boundary.
// root.tsx reads \`handle\` to decide the canonical, the alternates and the robots tag, so
// \`meta\` here is the title and description only. Do not export \`headers\` from this
// module: React Router copies only Set-Cookie from a parent, so a child \`headers\` export
// replaces the root's policy for every docs page.
import {
	Link,
	useLoaderData,
	type LoaderFunctionArgs,
	type MetaFunction,
} from "react-router";
import { DOCS_HANDLE } from "@hex-pro/docs";
import { DocsPage } from "@hex-pro/docs/render";

import { DOCS } from "../lib/docs.server";

export const handle = DOCS_HANDLE;

export function loader({ request }: LoaderFunctionArgs) {
	return DOCS.page(new URL(request.url));
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
	if (!data) return [];
	return [
		{ title: data.data.page.title },
		{ name: "description", content: data.data.page.description },
	];
};

export default function DocsRoute() {
	const { data, themeClass } = useLoaderData<typeof loader>();
	return <DocsPage {...data} Link={Link} themeClass={themeClass} />;
}
`;
}

/**
 * `<site>/app/routes/docs.machine.tsx`: `llms.txt`, `llms-full.txt` and every raw page.
 *
 * A resource route, which is to say a loader and no default export, and the absence is the
 * contract. A default export makes every one of these addresses a document route that
 * renders the site shell around a plain-text body. The rows are declared top level and run
 * no parent loader, which is why the server validates the language segment itself.
 */
export function docsMachineRouteModule(): string {
	return `// Written by \`hexdocs install\`. Safe to edit; \`hexdocs verify-install\` reads it.
//
// llms.txt, llms-full.txt and every raw <slug>.md. A resource route: no default export,
// or each of these addresses renders the site shell around plain text. These routes are
// declared top level and run no parent loader, so the server validates the language
// segment itself. Do not export \`headers\` here either.
import type { LoaderFunctionArgs } from "react-router";

import { DOCS } from "../lib/docs.server";

export function loader({ request }: LoaderFunctionArgs) {
	return DOCS.resource(new URL(request.url));
}
`;
}

/**
 * The two directories `hexdocs prefetch` writes into, for the site's `.gitignore`.
 *
 * Built from the contract's constants, so the ignore list, the server module's glob and
 * prefetch cannot name three different directories.
 */
export const GITIGNORE_ENTRIES = [`app/docs/${BUNDLE_TREE}/`, `public/${PUBLIC_TREE}/`] as const;

/**
 * `<site>/scripts/check-docs.mjs`.
 *
 * Node builtins only, which is what every guard in both consumers already is. It runs
 * from `prebuild` because there is no CI on either repository, exactly as
 * `check-locales.mjs` says about itself, so a check that only runs when somebody types
 * it is not a guard.
 *
 * `console` and `process` are imported from `node:console` and `node:process` rather than
 * used as globals, because the two consumers' eslint configs want opposite things of a
 * global. kcalc's base config declares node globals for `.ts`, `.tsx`, `.js` and `.jsx`
 * only, so an `.mjs` script gets none and every use is `no-undef`: seventeen errors, measured
 * with kcalc's own eslint. hex-web's base config globs `.mjs` in with node globals, so the
 * `global console, process` directive comment that silenced kcalc was a redeclaration there:
 * two `no-redeclare` errors, measured with hex-web's own eslint, where the six scripts
 * already in that directory carry no such line and lint clean. An import is a module binding
 * rather than a global, so neither rule reads it, and both consumers' configs exit 0 over
 * this file. Each default export is the same object as the global, so nothing about what the
 * script does changes.
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
 *
 * A launcher that is not on disk gets its own sentence, because it has one cause in
 * practice: a clone that never initialised the submodule. That branch is reached only when
 * somebody runs this guard on its own, `node scripts/check-docs.mjs`, and never from the
 * build. Every prebuild chain `verify-install` accepts runs the prefetch segment first, and
 * that segment calls the same launcher by the same relative path, so on a missing submodule
 * the shell stops the chain there with its own error and exit 127 before this file runs. On
 * the Mac that deploys, that error reads `sh: <mount>/kit/bin/hexdocs: No such file or
 * directory`, and the message below quotes it with the real path, so a person who runs the
 * guard by hand after a failed build can match the two lines. Reaching this sentence from
 * the build would need a prebuild segment that tests for the launcher first, which the
 * prebuild predicate does not bind, and whose obvious spelling, `test -x ... ||`, hides a
 * failing step before it.
 *
 * **Failures are printed last.** A deploy reports the last twenty lines of a failed build,
 * and the rows that failed and what to do about them have to be those lines. So a row that
 * failed or did not run is printed once in the table without its detail, and again after the
 * summary with its note and its findings, remediation last, and the closing paragraph about
 * what is not checked is printed only on a clean run, where nothing needs the space. Measured
 * against the review's replica of the deploy's tail: with the paragraph after the rows, a
 * failure in the first row of nine was not among the twenty lines at all.
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
 * What did not pass is printed last, after the summary, because a deploy reports only the
 * last twenty lines of a failed build.
 *
 * Node builtins only.
 */

import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONT = resolve(HERE, "..");
const REPO = resolve(FRONT, ${JSON.stringify(site.repoFromSite)});
const LAUNCHER = resolve(FRONT, ${JSON.stringify(launcher)});
const MOUNT = ${JSON.stringify(site.mount)};
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

// Reached only when this file is run on its own. From prebuild, the prefetch segment calls
// the same launcher first, so a missing submodule stops the build there with the shell's
// error and exit 127, and this message is never printed.
if (!existsSync(LAUNCHER)) {
	noVerdict(
		\`could not run \${LAUNCHER}, because it is not there\`,
		"The launcher lives inside the docs submodule, so this almost always means the\\n" +
			"submodule is not checked out. From the repository root, run:\\n\\n" +
			\`  git submodule update --init \${MOUNT}\\n\\n\` +
			"A build stops earlier on the same cause, on the prefetch segment of prebuild, and\\n" +
			"what it prints is the shell's own error, on macOS:\\n\\n" +
			${JSON.stringify(`  sh: ${launcher}: No such file or directory\n`)},
	);
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
const blocking = rows.filter((row) => row.status === "fail" || row.status === "not-run");
const labelOf = (row) => (LABELS[row.status] ?? String(row.status)).padEnd(7);
console.log(\`docs wiring for \${report.site} (\${report.kitVersion})\\n\`);
for (const row of rows) {
	// A row that did not pass has its detail printed after the summary instead, so that it
	// ends the output, and its note is not printed twice.
	const deferred = blocking.includes(row);
	let tail = "";
	if (row.status === "pass" || row.status === "fail") tail = \`\${row.examined} \${row.unit}\`;
	else if (!deferred) tail = row.note ?? "";
	console.log(\`  \${String(row.id).padEnd(width)}  \${labelOf(row)}  \${tail}\`.trimEnd());
	if (deferred) continue;
	if (row.status === "pass" && row.note) {
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

if (report.nextAction?.why) console.log(\`\\nNext: \${report.nextAction.why}\`);

if (blocking.length === 0) {
	if (Array.isArray(report.notCheckedHere) && report.notCheckedHere.length > 0) {
		console.log("\\nNot checked here, and still a person's job:");
		for (const line of report.notCheckedHere) console.log(\`  \${line}\`);
	}
} else {
	console.log("\\nWhat did not pass, and what to do about it:");
	for (const row of blocking) {
		const counted = row.status === "fail" ? \`\${row.examined} \${row.unit}\` : "";
		console.log(\`  \${row.id}  \${labelOf(row).trimEnd()}  \${counted}\`.trimEnd());
		if (row.note) console.log(\`    \${row.note}\`);
		for (const finding of row.findings ?? []) {
			console.log(\`    \${finding.message}\`);
			if (finding.consequence) console.log(\`    \${finding.consequence}\`);
			if (finding.remediation) console.log(\`    \${finding.remediation}\`);
		}
	}
}

process.exit(typeof report.exitCode === "number" ? report.exitCode : 3);
`;
}

/**
 * The `.mcp.json` entry.
 *
 * `APPLY.mcpJson` inserts it into the original bytes rather than parsing and
 * re-serialising the file, because a round trip through `JSON.stringify` puts every array
 * element of every other server on its own line. This object is the command the predicate
 * compares and the text the insertion is built from, so the two cannot name different
 * launchers.
 */
export function mcpServerEntry(site: SiteDescriptor): { command: string; args: string[] } {
	return { command: `./${site.mount}/kit/start.sh`, args: [] };
}

/**
 * The editor settings a person may want, printed by `install` and checked by nothing.
 *
 * Not a check, and the reason is where it runs. `verify-install` is the build gate: the
 * generated shim runs it from `prebuild` on the deploy host. Whether one developer's editor
 * enables an MCP server has nothing to do with whether the site builds, and kcalc keeps its
 * enable only in a globally ignored local settings file, so a row demanding it failed every
 * clone but one and would have failed every deploy. `doctor` has no checks of its own by
 * contract, so there was nowhere else for the row to go, and it was deleted rather than
 * moved.
 *
 * Printed rather than written, because it could not be established whether Claude Code
 * merges `enabledMcpjsonServers` across `.claude/settings.json` and
 * `.claude/settings.local.json` or lets the local file replace the project one. If it
 * replaces, an installer writing a `settings.json` naming only this server would silently
 * disable every other MCP server the repository has, and hex-web has three.
 */
export function settingsInstruction(site: SiteDescriptor): string {
	const skills = `${site.mount}/.claude/skills`;
	return [
		'Optional, and not checked: to use the docs MCP server and skills from an editor in this',
		'repository, add to .claude/settings.json or to your own .claude/settings.local.json:',
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
