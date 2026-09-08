/**
 * Slugs: what a page is called, and therefore where it lives.
 *
 * A slug is the file's path under `content/<locale>/`, minus the `.md`. It is never
 * a front matter field. A page whose front matter disagreed with its filename would
 * be reachable at one address and linked at another, and the linter could only ever
 * report which of the two the author meant by guessing.
 *
 * The wire form is a string, because that is what `nav.json`, the manifest and the
 * consumer config all carry. The parsed form is a union with an explicit case for a
 * section root, because representing "the index of this section" as an empty string
 * produces a value that fails its own validity regex and has to be special-cased at
 * every call site instead of once here.
 */

/**
 * One path segment. Lower case, ASCII, hyphen-separated, no leading or trailing
 * hyphen, no dots.
 *
 * Dots are excluded rather than merely discouraged. Every page is published at
 * `<slug>.md` and `<slug>.json` as well as at its HTML address, so a slug containing
 * a dot would produce two routes that differ only in where the extension starts.
 */
export const SLUG_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest a slug may be. Beyond this a manual is a filing cabinet, not a document. */
export const MAX_SLUG_DEPTH = 4;

/** Longest a single segment may be, so an address stays quotable in a support reply. */
export const MAX_SEGMENT_LENGTH = 64;

/** The filename that makes a directory addressable. `guide/index.md` serves `guide/`. */
export const INDEX_SEGMENT = 'index';

/**
 * First segments a page may not claim.
 *
 * Each of these is already a route under a project's docs mount. React Router breaks
 * a ranking tie on declaration order, so a page named `search` would resolve to
 * whichever of the two was declared first, deterministically and invisibly. Refusing
 * the name at compile time is the only version of this check that fails somewhere a
 * person is looking.
 */
export const RESERVED_SLUG_ROOTS = [
	'search',
	'llms',
	'llms-full',
	'assets',
	'raw',
	'sitemap',
	'robots',
	// The version-pin segment: /hex-nfc/docs/v/1.0.0/guide/first-tag. A page slugged
	// `v` would make every pinned address ambiguous with a real page.
	'v',
] as const;

/*
 * `_bundles` is deliberately not in that list. It is the prefetch directory name, so it
 * looks like it belongs, but the segment grammar above already refuses a leading
 * underscore and the reserved check is never reached for it. Listing it would attach a
 * reason ("this ties with a built-in route") to an entry that is refused for an
 * entirely different one, which is the kind of comment that gets trusted and then
 * copied.
 */

export type ParsedSlug =
	| {
			readonly kind: 'index';
			/** Empty for the docs home; `['guide']` for `guide/index`. */
			readonly section: readonly string[];
	  }
	| {
			readonly kind: 'page';
			readonly section: readonly string[];
			readonly name: string;
	  };

export type SlugProblem =
	| 'empty'
	| 'leading-or-trailing-slash'
	| 'empty-segment'
	| 'bad-segment'
	| 'segment-too-long'
	| 'too-deep'
	| 'reserved-root'
	| 'nested-index';

export type SlugParse =
	| { readonly ok: true; readonly slug: ParsedSlug }
	| {
			readonly ok: false;
			readonly input: string;
			readonly problem: SlugProblem;
			readonly message: string;
	  };

function fail(input: string, problem: SlugProblem, message: string): SlugParse {
	return { ok: false, input, problem, message };
}

/**
 * The one place a slug string becomes structure. Total: every rejection names the
 * segment that caused it, because an agent that renamed forty pages needs to know
 * which one it got wrong.
 */
export function parseSlug(input: string): SlugParse {
	if (input.length === 0) {
		return fail(input, 'empty', 'A slug cannot be empty. The docs home is spelled "index".');
	}
	if (input.startsWith('/') || input.endsWith('/')) {
		return fail(
			input,
			'leading-or-trailing-slash',
			`"${input}" has a leading or trailing slash. Slugs are relative and unterminated: "guide/first-tag", not "/guide/first-tag/".`,
		);
	}

	const segments = input.split('/');
	if (segments.length > MAX_SLUG_DEPTH) {
		return fail(
			input,
			'too-deep',
			`"${input}" is ${segments.length} levels deep; the limit is ${MAX_SLUG_DEPTH}.`,
		);
	}

	for (const [index, segment] of segments.entries()) {
		if (segment.length === 0) {
			return fail(
				input,
				'empty-segment',
				`"${input}" has an empty path segment at position ${index + 1}.`,
			);
		}
		if (segment.length > MAX_SEGMENT_LENGTH) {
			return fail(
				input,
				'segment-too-long',
				`"${segment}" is ${segment.length} characters; the limit is ${MAX_SEGMENT_LENGTH}.`,
			);
		}
		if (!SLUG_SEGMENT_PATTERN.test(segment)) {
			return fail(
				input,
				'bad-segment',
				`"${segment}" is not a valid slug segment. Use lower case ASCII letters, digits and single hyphens: "first-tag".`,
			);
		}
		if (segment === INDEX_SEGMENT && index !== segments.length - 1) {
			return fail(
				input,
				'nested-index',
				`"${input}" uses "index" as a directory. "index" only means anything as the last segment.`,
			);
		}
	}

	const first = segments[0];
	if (first !== undefined && (RESERVED_SLUG_ROOTS as readonly string[]).includes(first)) {
		return fail(
			input,
			'reserved-root',
			`"${first}" is a reserved route under a docs mount. Rename the page: a slug that ties with a built-in route resolves to whichever was declared first.`,
		);
	}

	const last = segments[segments.length - 1];
	if (last === INDEX_SEGMENT) {
		return { ok: true, slug: { kind: 'index', section: segments.slice(0, -1) } };
	}
	return { ok: true, slug: { kind: 'page', section: segments.slice(0, -1), name: last as string } };
}

/** `parseSlug` for callers where an invalid slug is a bug rather than input. */
export function requireSlug(input: string, context: string): ParsedSlug {
	const parsed = parseSlug(input);
	if (parsed.ok) return parsed.slug;
	throw new Error(`${context}: ${parsed.message}`);
}

export function isValidSlug(input: string): boolean {
	return parseSlug(input).ok;
}

/** Back to the wire form. `formatSlug(parseSlug(s))` is `s` for every valid `s`. */
export function formatSlug(slug: ParsedSlug): string {
	return slug.kind === 'index'
		? [...slug.section, INDEX_SEGMENT].join('/')
		: [...slug.section, slug.name].join('/');
}

/**
 * The address path, relative to the docs mount and without a trailing slash: `''`
 * for the home, `'guide'` for a section root, `'guide/first-tag'` for a page.
 *
 * Section roots are served at a trailing-slash address. That slash is added by the
 * address builder, not here, so that this function's output can be joined, compared
 * and sorted without a special case at every use.
 */
export function slugToPath(slug: ParsedSlug): string {
	return slug.kind === 'index' ? slug.section.join('/') : [...slug.section, slug.name].join('/');
}

/** True when the slug addresses a directory, and therefore wants a trailing slash. */
export function isSectionRoot(slug: ParsedSlug): boolean {
	return slug.kind === 'index';
}

/**
 * The section root that contains this slug, or `undefined` for the docs home.
 * Breadcrumbs walk this; so does the orphan check.
 */
export function slugParent(slug: ParsedSlug): ParsedSlug | undefined {
	if (slug.kind === 'page') return { kind: 'index', section: slug.section };
	if (slug.section.length === 0) return undefined;
	return { kind: 'index', section: slug.section.slice(0, -1) };
}

/**
 * Total order over parsed slugs: lexicographic by path segment, and where one path is
 * a prefix of another, the shorter first. That second clause is what puts a section
 * root before its children; it does **not** put every shallow slug before every deep
 * one, so `reference/chip` still sorts before `zzz`.
 *
 * Stated precisely because the point of this function is that two independent
 * implementations of the sort agree. Somebody writing the same order in another
 * language, or a consumer-side check, works from this sentence.
 *
 * This is *reading* order, which is what the nav and `llmsOrder` want. It is not the
 * order the manifest's `pages` keys are stored in: those are sorted by code point,
 * because a key sort must not need a parser and must be reproducible without one.
 */
export function compareSlugs(a: ParsedSlug, b: ParsedSlug): number {
	const aParts = a.kind === 'index' ? a.section : [...a.section, a.name];
	const bParts = b.kind === 'index' ? b.section : [...b.section, b.name];

	const shared = Math.min(aParts.length, bParts.length);
	for (let i = 0; i < shared; i += 1) {
		const left = aParts[i] as string;
		const right = bParts[i] as string;
		if (left !== right) return left < right ? -1 : 1;
	}
	if (aParts.length !== bParts.length) return aParts.length - bParts.length;

	// Same path: one is `guide` (the section root) and the other `guide` as a page
	// name, which parseSlug cannot produce for the same input. Ordered anyway so the
	// comparator is total.
	if (a.kind === b.kind) return 0;
	return a.kind === 'index' ? -1 : 1;
}

/**
 * `compareSlugs` over the wire form: reading order for the nav and for `llmsOrder`.
 *
 * Input the parser rejects sorts into a single bucket after every valid slug, ordered
 * among itself by code point. That is not tidiness. The previous fallback compared
 * unparseable input by raw string against *parsed* input by structure, which mixes two
 * orders and is intransitive: `index < guide`, `guide < hello!`, `hello! < index` all
 * held at once, so `Array.prototype.sort` returned a different answer for each input
 * permutation of the same three strings. A comparator like that makes a "deterministic"
 * manifest depend on `readdir` order after all.
 */
export function compareSlugStrings(a: string, b: string): number {
	const left = parseSlug(a);
	const right = parseSlug(b);
	if (left.ok && right.ok) return compareSlugs(left.slug, right.slug);
	if (left.ok) return -1;
	if (right.ok) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}
