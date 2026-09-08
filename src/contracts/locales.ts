/**
 * The language contract.
 *
 * Everything else in this package takes a `Locale`, never a `string`. Locale codes
 * arrive from four places that spell them differently: URLs, front matter, Xcode
 * string catalogues (`zh-Hans`, `pt_BR`) and Android resource folders. They are
 * normalised exactly once, here, at whatever boundary they enter through.
 */

/**
 * The seven languages the estate ships, in the order `@hex-pro/i18n` declares them.
 *
 * This list is duplicated in every consuming website's own i18n config, and
 * `check-locales.mjs` there compares all seven locale files key for key in both
 * directions. Adding an eighth language here without adding it there produces a
 * bundle the site cannot mount. The consumer sweep asserts the two lists match.
 */
export const LOCALES = ['en', 'zh', 'ar', 'es', 'ja', 'fr', 'pt-BR'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * Documentation is authored in English and translated outward. Translation
 * staleness is defined against this locale and nothing else.
 */
export const SOURCE_LOCALE: Locale = 'en';

/** Right-to-left languages. Arabic is the only one in the set. */
export const RTL_LOCALES = ['ar'] as const satisfies readonly Locale[];

export type Direction = 'ltr' | 'rtl';

const RTL_SET: ReadonlySet<string> = new Set<string>(RTL_LOCALES);
const LOCALE_SET: ReadonlySet<string> = new Set<string>(LOCALES);

/**
 * Lower-cased spellings that mean one of our seven. Keys are the result of
 * `canonicalise()`, so they are already lower case with hyphens.
 *
 * Deliberately narrow: only codes that genuinely appear in the estate. `zh-Hans` is
 * how `app/HexNFC/Localizable.xcstrings` spells Chinese, `pt_BR` is how Xcode and
 * Android resource paths spell Portuguese, and `pt-br` is what a lower-cased URL
 * carries.
 *
 * Regional variants we do not publish are not aliased. `pt-PT` folding to `pt-BR`
 * would be the same silent substitution as `zh-Hant` folding to `zh`: plausible,
 * undetectable downstream, and wrong for the reader. A route that wants to offer
 * the nearest published language can do that itself, where the decision is visible.
 */
const ALIASES: Readonly<Record<string, Locale>> = {
	'zh-hans': 'zh',
	'pt-br': 'pt-BR',
};

export type LocaleRejection =
	/** A real language tag for a language this estate does not publish. */
	| 'unsupported-language'
	/** A real tag for a supported language in a script we do not publish. */
	| 'wrong-script'
	/** Not a language tag at all. */
	| 'not-a-language-tag';

export type LocaleMatch =
	| { readonly ok: true; readonly locale: Locale; readonly canonical: boolean }
	| {
			readonly ok: false;
			readonly input: string;
			readonly reason: LocaleRejection;
			readonly message: string;
	  };

/**
 * Codes we refuse by name, with the reason, rather than letting them fall through
 * to a generic "unknown locale".
 *
 * `hi` is the one that matters. Hex NFC has a Hindi App Store listing with no app
 * strings behind it, so a Hindi docs directory is a plausible mistake, and silently
 * dropping it would publish a bundle that is quietly missing a language somebody
 * believed they had shipped.
 *
 * `zh-Hant` is the other. Mapping Traditional Chinese onto `zh` would serve
 * Simplified text to Traditional readers and nothing downstream would notice: the
 * page would render, the locale would validate, and only a reader would know.
 */
const REFUSED: Readonly<Record<string, { reason: LocaleRejection; message: string }>> = {
	hi: {
		reason: 'unsupported-language',
		message:
			'Hindi is not a published web language. The Hindi App Store listing has no app strings behind it. Remove the directory or add "hi" to the estate i18n config first.',
	},
	'zh-hant': {
		reason: 'wrong-script',
		message:
			'Traditional Chinese is not published. Do not fold it into "zh": that would serve Simplified text to Traditional readers with nothing to flag it.',
	},
	'zh-hant-tw': {
		reason: 'wrong-script',
		message:
			'Traditional Chinese is not published. Do not fold it into "zh": that would serve Simplified text to Traditional readers with nothing to flag it.',
	},
	'zh-tw': {
		reason: 'wrong-script',
		message:
			'Traditional Chinese is not published. Do not fold it into "zh": that would serve Simplified text to Traditional readers with nothing to flag it.',
	},
};

/** A BCP 47 subtag sequence, loosely: the shape a tag has, not whether it exists. */
const TAG_SHAPE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/;

/**
 * Case-folds and normalises separators without deciding anything. Xcode writes
 * `pt_BR`, URLs arrive lower cased, front matter arrives however it was typed.
 */
function canonicalise(input: string): string {
	return input.trim().replaceAll('_', '-').toLowerCase();
}

/** Narrowing guard for values that are already claimed to be locales. */
export function isLocale(value: unknown): value is Locale {
	return typeof value === 'string' && LOCALE_SET.has(value);
}

/**
 * The one place a locale string becomes a `Locale`.
 *
 * `canonical` is true when the input was already spelled the way we spell it, which
 * is what lets a URL route answer "this needs a 301" without a second comparison.
 */
export function matchLocale(input: string): LocaleMatch {
	if (isLocale(input)) return { ok: true, locale: input, canonical: true };

	const folded = canonicalise(input);

	const refused = REFUSED[folded];
	if (refused) {
		return { ok: false, input, reason: refused.reason, message: refused.message };
	}

	const aliased = ALIASES[folded];
	if (aliased) return { ok: true, locale: aliased, canonical: false };

	for (const locale of LOCALES) {
		if (locale.toLowerCase() === folded) return { ok: true, locale, canonical: false };
	}

	if (!TAG_SHAPE.test(folded)) {
		return {
			ok: false,
			input,
			reason: 'not-a-language-tag',
			message: `"${input}" is not a language tag. Expected one of: ${LOCALES.join(', ')}.`,
		};
	}

	return {
		ok: false,
		input,
		reason: 'unsupported-language',
		message: `"${input}" is not a published language. Expected one of: ${LOCALES.join(', ')}.`,
	};
}

/** `matchLocale` for callers that only care whether it resolved. */
export function normaliseLocale(input: string): Locale | undefined {
	const match = matchLocale(input);
	return match.ok ? match.locale : undefined;
}

/**
 * `matchLocale` for callers on a path where an unknown locale is a bug rather than
 * user input. `context` becomes the first half of the message, so the thrower says
 * where the bad code came from and the matcher says what was wrong with it.
 */
export function requireLocale(input: string, context: string): Locale {
	const match = matchLocale(input);
	if (match.ok) return match.locale;
	throw new Error(`${context}: ${match.message}`);
}

export function directionOf(locale: Locale): Direction {
	return RTL_SET.has(locale) ? 'rtl' : 'ltr';
}

/**
 * Sorts locales into the canonical order regardless of how a caller collected them,
 * so a manifest built from a `readdir` and one built from a config produce byte
 * identical JSON. Re-running a publish on the same commit has to write the same
 * bytes, and directory order is not stable across filesystems.
 */
export function sortLocales(input: Iterable<Locale>): Locale[] {
	const present = new Set(input);
	return LOCALES.filter((locale) => present.has(locale));
}
