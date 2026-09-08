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
 * The consequence for testing is specific: the only check that would have caught the
 * original is one that renders the shell under each `.app-<slug>` class and asserts
 * the computed accent actually differs. A test that reads the stylesheet passes on the
 * broken version.
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
	 * The consuming site's own token, tried before the literal. This second link is
	 * what makes hex-web need no theming configuration at all, and it is verified
	 * present in that repository's `app.css`.
	 */
	host: string | null;
	/** The last resort, for a consumer with no design system. */
	fallback: string;
	/** What it is for. Read by nobody at runtime; read by everybody editing the CSS. */
	role: string;
}

export const THEME_TOKENS: readonly ThemeToken[] = [
	{ name: 'ground', host: '--color-void', fallback: '#0f0e0d', role: 'Page background.' },
	{
		name: 'surface',
		host: '--color-surface',
		fallback: '#171512',
		role: 'Cards, callouts, the sidebar.',
	},
	{
		name: 'raised',
		host: '--color-raised',
		fallback: '#1f1c18',
		role: 'Code blocks, table headers.',
	},
	{
		name: 'edge',
		host: '--color-edge-soft',
		fallback: '#2a2621',
		role: 'Decorative rules and separators.',
	},
	{
		name: 'control',
		host: '--color-edge-control',
		// Measured 4.02:1 against the ground fallback and 3.80:1 against surface. The
		// previous value, #4a443c, measured 2.00:1 and 1.89:1: it promised 3:1 in its own
		// role string and delivered two thirds of that, to precisely the consumer with no
		// design system, who gets the fallback and nothing else. The `themeContrast`
		// sweep in `test/contracts/theme.test.ts` parses the ratio back out of every
		// role string and measures it, so a promise made in a role and a value that
		// misses it cannot drift apart again. A token is covered by that sweep only if
		// its role says "Held to N:1", which is why the wording below is load-bearing.
		fallback: '#78716c',
		// Separate from `edge` because WCAG 2.2 SC 1.4.11 asks 3:1 of a control
		// boundary, and the soft edge measures about 1.28:1. Sharing one token means
		// either invisible borders or heavy decorative rules; the codebase has already
		// learned this once.
		role: 'Boundaries of things you can interact with. Held to 3:1.',
	},
	{
		name: 'ink',
		host: '--color-ink',
		fallback: '#f2ede6',
		role: 'Body text. Held to 4.5:1 against the ground.',
	},
	{
		name: 'dim',
		host: '--color-dim',
		fallback: '#a89f93',
		// Still text, so it gets the text ratio rather than the 3:1 a large or
		// non-textual element would be held to. Measured 7.16:1 against the ground.
		role: 'Secondary text, captions, metadata. Held to 4.5:1 against the ground.',
	},
	{
		name: 'faint',
		host: '--color-faint',
		fallback: '#6f675d',
		// Deliberately states no ratio, and is therefore the one colour token the
		// contrast sweep skips. WCAG 2.2 exempts disabled controls, and a placeholder
		// that met 4.5:1 would be indistinguishable from the value it stands in for.
		// Measured 3.24:1 against the ground, which is stated here so the exemption is a
		// number somebody can argue with rather than an omission.
		role: 'Placeholders, disabled text. Exempt: WCAG 2.2 excludes disabled controls.',
	},
	{
		name: 'accent',
		host: '--color-accent',
		fallback: '#0b76d9',
		role: 'Furniture: the active nav item, focus rings, chips.',
	},
	{
		name: 'accent-link',
		host: '--color-accent-light',
		fallback: '#5ba3f5',
		// Deliberately not the same token as the furniture accent. Measured: #0b76d9 on
		// the void ground is 4.23:1, which clears the 3:1 a large control needs and
		// misses the 4.5:1 an inline link in body text needs. This value measures
		// 7.35:1. Sharing one token would ship failing contrast on the most common
		// interactive element on every page in seven languages, and make it unfixable
		// without a breaking change.
		role: 'Inline prose links. Held to 4.5:1 against the ground.',
	},
	{
		name: 'accent-soft',
		host: '--color-accent-light',
		fallback: '#5ba3f5',
		role: 'Hover and selection washes.',
	},
	{
		name: 'glow',
		host: '--app-glow',
		fallback: 'transparent',
		role: 'The optional per-app ambient effect.',
	},
	{ name: 'font-body', host: '--font-body', fallback: 'system-ui, sans-serif', role: 'Body copy.' },
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
		// advance width.
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
