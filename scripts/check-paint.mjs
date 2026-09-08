#!/usr/bin/env node
/**
 * The token contract, checked in a real browser.
 *
 * `src/contracts/theme.ts` names the one check that catches the defect it exists to
 * prevent: render the shell under a theme class and assert the computed accent actually
 * differs. Everything else about the stylesheet is a property of its text and is asserted
 * in `kit/test/theme/stylesheet.test.ts`; this is the property only a CSS engine has an
 * opinion about.
 *
 * ## Why a browser rather than a DOM library
 *
 * Measured, both ways, before this was written.
 *
 *   jsdom      correct stylesheet  color="var(--hx-accent-link, var(--color-accent, ...))"
 *   jsdom      broken  stylesheet  color="var(--hx-accent-link)"
 *   happy-dom  correct stylesheet  #ff6600
 *   happy-dom  broken  stylesheet  #ff6600
 *
 * jsdom does not resolve `var()` at all and hands back the literal text. happy-dom does
 * resolve it, and resolves it at the point of use, which is the opposite of what a browser
 * does: it therefore returns the correct colour for the exact stylesheet bug this check
 * exists to catch, so a theme test written against it passes on the broken version and is
 * worse than no test.
 *
 * ## Why there is a descendant case
 *
 * The check the contract prescribes puts the theme class above the docs root. Measured:
 * the obvious optimisation, declaring one private alias per token on the docs root so the
 * chain is written once, passes that check and fails for anything at or below the root.
 *
 *   case                      chain at every use site   alias on the docs root
 *   theme on an ancestor      themed                    themed
 *   theme on the docs root    themed                    themed
 *   theme on a descendant     themed                    NOT themed
 *   --hx-* on a descendant    themed                    NOT themed
 *
 * So the last two cases are the ones that make this row worth running, and a check with
 * only the first two would have signed off the version that is wrong.
 *
 * ## No dependency
 *
 * Node 22 has a global `WebSocket`, so driving Chrome over the DevTools Protocol is
 * `spawn` plus JSON. GitHub's ubuntu-24.04 image ships Google Chrome and Chromium
 * preinstalled, so this needs no install step in CI either.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { check, renderAndExit, skipped } from './lib/report.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Where a browser might be. `HEXDOCS_CHROME` wins, so a developer with one somewhere else
 * can point at it rather than being told the row was skipped.
 */
const CANDIDATES = [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
];

export function findBrowser() {
	const named = process.env.HEXDOCS_CHROME;
	if (named !== undefined && named !== '') return existsSync(named) ? named : undefined;
	return CANDIDATES.find((path) => existsSync(path));
}

/**
 * The page every probe runs against.
 *
 * It is the package's own stylesheet, unmodified, plus the smallest markup that carries
 * the classes the probes read. A hand-written stylesheet here would be checking something
 * this package does not ship.
 *
 * @param {string} css
 * @param {string} body
 */
const page = (css, body) => `<!doctype html><meta charset="utf-8"><style>${css}</style>${body}`;

/** @typedef {{ id: string, body: string, expression: string, why: string }} Probe */

/**
 * `--color-accent` stands in for a consuming site's own token, and `.themed` for one of
 * its per-app classes. The package's accent token has no host link, so what is being
 * checked is the `--hx-*` override, which is the documented way a consumer themes this.
 *
 * @param {string} className
 */
const link = (className) =>
	`<div class="hx-root ${className}"><div class="hx-prose"><p><a id="t" href="#x">x</a></p></div></div>`;

/** @type {Probe[]} */
const PROBES = [
	{
		id: 'baseline',
		body: link(''),
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'An unthemed page paints the package literal.',
	},
	{
		id: 'ancestor',
		body: `<div style="--hx-accent-link:#ff6600">${link('')}</div>`,
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'A token rebound above the docs root reaches the link. This is the case the contract prescribes.',
	},
	{
		id: 'root',
		body: link('').replace('class="hx-root "', 'class="hx-root" style="--hx-accent-link:#ff6600"'),
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'A token rebound on the docs root itself reaches the link.',
	},
	{
		id: 'descendant',
		body: `<div class="hx-root"><div class="hx-prose" style="--hx-accent-link:#ff6600"><p><a id="t" href="#x">x</a></p></div></div>`,
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'A token rebound BELOW the docs root reaches the link. This is the case an alias declared on the root would fail, and the reason this row exists.',
	},
	{
		id: 'code-scope',
		body: `<div class="hx-root"><pre class="hx-pre"><code><span class="hx-s-keyword" id="t">let</span></code></pre></div>`,
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'A highlight scope is painted from the palette rather than inheriting the body colour.',
	},
	{
		id: 'code-scope-override',
		body: `<div class="hx-root"><pre class="hx-pre" style="--hx-code-key:#ff6600"><code><span class="hx-s-keyword" id="t">let</span></code></pre></div>`,
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'A palette colour is overridable the same way a theme token is, which is what makes the two tables one contract.',
	},
	{
		id: 'sr-only',
		body: `<div class="hx-root"><span class="hx-sr" id="t">hidden</span></div>`,
		expression: `JSON.stringify([getComputedStyle(document.getElementById('t')).position, document.getElementById('t').getBoundingClientRect().width < 2])`,
		why: 'The visually hidden helper is clipped rather than removed, so assistive technology still reads it.',
	},
];

const ORANGE = 'rgb(255, 102, 0)';

/**
 * @param {string} binary
 * @param {Probe[]} probes
 * @param {string} root  Where to read the stylesheet from, so the failure path can be
 *   driven against a deliberately broken one the way the other guards are.
 * @returns {Promise<Record<string, string>>}
 */
async function measure(binary, probes, root) {
	const css = readFileSync(join(root, 'src', 'render', 'docs.css'), 'utf8');
	const profile = mkdtempSync(join(tmpdir(), 'hexdocs-chrome-'));
	const child = spawn(
		binary,
		[
			'--headless=new',
			'--remote-debugging-port=0',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-gpu',
			'--disable-dev-shm-usage',
			'--no-sandbox',
			`--user-data-dir=${profile}`,
			'about:blank',
		],
		{ stdio: ['ignore', 'ignore', 'pipe'] },
	);

	/** @type {Record<string, string>} */
	const measured = {};
	try {
		const url = await new Promise((res, rej) => {
			let buffer = '';
			const timer = setTimeout(() => rej(new Error('no devtools endpoint after 30s')), 30_000);
			child.on('exit', (code) => {
				clearTimeout(timer);
				rej(new Error(`browser exited ${code}: ${buffer.slice(-300)}`));
			});
			child.stderr.on('data', (chunk) => {
				buffer += chunk;
				const found = /ws:\/\/\S+/.exec(buffer);
				if (found !== null) {
					clearTimeout(timer);
					res(found[0]);
				}
			});
		});

		const socket = new WebSocket(url);
		await new Promise((res, rej) => {
			socket.addEventListener('open', res, { once: true });
			socket.addEventListener('error', () => rej(new Error('devtools socket refused')), {
				once: true,
			});
		});

		let id = 0;
		/** @type {Map<number, (value: any) => void>} */
		const pending = new Map();
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			const resolve_ = pending.get(message.id);
			if (resolve_ !== undefined) {
				pending.delete(message.id);
				resolve_(message);
			}
		});
		/**
		 * @param {string} method
		 * @param {object} [params]
		 * @param {string} [session]
		 */
		const send = (method, params = {}, session) =>
			new Promise((res, rej) => {
				const next = (id += 1);
				const timer = setTimeout(() => {
					pending.delete(next);
					rej(new Error(`${method} timed out`));
				}, 20_000);
				pending.set(next, (message) => {
					clearTimeout(timer);
					if (message.error !== undefined) rej(new Error(`${method}: ${message.error.message}`));
					else res(message.result);
				});
				socket.send(
					JSON.stringify({ id: next, method, params, ...(session ? { sessionId: session } : {}) }),
				);
			});

		const target = /** @type {any} */ (await send('Target.createTarget', { url: 'about:blank' }));
		const attached = /** @type {any} */ (
			await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
		);
		const session = attached.sessionId;
		await send('Page.enable', {}, session);
		const tree = /** @type {any} */ (await send('Page.getFrameTree', {}, session));
		const frameId = tree.frameTree.frame.id;

		for (const probe of probes) {
			await send('Page.setDocumentContent', { frameId, html: page(css, probe.body) }, session);
			const evaluated = /** @type {any} */ (
				await send(
					'Runtime.evaluate',
					{ expression: probe.expression, returnByValue: true },
					session,
				)
			);
			if (evaluated.exceptionDetails !== undefined) {
				throw new Error(`${probe.id}: ${evaluated.exceptionDetails.text}`);
			}
			measured[probe.id] = String(evaluated.result.value);
		}
		socket.close();
	} finally {
		child.kill('SIGKILL');
		try {
			rmSync(profile, { recursive: true, force: true });
		} catch {
			// A profile directory that could not be removed is not a reason to fail a check
			// about colours. The temp directory is the operating system's problem.
		}
	}
	return measured;
}

/**
 * @param {string} [root]
 * @returns {Promise<import('./lib/report.mjs').CheckResult[]>}
 */
export async function run(root = ROOT) {
	const binary = findBrowser();
	if (binary === undefined) {
		const reason =
			'No Chrome or Chromium found. Set HEXDOCS_CHROME to one, or run this where a browser is installed.';
		if (process.env.CI === 'true') {
			// SKIPPED is a deliberate, explained non-run. In CI it is not deliberate: the
			// runner image ships Chrome, so a missing browser there means the environment
			// changed under the check rather than that somebody chose to skip it.
			return [
				check('theme contract in a browser', 0, 'probes', [
					`${reason} CI runs on an image that ships one, so this is a broken environment rather than a skip.`,
				]),
			];
		}
		return [skipped('theme contract in a browser', 'probes', reason)];
	}

	/** @type {string[]} */
	const problems = [];
	/** @type {Record<string, string>} */
	let measured = {};
	try {
		measured = await measure(binary, PROBES, root);
	} catch (error) {
		return [
			check('theme contract in a browser', 0, 'probes', [
				`Could not measure with ${binary}: ${error instanceof Error ? error.message : String(error)}`,
			]),
		];
	}

	const baseline = measured.baseline;
	if (baseline === undefined || !/^rgb/.test(baseline)) {
		problems.push(`The unthemed link colour did not resolve at all: ${String(baseline)}.`);
	}

	for (const id of ['ancestor', 'root', 'descendant']) {
		const probe = PROBES.find((entry) => entry.id === id);
		if (measured[id] !== ORANGE) {
			problems.push(
				`An override on the ${id} did not reach the link: expected ${ORANGE}, got ${String(measured[id])}. ${probe?.why ?? ''}`,
			);
		}
	}

	if (measured['code-scope'] === baseline) {
		problems.push(
			'A highlight scope painted the same colour as an inline link, which means the palette rule is not reaching it.',
		);
	}
	if (measured['code-scope-override'] !== ORANGE) {
		problems.push(
			`Overriding a palette colour did not reach the token span: got ${String(measured['code-scope-override'])}.`,
		);
	}

	const hidden = measured['sr-only'];
	if (hidden !== '["absolute",true]') {
		problems.push(
			`The visually hidden helper measured ${String(hidden)} rather than a clipped absolute box.`,
		);
	}

	return [
		check('theme contract in a browser', PROBES.length, 'probes', problems, {
			note: binary.split('/').pop() ?? binary,
		}),
	];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	renderAndExit('hex-docs paint', await run());
}
