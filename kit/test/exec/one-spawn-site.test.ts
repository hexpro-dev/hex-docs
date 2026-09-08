/**
 * One spawn site, proved by scanning every file rather than by reading one.
 *
 * `kit/src/exec/recipes.ts` makes a claim about every external command this package can
 * run, and that claim is worth exactly what the scan below is worth: a second call to
 * `spawnSync` anywhere under `kit/src` would sit outside every guarantee the recipe table
 * makes while looking exactly like a call that does not. hex-terraform has that defect
 * live. `mcp/src/lib/exec.ts` there carries a binary allowlist and a comment saying every
 * subcommand it wraps is read-only, and `mcp/src/context.ts` beside it reaches straight
 * for `execSync` over an interpolated path. Nothing in that repository compares the two,
 * so the allowlist's coverage claim is aspirational rather than true. This file is what
 * makes the same claim here true.
 *
 * The proof is the import, not the identifier. A process can only be started through a
 * binding taken from `node:child_process`, so the load-bearing assertion is that exactly
 * one module under `kit/src` imports that module, that it takes exactly one name from it,
 * and that no second route to it exists. The identifier scan corroborates that and catches
 * the readability failure the import check cannot see: a call through a locally re-exported
 * alias would still need the import, but a reviewer grepping for `spawnSync` deserves to
 * find one answer.
 *
 * There are no exemptions. One file's raw text names a spawner while its executable code
 * does not, and it is declared with a reason and checked in both directions rather than
 * filtered out: `kit/src/wiring/templates.ts` emits the consuming site's `check-docs.mjs`
 * shim as a template literal, and that shim spawns `bin/hexdocs` from somebody else's
 * prebuild. A spawn added to a template is a spawn added to a consumer, which is exactly
 * what a silent filter would stop reporting.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const KIT_SRC = join(REPO_ROOT, 'kit', 'src');

/**
 * The one file that may start a process.
 *
 * Written out rather than derived, because the whole assertion is that this is a constant
 * of the package. A second entry is the diff row 5 of the failure catalogue exists to make
 * visible.
 */
const SPAWN_SITE = 'kit/src/exec/run.ts';

/** Every process-starting export of `node:child_process`. */
const SPAWNERS = ['spawnSync', 'spawn', 'execSync', 'execFileSync', 'execFile', 'exec', 'fork'];

/**
 * The names that can only mean a child process.
 *
 * `exec` is held out because it is also the name of this package's own injected recipe
 * runner: `Ctx.exec` is destructured and called in `kit/src/s3/client.ts`, and renaming
 * that to satisfy a grep would be the tail wagging the dog. It gets its own assertion
 * below, and that assertion is stronger than a name check rather than weaker.
 */
const UNAMBIGUOUS = SPAWNERS.filter((name) => name !== 'exec');

/**
 * Files whose raw text names a spawner and whose executable code does not.
 *
 * Declared with a reason and checked in both directions, in the shape
 * `fixtures/planted.json` uses: an undeclared file fails, and a declared file that no
 * longer names its spawner fails too. The second half is the one worth having, because a
 * declaration whose subject has gone leaves a precedent the next entry is measured
 * against.
 *
 * This is not an exemption from the assertions above. Those are about executable code, and
 * this file's executable code contains no spawner. It is the record of what a reviewer
 * grepping the source will find, and of why it is not a second spawn site.
 */
const IN_TEXT_ONLY: readonly { path: string; names: readonly string[]; why: string }[] = [
	{
		path: 'kit/src/wiring/templates.ts',
		names: ['execFileSync'],
		why: "It emits the consuming site's scripts/check-docs.mjs shim as a template literal, and that shim spawns bin/hexdocs from the site's prebuild. The call is in generated text rather than in this package, and what it runs is the launcher rather than a binary, so it stays inside the recipe boundary. A spawn added to a template is a spawn added to somebody else's repository, which is why this is declared rather than filtered.",
	},
];

/**
 * Comments removed, and optionally literal bodies as well, with every offset preserved.
 *
 * `scripts/lib/scan-imports.mjs` does the first half and is deliberately not used here:
 * `kit/tsconfig.json` is NodeNext with no `allowJs`, so a `.mjs` helper with only JSDoc
 * types is not importable from a file this configuration typechecks. The same forty lines
 * appear in `kit/test/exec/no-write.test.ts`, which is the cost of that.
 *
 * Preserving offsets is what makes the two views comparable: an `import` keyword that
 * survives into the literal-stripped view at the same index is a real import statement,
 * and one that does not is the same words inside generated source.
 *
 * One limit, stated rather than implied: an interpolation inside a template literal is
 * stripped along with the rest of the literal, so a call written inside `${...}` is
 * invisible to the code view. The import assertions close that, because such a call still
 * needs a binding from `node:child_process`.
 */
function strip(source: string, literals: boolean): string {
	const identEnd = /[A-Za-z0-9_$)\]}'"`]/;
	const out = source.split('');
	let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex' = 'code';
	let last = '';

	for (let i = 0; i < source.length; i += 1) {
		const char = source[i] as string;
		const next = source[i + 1];

		if (state === 'code') {
			if (char === '/' && next === '/') {
				state = 'line';
				out[i] = ' ';
				out[i + 1] = ' ';
				i += 1;
			} else if (char === '/' && next === '*') {
				state = 'block';
				out[i] = ' ';
				out[i + 1] = ' ';
				i += 1;
			} else if (char === "'") state = 'single';
			else if (char === '"') state = 'double';
			else if (char === '`') state = 'template';
			else if (char === '/' && !identEnd.test(last)) state = 'regex';
			if (char.trim() !== '') last = char;
			continue;
		}

		if (state === 'line') {
			if (char === '\n') state = 'code';
			else out[i] = ' ';
			continue;
		}

		if (state === 'block') {
			if (char === '*' && next === '/') {
				out[i] = ' ';
				out[i + 1] = ' ';
				i += 1;
				state = 'code';
			} else if (char !== '\n') out[i] = ' ';
			continue;
		}

		const closer =
			state === 'single' ? "'" : state === 'double' ? '"' : state === 'template' ? '`' : '/';
		if (char === '\\') {
			if (literals) {
				out[i] = ' ';
				if (next !== undefined && next !== '\n') out[i + 1] = ' ';
			}
			i += 1;
			continue;
		}
		if (char === closer) {
			state = 'code';
			last = char === '/' ? ')' : char;
			continue;
		}
		if (char === '\n' && state !== 'template') {
			// An unterminated literal. Recover rather than stripping the rest of the file,
			// which is the only outcome that could hide a call.
			state = 'code';
			continue;
		}
		if (literals && char !== '\n') out[i] = ' ';
	}

	return out.join('');
}

const CALL = new RegExp(`(?:^|[^\\w$.])(${SPAWNERS.join('|')})\\s*\\(`, 'g');
const NAME = new RegExp(`(?:^|[^\\w$.])(${SPAWNERS.join('|')})\\b`, 'g');
const STATIC_CHILD_PROCESS =
	/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g;
const DYNAMIC_CHILD_PROCESS = /import\s*\(\s*['"`](?:node:)?child_process['"`]/g;

interface Scanned {
	/** Repository-relative, so a failure names a file a reader can open. */
	path: string;
	/** Spawner names called in executable code. */
	codeCalls: string[];
	/** Spawner names appearing anywhere outside a comment, literals included. */
	textNames: string[];
	/** Names a real import statement takes from `node:child_process`. */
	childProcessBindings: string[];
	/** True when executable code contains `import('node:child_process')`. */
	dynamicChildProcess: boolean;
	/** Routes that would reach the module without an import statement. */
	otherRoutes: string[];
}

function sourceFiles(): string[] {
	const found: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith('.ts')) found.push(path);
		}
	};
	walk(KIT_SRC);
	return found.sort();
}

function scan(path: string): Scanned {
	const source = readFileSync(path, 'utf8');
	const text = strip(source, false);
	const code = strip(source, true);

	const names = (pattern: RegExp, subject: string): string[] => {
		pattern.lastIndex = 0;
		const found = new Set<string>();
		let match;
		while ((match = pattern.exec(subject)) !== null) found.add(match[1] as string);
		return [...found].sort();
	};

	/**
	 * True when the match sits in executable code rather than inside a literal.
	 *
	 * The pattern has to run over `text`, because the specifier it needs is itself a string
	 * literal and `code` has stripped it. Testing that the keyword survived into `code` at
	 * the same index is what separates a real import from the same words inside a generated
	 * file's source.
	 */
	const inCode = (index: number): boolean => code.startsWith('import', index);

	const bindings = new Set<string>();
	STATIC_CHILD_PROCESS.lastIndex = 0;
	let staticMatch;
	while ((staticMatch = STATIC_CHILD_PROCESS.exec(text)) !== null) {
		if (!inCode(staticMatch.index)) continue;
		for (const name of (staticMatch[1] as string).split(',')) {
			const cleaned = name
				.trim()
				.split(/\s+as\s+/)[0]
				?.trim();
			if (cleaned !== undefined && cleaned !== '') bindings.add(cleaned);
		}
	}

	let dynamic = false;
	DYNAMIC_CHILD_PROCESS.lastIndex = 0;
	let dynamicMatch;
	while ((dynamicMatch = DYNAMIC_CHILD_PROCESS.exec(text)) !== null) {
		if (inCode(dynamicMatch.index)) dynamic = true;
	}

	const otherRoutes: string[] = [];
	for (const [label, pattern] of [
		['require', /(?:^|[^\w$.])require\s*\(/],
		['createRequire', /(?:^|[^\w$.])createRequire\s*\(/],
		['eval', /(?:^|[^\w$.])eval\s*\(/],
		['new Function', /(?:^|[^\w$.])new\s+Function\s*\(/],
		['process.binding', /process\s*\.\s*binding\s*\(/],
	] as const) {
		if (pattern.test(code)) otherRoutes.push(label);
	}

	return {
		path: relative(REPO_ROOT, path),
		codeCalls: names(CALL, code),
		textNames: names(NAME, text),
		childProcessBindings: [...bindings].sort(),
		dynamicChildProcess: dynamic,
		otherRoutes,
	};
}

const SCANNED = sourceFiles().map(scan);

describe('the scan itself', () => {
	test('it read every TypeScript file under kit/src', () => {
		// A count with an expectation derived from the filesystem rather than a literal. A
		// walk that silently found nothing satisfies every assertion below.
		expect(SCANNED.length).toBe(sourceFiles().length);
		expect(SCANNED.length).toBeGreaterThan(50);
		expect(SCANNED.map((file) => file.path)).toContain(SPAWN_SITE);
	});

	test('stripping literals hides generated source and keeps real code', () => {
		// The positive and negative control on the tool the rest of this file rests on.
		// Without the first, every assertion below could be green because the stripper ate the
		// file; without the second, because it ate everything.
		const template = SCANNED.find((file) => file.path === 'kit/src/wiring/templates.ts');
		expect(template?.textNames).toContain('execFileSync');
		expect(template?.codeCalls).toEqual([]);
		expect(template?.childProcessBindings).toEqual([]);

		const site = SCANNED.find((file) => file.path === SPAWN_SITE);
		expect(site?.codeCalls).toEqual(['spawnSync']);
	});

	test('the stripper handles the constructs this package actually contains', () => {
		// A regex holding a quote, an escaped quote inside a string, a template with an
		// interpolation, and a comment containing code. Every one of these appears in
		// `kit/src`, and each would put the state machine into the wrong state for the rest of
		// the file, which is a silent pass rather than a failure.
		const sample = [
			'const q = /[\'"]/;',
			"const s = 'it\\'s fine';",
			'const t = `a ${spawnSync(1)} b`;',
			'// spawnSync(2)',
			'/* execSync(3) */',
			'spawnSync(4);',
		].join('\n');
		const code = strip(sample, true);
		expect(code).toContain('spawnSync(4)');
		expect(code).not.toContain('spawnSync(1)');
		expect(code).not.toContain('spawnSync(2)');
		expect(code).not.toContain('execSync(3)');
		// Offsets survive, which is what the import check depends on.
		expect(strip(sample, false)).toHaveLength(sample.length);
		expect(code).toHaveLength(sample.length);
	});
});

describe('exactly one module can start a process', () => {
	test('node:child_process is imported by one file, in both directions', () => {
		const importers = SCANNED.filter((file) => file.childProcessBindings.length > 0).map(
			(file) => file.path,
		);
		expect(importers).toEqual([SPAWN_SITE]);
	});

	test('that import takes exactly one name', () => {
		// `spawnSync` and nothing else. An `exec` or `execSync` added here would give the
		// package a way to hand a string to a shell, which is what `shell: false` and the argv
		// array exist to make impossible.
		const site = SCANNED.find((file) => file.path === SPAWN_SITE);
		expect(site?.childProcessBindings).toEqual(['spawnSync']);
	});

	test('no other file calls a child-process function', () => {
		const offenders = SCANNED.filter(
			(file) =>
				file.path !== SPAWN_SITE && file.codeCalls.some((name) => UNAMBIGUOUS.includes(name)),
		).map((file) => `${file.path}: ${file.codeCalls.join(', ')}`);
		expect(offenders).toEqual([]);
	});

	test('every bare exec() call is the injected runner, not a child process', () => {
		// `exec` is too common a name to assert on directly, so the assertion is the property
		// that makes the name safe: a file calling `exec(` imports nothing from
		// `node:child_process`, so the binding it calls cannot be that module's `exec`. This
		// needs no list and admits no exemption.
		const callers = SCANNED.filter((file) => file.codeCalls.includes('exec'));
		const wrong = callers
			.filter((file) => file.childProcessBindings.length > 0)
			.map((file) => file.path);
		expect(wrong).toEqual([]);
		// Not vacuous: `Ctx.exec` really is destructured and called somewhere, so this test
		// examined something. One caller satisfies it, and that is the limit.
		expect(callers.length, 'no file calls exec(), so this test examined nothing').toBeGreaterThan(
			0,
		);
	});

	test('there is no second route to child_process', () => {
		// The import assertion is a proof only while an import is the only way in. A dynamic
		// import, CommonJS `require`, `createRequire`, `eval` and `new Function` are the five
		// that would each open one, and none of them belongs in a package that is ESM,
		// `verbatimModuleSyntax` and typechecked.
		const routes = SCANNED.flatMap((file) => [
			...file.otherRoutes.map((route) => `${file.path}: ${route}`),
			...(file.dynamicChildProcess ? [`${file.path}: a dynamic import of child_process`] : []),
		]);
		expect(routes).toEqual([]);
	});
});

describe('the raw text, so a grep and this file agree', () => {
	test('the files naming a spawner in text only are exactly the declared ones', () => {
		const declared = IN_TEXT_ONLY.map((entry) => entry.path).sort();
		const found = SCANNED.filter(
			(file) =>
				file.path !== SPAWN_SITE &&
				file.textNames.some((name) => UNAMBIGUOUS.includes(name)) &&
				!file.codeCalls.some((name) => UNAMBIGUOUS.includes(name)),
		)
			.map((file) => file.path)
			.sort();
		expect(found).toEqual(declared);
	});

	test('every declared file still names the spawner it was declared for', () => {
		const problems: string[] = [];
		for (const entry of IN_TEXT_ONLY) {
			const file = SCANNED.find((scanned) => scanned.path === entry.path);
			if (file === undefined) {
				problems.push(`${entry.path} is declared and is not under kit/src`);
				continue;
			}
			for (const name of entry.names) {
				if (!file.textNames.includes(name)) {
					problems.push(`${entry.path} is declared for ${name} and no longer names it`);
				}
			}
			// A one-line reason is an exemption nobody decided on, which is the rule
			// `fixtures/planted.json` already applies to its own groups.
			if (entry.why.length < 80) {
				problems.push(`${entry.path} has a reason too short to be a decision`);
			}
		}
		expect(problems).toEqual([]);
	});
});
