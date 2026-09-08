#!/usr/bin/env node
/**
 * The zero-dependency gate.
 *
 * The runtime half is consumed as TypeScript source through a `tsconfig` `paths`
 * entry, and it is excluded from the consuming website's pnpm workspace, so nothing
 * it imports is ever installed there. A bare import that resolves here, against this
 * repository's own devDependencies, resolves to nothing in `hex-web`. The build
 * fails inside a submodule, during `prebuild`, on a deploy.
 *
 * Checking `package.json` for a `dependencies` key catches one way to cause that.
 * Reading every specifier in `src/` catches the rest, which is why this walks the
 * files rather than trusting the manifest.
 *
 * Tests live in `test/`, not beside the code. That is what lets this gate have no
 * exemptions at all: there is no file under `src/` that is allowed to import
 * something a consumer will not have, so there is no rule for someone to widen.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { check, render } from './lib/report.mjs';
import { classifySpecifier, packageOf, scanImports } from './lib/scan-imports.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Everything the runtime half may import from outside itself.
 *
 * React is here because it is a peer dependency: every consumer is a React Router 7
 * site and already has it. Nothing else qualifies, and the bar for adding a second
 * entry is that every current and future consumer already depends on it for its own
 * reasons.
 */
const ALLOWED_PACKAGES = new Set(['react']);

/** Extensions a relative import may carry. */
const RELATIVE_EXTENSIONS = ['.js', '.css', '.json'];

/**
 * @param {string} dir
 * @param {string[]} extensions
 * @returns {string[]}
 */
function walk(dir, extensions) {
	/** @type {string[]} */
	const found = [];
	/** @type {string[]} */
	const queue = [dir];

	while (queue.length > 0) {
		const current = /** @type {string} */ (queue.pop());
		/** @type {import('node:fs').Dirent[]} */
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			// Refuse symlinks rather than following them. A symlink is the only way a
			// checked-out tree can point outside itself, and a gate that walks through
			// one is reporting on files that are not in the package.
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
				queue.push(full);
			} else if (extensions.some((extension) => entry.name.endsWith(extension))) {
				found.push(full);
			}
		}
	}

	return found.sort();
}

/**
 * @param {string} [root] The package to check. Parameterised so the suite can point
 *   it at a fixture with a deliberate violation: a guard whose failure path is never
 *   exercised is a guard nobody knows the output of until the day it fires.
 * @returns {import('./lib/report.mjs').CheckResult[]}
 */
export function run(root = ROOT) {
	/** @type {import('./lib/report.mjs').CheckResult[]} */
	const results = [];
	const src = join(root, 'src');

	// ---- the manifest ----------------------------------------------------
	const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

	/** @type {string[]} */
	const manifestProblems = [];
	let manifestFields = 0;

	for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies']) {
		manifestFields += 1;
		const value = manifest[field];
		const names = value === undefined ? [] : Object.keys(value);
		if (names.length > 0) {
			manifestProblems.push(
				`package.json "${field}" must be empty. Found: ${names.join(', ')}. ` +
					`A consuming website excludes this package from its workspace, so nothing here is ever installed.`,
			);
		}
	}

	manifestFields += 1;
	const peers = Object.keys(manifest.peerDependencies ?? {});
	for (const peer of peers) {
		if (!ALLOWED_PACKAGES.has(peer)) {
			manifestProblems.push(
				`package.json "peerDependencies" lists "${peer}", which is not on the runtime allowlist. ` +
					`Only ${[...ALLOWED_PACKAGES].join(', ')} may be required of a consumer.`,
			);
		}
	}

	results.push(
		check('package.json manifest', manifestFields, 'dependency fields', manifestProblems, {
			note: peers.length > 0 ? `peers: ${peers.join(', ')}` : 'no peer dependencies declared',
		}),
	);

	// ---- the import graph ------------------------------------------------
	const files = walk(src, ['.ts', '.tsx']);

	/** @type {string[]} */
	const bareProblems = [];
	/** @type {string[]} */
	const builtinProblems = [];
	/** @type {string[]} */
	const extensionProblems = [];
	/** @type {string[]} */
	const escapeProblems = [];

	let specifiers = 0;
	/** @type {Set<string>} */
	const usedPackages = new Set();

	for (const file of files) {
		const where = relative(root, file);
		const source = readFileSync(file, 'utf8');

		for (const record of scanImports(source)) {
			specifiers += 1;

			if (record.form === 'computed') {
				escapeProblems.push(
					`${where}:${record.line} builds an import specifier at runtime. ` +
						`This gate cannot see where it resolves, so it cannot check it. ` +
						`Use a static import, or an import.meta.glob, which Vite can analyse.`,
				);
				continue;
			}

			const kind = classifySpecifier(record.specifier);

			if (kind === 'bare') {
				const pkg = packageOf(record.specifier);
				usedPackages.add(pkg);
				if (!ALLOWED_PACKAGES.has(pkg)) {
					bareProblems.push(
						`${where}:${record.line} imports "${record.specifier}". ` +
							`The runtime half may only import ${[...ALLOWED_PACKAGES].join(', ')}.`,
					);
				} else if (!peers.includes(pkg)) {
					bareProblems.push(
						`${where}:${record.line} imports "${record.specifier}" but "${pkg}" is not a peerDependency. ` +
							`A consumer would have no way to know it needs it.`,
					);
				}
				continue;
			}

			if (kind === 'builtin') {
				builtinProblems.push(
					`${where}:${record.line} imports "${record.specifier}". ` +
						`The runtime half runs in a browser; node builtins belong in kit/.`,
				);
				continue;
			}

			if (kind === 'absolute') {
				escapeProblems.push(
					`${where}:${record.line} imports "${record.specifier}", an absolute path. ` +
						`It will not resolve on another machine.`,
				);
				continue;
			}

			if (!RELATIVE_EXTENSIONS.some((extension) => record.specifier.endsWith(extension))) {
				extensionProblems.push(
					`${where}:${record.line} imports "${record.specifier}" with no extension. ` +
						`Relative imports carry a ".js" extension here, matching @hex-pro/i18n.`,
				);
			}

			const target = posix.normalize(
				posix.join(posix.dirname(where.split('\\').join('/')), record.specifier),
			);
			if (!target.startsWith('src/')) {
				escapeProblems.push(
					`${where}:${record.line} imports "${record.specifier}", which resolves to "${target}", outside src/. ` +
						`The runtime half never reaches into kit/: kit depends on src, not the other way round.`,
				);
			}
		}
	}

	results.push(
		check('src/ imports no packages', specifiers, 'specifiers', bareProblems, {
			note:
				usedPackages.size > 0
					? `packages used: ${[...usedPackages].sort().join(', ')}`
					: 'no package imports at all',
		}),
	);
	results.push(check('src/ imports no node builtins', files.length, 'files', builtinProblems));
	results.push(check('relative imports carry .js', specifiers, 'specifiers', extensionProblems));
	results.push(
		check('src/ does not reach outside itself', specifiers, 'specifiers', escapeProblems),
	);

	return results;
}

/**
 * Only when invoked directly. Exporting `run` lets the suite exercise the checks
 * without spawning a process, and a guard that cannot be tested is a guard nobody
 * knows the failure output of until it fires.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { ok } = render('hex-docs runtime dependency gate', run());
	process.exit(ok ? 0 : 1);
}
