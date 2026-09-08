/**
 * What every bundle key is served as, decided by a table rather than by a guess.
 *
 * This exists because the AWS CLI's own answer is wrong for two thirds of a bundle, and
 * it is wrong silently. `awscli/customizations/s3/utils.py` is
 * `return mimetypes.guess_type(filename)[0]`: it takes index zero of a two element
 * tuple and discards the encoding half, so `pages/en/index.json.gz` uploads as
 * `application/json` with **no `Content-Encoding`** and `raw/en/index.md.gz` gets no
 * `Content-Type` at all and lands as `binary/octet-stream`. `--content-encoding` is a
 * per invocation flag, so one `s3 cp --recursive` or `s3 sync` cannot set it for the
 * `.gz` keys and omit it for `llms/*.txt` and `assets/*` in the same run. That is why
 * `publish` puts one object at a time, and why the type it puts each one with comes
 * from here.
 *
 * The failure this prevents is not an error anybody sees. A gzip member served with no
 * `Content-Encoding` reaches the browser as bytes it cannot decode, and what the reader
 * gets is a page of mojibake or a `JSON.parse` failure in a component, on a route
 * nobody tested against the bucket.
 *
 * **This table's `gzipped` and `isGzipped()` in `src/contracts/manifest.ts` must
 * agree, in both directions, for every key.** `isGzipped` is what the bundle writer
 * uses to decide whether to compress the bytes, and this table is what the publisher
 * uses to decide whether to label them. If the two ever disagree, the object is either
 * compressed and unlabelled (undecodable) or uncompressed and labelled as gzip (the
 * browser refuses it). `mediaFor` compares them on every key it answers for, and
 * `keyRuleProblems` compares them once per rule with no bundle in hand, so a rule added
 * with the wrong flag fails without waiting for a publish to reach it.
 */

import {
	ASSET_EXTENSIONS,
	MANIFEST_KEY,
	isGzipped,
	type AssetExtension,
} from '../../../src/contracts/manifest.js';

export interface ObjectMedia {
	/** The `--content-type` value, verbatim. */
	readonly contentType: string;
	/** True when the object must also carry `Content-Encoding: gzip`. */
	readonly gzipped: boolean;
}

/**
 * The image types, keyed by the extension the manifest already records.
 *
 * A `Record<AssetExtension, string>` rather than a lookup with a fallback, so adding a
 * format to `ASSET_EXTENSIONS` is a typecheck failure here rather than an asset served
 * as `binary/octet-stream`. The extension is sniffed from the bytes at compile time and
 * is also the filename, so nothing here has to defend against a `.png` that is really a
 * JPEG.
 */
export const ASSET_CONTENT_TYPES: Readonly<Record<AssetExtension, string>> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	webp: 'image/webp',
	avif: 'image/avif',
	svg: 'image/svg+xml',
};

export interface KeyRule {
	/** Names the rule in a message and in a test. Not part of any key. */
	readonly id: string;
	/** The whole key, for the one object that has a fixed name. `null` otherwise. */
	readonly key: string | null;
	readonly prefix: string;
	readonly suffix: string;
	readonly contentType: string;
	readonly gzipped: boolean;
	/** One sentence: who fetches this, and what a wrong header does to them. */
	readonly why: string;
}

/**
 * Every shape a bundle key can take, in the order they are matched.
 *
 * Closed, and that is the point: a key matching nothing is refused rather than uploaded
 * with a guessed type. The five key helpers in `manifest.ts` (`pageKey`, `rawKey`,
 * `searchKey`, `llmsKey`, `assetKey`) plus `MANIFEST_KEY` are the only writers of these
 * strings, so a key this table does not recognise means the bundle carries an object no
 * helper produced, which is a compiler bug rather than an upload decision.
 */
export const KEY_RULES: readonly KeyRule[] = [
	{
		id: 'manifest',
		key: MANIFEST_KEY,
		prefix: '',
		suffix: '',
		contentType: 'application/json',
		gzipped: false,
		why: 'Read by every other operation before anything else, and small enough that compressing it would buy nothing and cost a decode.',
	},
	{
		id: 'pages',
		key: null,
		prefix: 'pages/',
		suffix: '.json.gz',
		contentType: 'application/json',
		gzipped: true,
		why: 'The page payload. Fetched by the consuming build rather than by a browser, but an unlabelled member is undecodable to both.',
	},
	{
		id: 'search',
		key: null,
		prefix: 'search/',
		suffix: '.idx.json.gz',
		contentType: 'application/json',
		gzipped: true,
		why: 'The one object a browser fetches at runtime, through `fetch` in the search dialog, so an unlabelled member is a search that silently never opens.',
	},
	{
		id: 'raw',
		key: null,
		prefix: 'raw/',
		suffix: '.md.gz',
		contentType: 'text/markdown; charset=utf-8',
		gzipped: true,
		why: 'Served at `<slug>.md` by a resource route. Without an explicit type this is the key the AWS CLI would have shipped as binary/octet-stream, which a browser downloads instead of showing.',
	},
	{
		id: 'llms',
		key: null,
		prefix: 'llms/',
		suffix: '.txt',
		contentType: 'text/plain; charset=utf-8',
		gzipped: false,
		why: 'Fetched by tools that may not negotiate an encoding, which is exactly why the bundle writer leaves it uncompressed.',
	},
	// Derived rather than listed, so a sixth image format is one edit in
	// `ASSET_EXTENSIONS` and `ASSET_CONTENT_TYPES` and not a third place to forget.
	...ASSET_EXTENSIONS.map((ext) => ({
		id: `assets.${ext}`,
		key: null,
		prefix: 'assets/',
		suffix: `.${ext}`,
		contentType: ASSET_CONTENT_TYPES[ext],
		gzipped: false,
		why: "Copied into the consuming site's public directory and served from its own origin, so the stored type is what an `<img>` and a direct navigation both get.",
	})),
];

function matches(rule: KeyRule, key: string): boolean {
	if (rule.key !== null) return key === rule.key;
	// Strictly greater, not equal: `pages/.json.gz` has no locale and no slug in it, and
	// a rule that accepted it would give a malformed key a content type and let it
	// through to a put.
	return (
		key.startsWith(rule.prefix) &&
		key.endsWith(rule.suffix) &&
		key.length > rule.prefix.length + rule.suffix.length
	);
}

/**
 * How one key is stored and served, or `null` when nothing recognises it.
 *
 * `null` rather than a default, because the default is the defect this module exists to
 * close. A publisher that met an unknown key and shipped it as `application/octet-stream`
 * would be doing what `s3 cp` does, one layer up.
 */
export function mediaFor(key: string): ObjectMedia | null {
	const rule = KEY_RULES.find((candidate) => matches(candidate, key));
	if (rule === undefined) return null;

	// The cross-check, on the key in hand. It cannot fire while `KEY_RULES` and
	// `isGzipped` agree, which `keyRuleProblems` asserts for the table as a whole, and
	// it is here anyway because the two are separate decisions in separate files and
	// this is the moment before the bytes go to a commit addressed key that write-once
	// will never let anybody overwrite. A throw is the honest response: it can only mean
	// the tables disagree, which is a defect in this repository and not in a bundle.
	if (rule.gzipped !== isGzipped(key)) {
		throw new Error(
			`Key "${key}" matches rule "${rule.id}", which says gzipped=${String(rule.gzipped)}, ` +
				`while isGzipped() says ${String(isGzipped(key))}. One of them would label the member ` +
				`wrongly, and a gzip member served without Content-Encoding reaches the browser as ` +
				`bytes it cannot decode.`,
		);
	}

	return { contentType: rule.contentType, gzipped: rule.gzipped };
}

/**
 * The same agreement, checked over the table itself rather than over a bundle.
 *
 * `mediaFor` can only compare the keys a publish happens to meet, so a rule for a key
 * shape no fixture carries would never be examined. This builds the shortest key each
 * rule accepts and asks `isGzipped` about it, which means every rule is covered whether
 * or not a bundle contains one. Returns a problem per rule rather than throwing on the
 * first, so a table wrong in two places says so once.
 */
export function keyRuleProblems(): string[] {
	const problems: string[] = [];
	for (const rule of KEY_RULES) {
		const sample = rule.key ?? `${rule.prefix}x${rule.suffix}`;
		if (!matches(rule, sample)) {
			problems.push(
				`Rule "${rule.id}" does not match the shortest key it describes ("${sample}"), ` +
					`so nothing would ever reach it.`,
			);
			continue;
		}
		if (rule.gzipped !== isGzipped(sample)) {
			problems.push(
				`Rule "${rule.id}" says gzipped=${String(rule.gzipped)} and isGzipped("${sample}") ` +
					`says ${String(isGzipped(sample))}. The bundle writer compresses on one of these ` +
					`and the publisher labels on the other.`,
			);
		}
	}
	return problems;
}
