/**
 * The theme token contract.
 *
 * Every rule in the package's stylesheet reads
 * `var(--hx-<name>, var(--<host-token>, <literal>))` **at the point of use**, and no
 * `--hx-*` is ever declared as a `var(...)` value at `:root`.
 *
 * That is not a style preference, it is how custom properties work. A custom property
 * is substituted where it is *declared*, not where it is used, so
 * `:root { --hx-accent: var(--color-accent) }` resolves against the site's base blue
 * exactly once, and an `.app-sol` override further down the tree can never take
 * effect. `hex-web`'s own `app.css` documents that bug having shipped there.
 *
 * The consequence for testing is specific: the check has to render the shell under a
 * theme class and assert the computed accent actually differs, and a test that reads the
 * stylesheet passes on the broken version. Measured since, and worth knowing before
 * trusting that check on its own: the obvious optimisation, declaring one private alias
 * per token on the docs root so the chain is written once, passes it. Substitution at the
 * docs root is correct for a theme class above the root and wrong for anything at or
 * below it, and the prescribed check only ever puts the class above. So the browser check
 * carries a case that rebinds a token on a *descendant*, which is the only placement that
 * separates the two.
 *
 * ## Why no colour token reads a host token
 *
 * The chain used to end `var(--color-accent, #0b76d9)`, so a Hex Pro site needed no
 * theming configuration at all. Measured against the second consumer, that is unsafe.
 * `kcalc-web/front` declares seven of the fifteen host names this table once used and
 * stamps `data-ground="paper"` on every page, where `--color-ink` is `#1f2c26`. A docs
 * page there would paint `--hx-ink` #1f2c26 on `--hx-ground` #0f0e0d, which measures
 * 1.33:1: invisible body text. Its accent is #255745, which on this package's ground is
 * 2.33:1 and fails the 3:1 a focus ring needs.
 *
 * A host link is only safe when the whole palette comes from one place, and CSS cannot
 * branch on whether it does. So every colour token ships a literal and the package's
 * reading surface is self-consistent wherever it is mounted. Per-instance theming is
 * unchanged in kind: a consumer sets `--hx-accent` at or above the docs root and wins,
 * because the innermost name in the chain is checked first. hex-web keeps its per-app
 * accents that way, since `root.tsx` puts `.app-<slug>` on the shell above the docs.
 *
 * The four tokens that keep a host are the three font stacks and the easing curve.
 * Neither a font stack nor a cubic-bezier can fail contrast, and inheriting the site's
 * typography is most of what makes a docs page look like part of the site.
 *
 * The table below is data so the stylesheet's token names can be generated from it.
 * Two hand-maintained lists of twenty-four names is how the CSS and the TypeScript end
 * up one token apart.
 */

export const TOKEN_PREFIX = '--hx-';

export interface ThemeToken {
	/** Without the prefix. `accent` becomes `--hx-accent`. */
	name: string;
	/**
	 * The consuming site's own token, tried before the literal.
	 *
	 * `null` for every colour token, for the measured reason in the header, and set only
	 * on the three font stacks and the easing curve. Both consumers declare all four.
	 */
	host: string | null;
	/** The last resort, for a consumer with no design system. */
	fallback: string;
	/** What it is for. Read by nobody at runtime; read by everybody editing the CSS. */
	role: string;
}

export const THEME_TOKENS: readonly ThemeToken[] = [
	{
		name: 'ground',
		host: null,
		fallback: '#0f0e0d',
		role: 'Page background.',
	},
	{
		name: 'surface',
		host: null,
		fallback: '#171512',
		role: 'Cards, callouts, the sidebar.',
	},
	{
		name: 'raised',
		host: null,
		fallback: '#1f1c18',
		role: 'Code blocks, table headers.',
	},
	{
		name: 'edge',
		host: null,
		fallback: '#2a2621',
		role: 'Decorative rules and separators.',
	},
	{
		name: 'control',
		host: null,
		// Separate from `edge` because WCAG 2.2 SC 1.4.11 asks 3:1 of a control
		// boundary, and the soft edge measures about 1.28:1. Sharing one token means
		// either invisible borders or heavy decorative rules; the codebase has already
		// learned this once. An earlier value, #4a443c, promised 3:1 in its own role
		// string and delivered two thirds of that, to precisely the consumer with no
		// design system, who gets the fallback and nothing else.
		fallback: '#78716c',
		role: 'Boundaries of things you can interact with. Held to 3:1. Measures 4.02:1 against the ground and 3.80:1 against the surface.',
	},
	{
		name: 'ink',
		host: null,
		fallback: '#f2ede6',
		role: 'Body text. Held to 4.5:1 against the ground. Measures 16.56:1 against the ground.',
	},
	{
		name: 'dim',
		host: null,
		fallback: '#a89f93',
		// Still text, so it gets the text ratio rather than the 3:1 a large or
		// non-textual element would be held to.
		role: 'Secondary text, captions, metadata. Held to 4.5:1 against the ground. Measures 7.39:1 against the ground.',
	},
	{
		name: 'faint',
		host: null,
		fallback: '#6f675d',
		// Deliberately states no floor, and is therefore the one colour token the
		// contrast sweep does not hold to a minimum. WCAG 2.2 exempts disabled controls,
		// and a placeholder that met 4.5:1 would be indistinguishable from the value it
		// stands in for. The exemption still states its measurement, so it is a number
		// somebody can argue with rather than an omission, and the sweep checks that
		// number against the value rather than trusting the prose. It went unchecked
		// once and said 3.24:1 for a colour that measures 3.47:1.
		role: 'Placeholders, disabled text. Exempt: WCAG 2.2 excludes disabled controls. Measures 3.47:1 against the ground.',
	},
	{
		name: 'accent',
		host: null,
		fallback: '#0b76d9',
		role: 'Furniture: the active nav item, focus rings, chips. Measures 4.23:1 against the ground.',
	},
	{
		name: 'accent-link',
		host: null,
		fallback: '#5ba3f5',
		// Deliberately not the same token as the furniture accent. #0b76d9 on the void
		// ground is 4.23:1, which clears the 3:1 a large control needs and misses the
		// 4.5:1 an inline link in body text needs. Sharing one token would ship failing
		// contrast on the most common interactive element on every page in seven
		// languages, and make it unfixable without a breaking change.
		role: 'Inline prose links. Held to 4.5:1 against the ground. Measures 7.35:1 against the ground.',
	},
	{
		name: 'accent-soft',
		host: null,
		fallback: '#5ba3f5',
		role: 'Hover and selection washes.',
	},
	{
		name: 'glow',
		host: null,
		fallback: 'transparent',
		role: 'The optional per-app ambient effect. Off unless a consumer sets it.',
	},
	{
		name: 'font-body',
		host: '--font-body',
		fallback: 'system-ui, sans-serif',
		role: 'Body copy.',
	},
	{
		name: 'font-display',
		host: '--font-display',
		fallback: 'system-ui, sans-serif',
		role: 'Headings.',
	},
	{
		name: 'font-mono',
		host: '--font-mono',
		fallback: 'ui-monospace, SFMono-Regular, Menlo, monospace',
		// The corpus has a box-drawing module graph and a column-aligned directory tree
		// in unlabelled fences, so this stack has to cover U+2500 and align at a fixed
		// advance width. A stack whose first entry covers the range is the only form of
		// the fix this package controls: a subsetted web font would have to be hosted on
		// each consumer's own origin, and a missing file there is the original bug plus
		// a 404.
		role: 'Code. Must cover box-drawing characters and align at one advance width.',
	},
	{
		name: 'ease',
		host: '--ease-out-quart',
		fallback: 'cubic-bezier(0.25, 1, 0.5, 1)',
		role: 'Every transition.',
	},
	{
		name: 'measure',
		host: null,
		fallback: '42rem',
		// Not the site's shell width. A documentation column wants roughly 72
		// characters whatever the surrounding layout allows.
		role: 'The reading column. Roughly 72 characters.',
	},
	{ name: 'tree-size', host: null, fallback: '16rem', role: 'Sidebar width.' },
	{ name: 'toc-size', host: null, fallback: '14rem', role: 'Table of contents width.' },
	{ name: 'gutter', host: null, fallback: '2rem', role: 'Space between the three columns.' },
	{
		name: 'sticky-offset',
		host: null,
		fallback: '5rem',
		role: 'How far a sticky element clears the site header.',
	},
	{ name: 'radius', host: null, fallback: '0.75rem', role: 'Corner radius.' },
	{ name: 'leading', host: null, fallback: '1.7', role: 'Body line height.' },
	{ name: 'font-size', host: null, fallback: '1rem', role: 'Body font size.' },
];

/** `--hx-accent`. */
export function tokenName(token: ThemeToken): string {
	return `${TOKEN_PREFIX}${token.name}`;
}

/**
 * The full `var()` chain for one token, as it must appear at every point of use.
 *
 * Generated rather than typed, so a token added to the table cannot be added to the
 * stylesheet with a different fallback chain from the one declared here.
 */
export function tokenValue(token: ThemeToken): string {
	const inner = token.host === null ? token.fallback : `var(${token.host}, ${token.fallback})`;
	return `var(${tokenName(token)}, ${inner})`;
}

/**
 * Custom events the package dispatches on its root element.
 *
 * This is how a consuming site wires its own motion and effects without the package
 * importing anything from it, which is what keeps both the zero-dependency gate and
 * the rule against depending on `@hex-pro/ui` or framer-motion true at once. Typing
 * the details makes them a contract rather than a side effect a refactor renames.
 *
 * `hexdocs:heading` is suppressed under `prefers-reduced-motion`, and the root carries
 * `data-reduced="true"` so a consumer's own effects can make the same decision without
 * asking again.
 */
export interface DocsEventMap {
	'hexdocs:navigate': { slug: string; title: string; source: 'client' | 'server' };
	'hexdocs:search-open': Record<string, never>;
	'hexdocs:search-close': { query: string; chose: string | null };
	'hexdocs:heading': { id: string; index: number; total: number };
	'hexdocs:copy': { kind: 'code' | 'markdown' };
}

export const DOCS_EVENT_NAMES = [
	'hexdocs:navigate',
	'hexdocs:search-open',
	'hexdocs:search-close',
	'hexdocs:heading',
	'hexdocs:copy',
] as const;
