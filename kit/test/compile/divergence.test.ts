/**
 * The cases where two halves of one bundle disagreed about the same page.
 *
 * Every test here perturbs the corpus rather than reading it, because the corpus reaches
 * none of these: each was found by an adversarial review and each was green in 1599
 * tests. That is the shape they have in common. The compiler builds several
 * representations of one address (a page payload, a search index, raw markdown, a
 * manifest record, a coverage row) and any two of them can be built from different lists.
 * A reader meets the disagreement, never the build: a search result with no page behind
 * it, a Japanese page with an English fragment in it, a coverage row that counts an
 * untranslated page as translated.
 *
 * A `describe` here is one perturbation. The corpus is materialised once and copied per
 * test, because materialising replays eight commits and costs about a second and a half,
 * and because a test that mutates the tree must not be able to reach the next one.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import { SOURCE_LOCALE, type Locale } from '../../../src/contracts/locales.js';
import { pageKey, rawKey, searchKey } from '../../../src/contracts/manifest.js';
import { compiledPageSchema } from '../../src/contracts/bundle.schema.js';
import { buildBundle, type BuildResult } from '../../src/compile/build.js';

const GENERATOR = '@hex-pro/docs-kit@0.1.0';

let root: string;
let template: string;
let copies = 0;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-divergence-'));
	template = materialiseCorpus(join(root, 'template')).root;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A private copy of the materialised corpus, git history and all. */
function corpus(): string {
	copies += 1;
	const target = join(root, `copy-${copies}`);
	cpSync(template, target, { recursive: true, dereference: false, verbatimSymlinks: true });
	return target;
}

const site = (repo: string, path: string): string => join(repo, 'docs', 'site', path);

/**
 * Commits what is in the tree, so the perturbed file has a committer date.
 *
 * Without one `dateOf` returns undefined and every state falls back to `current`, which
 * would make a staleness assertion below pass for the wrong reason.
 */
function commit(repo: string, message: string): void {
	execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['commit', '-m', message, '--no-verify'], {
		cwd: repo,
		stdio: 'ignore',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
			GIT_AUTHOR_DATE: '2026-06-01T00:00:00Z',
			GIT_COMMITTER_DATE: '2026-06-01T00:00:00Z',
		},
	});
}

const build = (repo: string): BuildResult => buildBundle(repo, { generator: GENERATOR });

/** One object out of the bundle, gunzipped and parsed. */
function objectJson(result: BuildResult, key: string): Record<string, unknown> {
	const object = result.objects.find((candidate) => candidate.key === key);
	expect(object, `${key} is not in the bundle`).toBeDefined();
	return JSON.parse(gunzipSync((object as { bytes: Buffer }).bytes).toString('utf8')) as Record<
		string,
		unknown
	>;
}

function objectText(result: BuildResult, key: string): string {
	const object = result.objects.find((candidate) => candidate.key === key);
	expect(object, `${key} is not in the bundle`).toBeDefined();
	return gunzipSync((object as { bytes: Buffer }).bytes).toString('utf8');
}

describe('a page with no source-locale file', () => {
	test('is in neither the manifest nor any search index', () => {
		// The page-record loop skipped a slug with no English file; the search loop iterated
		// the same published set without that guard. So a French reader searched, got a row
		// that rendered correctly with the real title, clicked it, and the bundle carried no
		// payload to render. `prefetch` reads `manifest.objects` and had downloaded nothing,
		// so the 404 was structural rather than a cache miss, and the only finding raised was
		// `translation-missing`, a warning under the default parity.
		const repo = corpus();
		writeFileSync(
			site(repo, 'content/fr/secours.md'),
			'---\ntitle: Secours\ndescription: Une page qui n’existe qu’en français.\n---\n\n## Première étape\n\nAppuyez sur le bouton.\n',
		);
		commit(repo, 'add a French-only page');

		const result = build(repo);
		expect(Object.keys(result.manifest.pages)).not.toContain('secours');
		expect(result.objects.map((object) => object.key)).not.toContain(pageKey('fr', 'secours'));

		const index = objectJson(result, searchKey('fr'));
		const docs = index.docs as { slug: string }[];
		expect(docs.map((doc) => doc.slug)).not.toContain('secours');
		// Both directions: every slug the index does carry has a manifest record, which is
		// the invariant the manifest states for nav and redirects and cannot check here
		// because it cannot see inside a gzipped object.
		for (const doc of docs) expect(Object.keys(result.manifest.pages)).toContain(doc.slug);
	});
});

describe('two asset files with identical bytes', () => {
	test('publish one record and one object', () => {
		// `assetBytes` was keyed by digest and deduped nothing that reached the manifest,
		// because the records and the object list were built once per path. The comment
		// above it claimed the opposite, which is the worse half: it is how the guard got
		// trusted.
		const repo = corpus();
		const original = readFileSync(site(repo, 'assets/scan-screen.png'));
		writeFileSync(site(repo, 'assets/scan-screen-copy.png'), original);
		commit(repo, 'copy an asset under a second name');

		const result = build(repo);
		expect(result.manifestProblems).toEqual([]);

		const digests = result.manifest.assets.map((asset) => asset.sha256);
		expect(new Set(digests).size).toBe(digests.length);

		const keys = result.objects.map((object) => object.key);
		expect(new Set(keys).size).toBe(keys.length);
		expect(result.manifest.counts.objects).toBe(new Set(keys).size);
	});
});

describe('a link to a draft', () => {
	test('is reported, because the bundle does not carry the draft', () => {
		// The resolver was handed every slug rather than the published set, so a published
		// page could link to a page held back as a draft and `link-resolves` said nothing.
		// A draft is the page most likely to be linked before it is ready, which is what
		// makes this the case the rule exists for.
		const repo = corpus();
		const page = site(repo, 'content/en/index.md');
		writeFileSync(
			page,
			`${readFileSync(page, 'utf8')}\nSee the [scratch notes](notes/scratch.md) as well.\n`,
		);
		commit(repo, 'link a draft from a published page');

		const result = build(repo);
		const reported = result.lint.envelope.findings.filter(
			(finding) => finding.rule === 'link-resolves' && finding.message.includes('notes/scratch'),
		);
		expect(reported).toHaveLength(1);
		expect(reported[0]?.severity).toBe('error');
	});

	test('resolves when the drafts are in the bundle', () => {
		// The preview build. Narrowing the target set must not break the one mode where the
		// draft really is published, which is the way this fix could have been wrong.
		const repo = corpus();
		const page = site(repo, 'content/en/index.md');
		writeFileSync(
			page,
			`${readFileSync(page, 'utf8')}\nSee the [scratch notes](notes/scratch.md) as well.\n`,
		);
		commit(repo, 'link a draft from a published page');

		const result = buildBundle(repo, { generator: GENERATOR, includeDrafts: true });
		expect(
			result.lint.envelope.findings.filter((finding) => finding.rule === 'link-resolves'),
		).toHaveLength(0);
		expect(Object.keys(result.manifest.pages)).toContain('notes/scratch');
	});
});

describe('a scaffolded snippet', () => {
	test('makes the page that includes it read scaffolded', () => {
		// A snippet's state came from git dates alone, so it could never be `scaffolded`, so
		// the worst-of reduction had nothing to reduce. The Chinese page rendered the English
		// legend table verbatim and published as `current`, its coverage row counted it as
		// translated, and the lint summary was byte-identical to a clean build.
		const repo = corpus();
		const english = readFileSync(site(repo, 'snippets/en/legend.md'), 'utf8');
		const body = english.slice(english.indexOf('---', 3) + 3);
		writeFileSync(
			site(repo, 'snippets/zh/legend.md'),
			`---\ntitle: 图例\ntranslated: false\n---\n${body}`,
		);
		commit(repo, 'scaffold the Chinese legend');

		const result = build(repo);
		const compiled = result.pages.get('reference/chip-support');
		expect(compiled?.get('zh')?.page.translation.state).toBe('scaffolded');

		// The manifest keeps the page's own state and the coverage row counts that, both
		// deliberately: a translator needs to know which files to open, and this page's own
		// Chinese file is translated. The effective state above is what the reader's notice
		// shows. Asserting both here is what stops a later change collapsing the two into
		// one number, which would either hide the notice or send a translator to a file
		// that is already done.
		expect(result.manifest.pages['reference/chip-support']?.locales.zh?.state).toBe('current');
		expect(result.manifest.coverage.zh?.scaffolded).toBe(0);
	});

	test('and the source locale is still the source', () => {
		// The English snippet is byte-identical to itself, which is the input that would
		// make a body comparison call the source language scaffolded.
		const result = build(corpus());
		const compiled = result.pages.get('reference/chip-support');
		expect(compiled?.get('en')?.page.translation.state).toBe('source');
		expect(result.manifest.pages['reference/chip-support']?.locales.en?.state).toBe('source');
	});
});

describe('a snippet a locale does not have', () => {
	test('does not put the source language into that locale’s raw markdown', () => {
		// The AST half refuses this fallback and its remediation says why: it injects
		// English into a translated page while the page still reads current. The raw
		// markdown half did exactly what the resolver refuses, so `<slug>.md` and
		// `llms-full.txt` served a Japanese page with an English table inside it while the
		// page payload for the same address correctly dropped the include.
		const repo = corpus();
		rmSync(site(repo, 'snippets/ja/legend.md'));
		commit(repo, 'delete the Japanese legend');

		const result = build(repo);
		const raw = objectText(result, rawKey('ja', 'reference/chip-support'));
		const english = readFileSync(site(repo, 'snippets/en/legend.md'), 'utf8');
		const marker = (english.match(/^\|.*$/m) as string[])[0] as string;
		expect(raw).not.toContain(marker);
		expect(raw).toContain('::include[legend]');
		expect(
			result.lint.envelope.findings.some((finding) => finding.rule === 'snippet-resolves'),
		).toBe(true);
	});
});

describe('a fence that documents the authoring syntax', () => {
	test('is not rewritten in the raw markdown', () => {
		// `rawMarkdown` walked the source lines with no block state, so both of its rewrites
		// fired inside a code fence: an `::include` sample was replaced by the snippet's
		// whole body and a sample comment was deleted, while the rendered page correctly
		// showed both as code. Two published representations of one address disagreed and
		// nothing reported it.
		const repo = corpus();
		const page = site(repo, 'content/en/reference/api.md');
		writeFileSync(
			page,
			`${readFileSync(page, 'utf8')}\n## Authoring\n\n\`\`\`markdown\n::include[safety-note]\n<!-- a comment shown as part of the sample -->\n\`\`\`\n`,
		);
		commit(repo, 'document the authoring syntax in a fence');

		const result = build(repo);
		const raw = objectText(result, rawKey(SOURCE_LOCALE as Locale, 'reference/api'));
		expect(raw).toContain('::include[safety-note]');
		expect(raw).toContain('<!-- a comment shown as part of the sample -->');
		// The include outside a fence is still expanded, so this is not a fence-shaped way
		// of turning the expansion off.
		const chip = objectText(result, rawKey(SOURCE_LOCALE as Locale, 'reference/chip-support'));
		expect(chip).not.toContain('::include[legend]');
	});
});

describe('the deny scan', () => {
	test('reads a fence body, inline code and a link target', () => {
		// Both deny rules read `ProseSegment`s, which have inline code removed and code
		// fences never present. So a device UDID in a sample command, an internal tree name
		// in backticks and either of them in a link href were invisible, and every one of
		// those bytes is published in both the page payload and the raw markdown. The
		// contract for the deny list already said the scan covers "every published string
		// and the raw markdown", which is the half that makes this worse than a gap: the
		// rule that stands between a UDID and a public mirror was documented as covering
		// ground it did not.
		const repo = corpus();
		writeFileSync(
			site(repo, 'content/en/developer/pairing.md'),
			[
				'---',
				'title: Pairing a test device',
				'description: How the rig is paired before a run.',
				'---',
				'',
				'## Pairing',
				'',
				'```bash',
				'xcrun devicectl device install app --device 00008030-001C24E60C31802E',
				'```',
				'',
				'The rig lives in `station-pack-alpha` on the build host.',
				'',
				'See the [setup notes](https://example.com/station-pack-beta/setup) for more.',
				'',
			].join('\n'),
		);
		commit(repo, 'add a page that leaks in three places prose cannot see');

		const result = build(repo);
		const onPage = result.lint.envelope.findings.filter(
			(finding) =>
				finding.location.kind === 'file' &&
				finding.location.file === 'content/en/developer/pairing.md',
		);

		const leaks = onPage.filter((finding) => finding.rule === 'internal-leak');
		const lines = leaks.map((finding) =>
			finding.location.kind === 'file' ? finding.location.line : undefined,
		);
		// The fence body, the inline code and the link href, at the lines they were typed.
		expect(lines).toEqual([9, 12, 14]);
		// The excerpt stays null on every one of them: a finding that quoted the match
		// would copy the identifier into the report, the CI log and whatever reads them
		// next, which is the whole reason this rule reports a pattern id and a line.
		for (const leak of leaks) expect(leak.excerpt).toBeNull();
	});

	test('reports one occurrence once, from the position in the file', () => {
		// The scan has two inputs and they overlap: an ordinary sentence is in the raw lines
		// and in the prose. Reporting a leak twice is how a report stops being read.
		//
		// The bold word before the name is there because it is the case that looks like it
		// should produce two positions and does not: a prose segment's run map records the
		// source column of every run, so prose and the raw line both say column 13, and
		// `runLint` collapses the pair. Asserting the column as well as the count is what
		// makes this a test of that property rather than of the count alone.
		const repo = corpus();
		writeFileSync(
			site(repo, 'content/en/developer/pairing.md'),
			[
				'---',
				'title: Pairing a test device',
				'description: How the rig is paired before a run.',
				'---',
				'',
				'## Pairing',
				'',
				'The **new** Contoso Tap reader behaves differently here.',
				'',
			].join('\n'),
		);
		commit(repo, 'name a competitor in ordinary prose');

		const result = build(repo);
		const named = result.lint.envelope.findings.filter(
			(finding) =>
				finding.rule === 'no-competitor-name' &&
				finding.location.kind === 'file' &&
				finding.location.file === 'content/en/developer/pairing.md',
		);
		expect(named).toHaveLength(1);
		const where = named[0]?.location;
		expect(where?.kind === 'file' ? [where.line, where.column] : undefined).toEqual([8, 13]);
	});

	test('still reads prose, so a name folded across a soft wrap is found', () => {
		// The one thing the raw lines cannot see. "Contoso" and "Tap" on two lines is one
		// string on the published page, and it is line by line that a hand-rolled scan
		// misses it, which is why the prose half is kept rather than replaced.
		const repo = corpus();
		writeFileSync(
			site(repo, 'content/en/developer/pairing.md'),
			[
				'---',
				'title: Pairing a test device',
				'description: How the rig is paired before a run.',
				'---',
				'',
				'## Pairing',
				'',
				'The behaviour differs from the Contoso',
				'Tap reader in one respect.',
				'',
			].join('\n'),
		);
		commit(repo, 'fold a competitor name across a soft wrap');

		const result = build(repo);
		expect(
			result.lint.envelope.findings.filter(
				(finding) =>
					finding.rule === 'no-competitor-name' &&
					finding.location.kind === 'file' &&
					finding.location.file === 'content/en/developer/pairing.md',
			),
		).toHaveLength(1);
	});
});

describe('a record the bundle would refuse on read', () => {
	test('front matter that does not validate still compiles to a valid payload', () => {
		// The fallbacks were an empty title and an empty description, and
		// `compiledPageSchema` requires content in both. So the page compiled, the manifest
		// was written, `validateManifestShape` said nothing, and the failure surfaced
		// wherever the payload was next read as a digest mismatch naming no page. The
		// fallbacks are poor on purpose; poor is not the same as invalid.
		const repo = corpus();
		writeFileSync(
			site(repo, 'content/en/reference/broken.md'),
			'---\ntitle:\naudience: nobody\n---\n\n## Section\n\nText.\n',
		);
		commit(repo, 'add a page whose front matter does not validate');

		const result = build(repo);
		expect(result.manifestProblems).toEqual([]);
		expect(
			result.lint.envelope.findings.some((finding) => finding.rule === 'front-matter-invalid'),
		).toBe(true);

		const record = result.manifest.pages['reference/broken']?.locales.en;
		expect(record?.title).not.toBe('');
		expect(record?.description).not.toBe('');
		// The slug, which is what the address says and what the search index already chose
		// for the same reason.
		expect(record?.title).toBe('reference/broken');
		expect(record?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

		// And the payload really does validate, which is the property the manifest check is
		// standing in for on every other build.
		const payload = objectJson(result, pageKey(SOURCE_LOCALE as Locale, 'reference/broken'));
		expect(compiledPageSchema.safeParse(payload).success).toBe(true);
	});

	test('a page git has no date for is reported and still carries a timestamp', () => {
		// An uncommitted page: `dateOf` returns undefined and `sourceUpdated` used to become
		// the empty string, which `utcTimestampSchema` refuses. The commit's own date is the
		// defensible substitute, and the finding is what stops it being silent.
		const repo = corpus();
		writeFileSync(
			site(repo, 'content/en/reference/uncommitted.md'),
			'---\ntitle: Not committed yet\ndescription: Present in the tree and absent from the history.\n---\n\n## Section\n\nText.\n',
		);
		// Deliberately no commit.

		const result = build(repo);
		expect(result.manifestProblems).toEqual([]);
		const reported = result.lint.envelope.findings.filter(
			(finding) => finding.rule === 'bundle-file-undated',
		);
		expect(reported).toHaveLength(1);
		expect(reported[0]?.location.kind === 'file' ? reported[0]?.location.file : undefined).toBe(
			'content/en/reference/uncommitted.md',
		);

		const record = result.manifest.pages['reference/uncommitted']?.locales.en;
		expect(record?.updatedAt).toBe(result.manifest.commitTimestamp);
	});
});

describe('a suppression comment in a snippet', () => {
	test('reaches no published object', () => {
		// `lint.ts` states as a property that no suppression comment ever reaches a bundle,
		// and `rawMarkdown`'s own comment says the same thing about the half nobody would
		// think to look for. Both were true of a page's own body and false through an
		// include: the snippet body was spliced in verbatim, so the comment shipped in
		// `raw/<locale>/<slug>.md` and in `llms-full.txt` for every page including it. The
		// corpus's only suppression lives in a page, which is why the include path was the
		// untested half.
		const repo = corpus();
		const snippet = site(repo, 'snippets/en/safety-note.md');
		const text = readFileSync(snippet, 'utf8');
		const close = text.indexOf('---', 3);
		writeFileSync(
			snippet,
			`${text.slice(0, close + 3)}\n\n<!-- hexdocs-disable-next-line no-em-dash: quoting the packaging verbatim -->\n${text.slice(close + 3)}`,
		);
		commit(repo, 'put a suppression comment in a snippet');

		const result = build(repo);
		// Every object, not the two `safety-note` is included by: a leak in the raw markdown
		// is the case here, and asserting over the whole bundle is what makes this fail if
		// the comment finds a different way out.
		const leaked: string[] = [];
		for (const object of result.objects) {
			const bytes = object.key.endsWith('.gz') ? gunzipSync(object.bytes) : object.bytes;
			if (bytes.toString('utf8').includes('hexdocs-disable')) leaked.push(object.key);
		}
		expect(leaked).toEqual([]);

		// Still read as a suppression, so this is a strip rather than a break. The snippet
		// is parsed once on its own and the comment is recorded there before it is removed,
		// which is why it can be reported as matching nothing: that report is the proof the
		// linter saw it, and the empty list above is the proof no reader will.
		expect(
			result.lint.envelope.findings
				.filter(
					(finding) =>
						finding.location.kind === 'file' &&
						finding.location.file === 'snippets/en/safety-note.md',
				)
				.map((finding) => finding.message),
		).toEqual(['This suppression of "no-em-dash" matched nothing.']);
	});
});

describe('a suppression above a hard-wrapped paragraph', () => {
	test('covers the whole block, and does not change the published page', () => {
		// A suppression matched only the literal next line, and every corpus file is
		// hard-wrapped at about 75 columns, so a house-style finding usually lands on a
		// continuation line. A comment written where an author would write it, above the
		// paragraph, suppressed nothing and was itself reported as matching nothing. The
		// only placement that worked was inside the paragraph, and `stripComments` turns
		// that line blank, which splits the paragraph in two on the published page. For the
		// protected rules, which default to `error` and cannot be lowered, that made a
		// visible change to what the reader sees the only way past a false positive.
		const repo = corpus();
		const body = [
			'---',
			'title: Wrapped',
			'description: A paragraph wrapped the way every page in this corpus is.',
			'---',
			'',
			'## Section',
			'',
			'<!-- hexdocs-disable-next-line no-em-dash: quoting the packaging verbatim -->',
			'The label on the box reads "one tap, one tag" and the packaging',
			'spells it with an \u2014 which is what this page quotes.',
			'',
		].join('\n');
		writeFileSync(site(repo, 'content/en/reference/wrapped.md'), body);
		commit(repo, 'suppress a rule above a hard-wrapped paragraph');

		const result = build(repo);
		const onPage = result.lint.envelope.findings.filter(
			(finding) =>
				finding.location.kind === 'file' &&
				finding.location.file === 'content/en/reference/wrapped.md',
		);
		// Neither the em dash nor a "this suppression matched nothing" info. The page is
		// English-only and in no nav entry, so `translation-missing` and `orphan-page` are
		// what a page written for this test is expected to produce and are not what is under
		// test here.
		expect(
			onPage.filter((finding) => finding.rule === 'no-em-dash').map((finding) => finding.message),
		).toEqual([]);

		// And the page is still one paragraph: the comment sat outside it, so nothing was
		// blanked inside it.
		const payload = objectJson(result, pageKey(SOURCE_LOCALE as Locale, 'reference/wrapped'));
		const blocks = payload.body as { type: string }[];
		expect(blocks.map((block) => block.type)).toEqual(['heading', 'paragraph']);
	});

	test('a suppression above a different block still matches nothing', () => {
		// The widening has to stay narrow. A comment covers the block that starts on the
		// line after it and no other, or a stale suppression at the top of a page would
		// silently cover everything below it.
		const repo = corpus();
		writeFileSync(
			site(repo, 'content/en/reference/wrapped.md'),
			[
				'---',
				'title: Wrapped',
				'description: A paragraph wrapped the way every page in this corpus is.',
				'---',
				'',
				'<!-- hexdocs-disable-next-line no-em-dash: nothing on the next line -->',
				'## Section',
				'',
				'The packaging spells it with an \u2014 two blocks below the comment.',
				'',
			].join('\n'),
		);
		commit(repo, 'suppress a rule above the wrong block');

		const result = build(repo);
		const rules = result.lint.envelope.findings
			.filter(
				(finding) =>
					finding.location.kind === 'file' &&
					finding.location.file === 'content/en/reference/wrapped.md',
			)
			.map((finding) => finding.rule);
		expect(rules).toContain('no-em-dash');
	});
});
