/**
 * What a consuming site tells the docs server about itself and the apps it sells.
 *
 * Everything here is optional to a consumer, and that is the contract rather than a
 * convenience. kcalc passes none of it and has to keep serving exactly what it serves today;
 * hex-web passes all of it. The server never guesses a value it was not given: an origin it
 * worked out from `request.url` says `http://` behind the deploy's tunnel, and an app's price
 * or platform written into this package would be a second copy of a registry the site already
 * keeps, which is the drift every guard in this repository exists to refuse.
 *
 * ## Three kinds of fact, three ways in
 *
 * - **The site's own address and the licence** are build-time constants, so they are options
 *   to `docsServer()`, written as literals in the consumer's `docs.server.ts`. That module may
 *   import only by relative path, because React Router loads `routes.ts` with no Vite plugins,
 *   so it cannot import the site's registries and does not need to.
 * - **Facts about the apps** come from the site's registries, which import the site's own
 *   formatting code. They are passed per request, as functions, from a route module, which
 *   can import anything: `DOCS.resource(request, { describe })`.
 * - **The agent interface's identity** is also a constant, and is an option for the same reason
 *   as the origin.
 *
 * Every string the host passes is already display text in English. The machine surface this
 * feeds is English by decision, and a price formatted here would be a price formatted twice.
 */

/** Where an app is in its life. The three a site's registry already distinguishes. */
export const APP_STATUSES = ['released', 'near-release', 'in-development'] as const;

export type DocsAppStatus = (typeof APP_STATUSES)[number];

/** The licence the documentation is published under, for example CC BY 4.0. */
export interface DocsLicence {
	/** `CC BY 4.0`. */
	name: string;
	/** `https://creativecommons.org/licenses/by/4.0/`. */
	url: string;
}

export interface DocsPublisher {
	/** The trading name a reader knows: `Hex Pro`. */
	name: string;
	/** The publisher's own site. */
	url: string;
	/** The company behind the name, when it differs: `Ars Vitae Pty Ltd`. */
	legalName?: string;
}

export interface DocsPlatform {
	/** The device or system, as a reader would say it: `iPhone`. */
	name: string;
	/** The oldest system it runs on, as display text: `iOS 17`. Read as "or later". */
	minimumOs?: string;
}

export interface DocsPricing {
	/** The model in a few words: `Free`, `Free with optional subscription`. */
	model: string;
	/** Each price as the site already formats it, with its period: `A$4.99 a month`. */
	prices?: readonly string[];
}

/**
 * One app's facts, as an agent needs them to say what the app is and where to get it.
 *
 * Absolute URLs throughout. These are read by tools that fetch a string as written.
 */
export interface DocsAppFacts {
	name: string;
	/** One sentence saying what the app does. Not the docs home's description. */
	description: string;
	publisher: DocsPublisher;
	platforms: readonly DocsPlatform[];
	pricing: DocsPricing;
	status: DocsAppStatus;
	productUrl: string;
	privacyUrl?: string;
	/** Only once a real store listing exists. */
	appStoreUrl?: string;
	/**
	 * The app's documentation `llms.txt`, for an app whose documentation lives somewhere other
	 * than this site. For a project this site mounts, the server writes its own address here
	 * and ignores this one, because the server knows its own address and the host's could drift.
	 */
	llmsUrl?: string;
}

/** One app in the host's catalogue, documented here or not. */
export interface DocsCatalogueApp extends DocsAppFacts {
	/** What an agent names the app by: the site's own slug, `hex-nfc`. */
	id: string;
	/** The docs project, when this site mounts documentation for the app. */
	project?: string;
}

/**
 * The per-request facts, passed from a route module.
 *
 * Functions rather than values, so a request that needs neither, which is most of them,
 * calls neither. `describe` answers for one docs project and `apps` lists everything the site
 * sells. Either may be given alone: without `describe`, a project is described by its entry in
 * `apps`, and without `apps`, the catalogue is the documented projects.
 */
export interface DocsHostFacts {
	describe?: (project: string) => DocsAppFacts | undefined;
	apps?: () => readonly DocsCatalogueApp[];
}

/**
 * The agent interface's identity and addresses, as the host mounts it.
 *
 * Paths are the host's to choose, so they are named here rather than assumed, and every
 * machine file that links to them reads them from here.
 */
export interface DocsAgentConfig {
	/**
	 * Reverse-DNS, with exactly one slash: `pro.hex.apps/docs`. It is the Server Card's `name`
	 * and the name a registry lists the server under.
	 */
	name: string;
	/** A display name: `Hex Pro app documentation`. */
	title: string;
	/** One sentence, at most 100 characters, which is the Server Card's limit. */
	description: string;
	/** The site the server belongs to: `https://apps.hex.pro`. */
	website: string;
	/** The interface's version. Defaults to `DOCS_AGENT_VERSION`. */
	version?: string;
	/** Where the MCP endpoint is mounted: `/mcp`. */
	mcp: string;
	/** Where the JSON search is mounted: `/docs/search.json`. */
	search?: string;
	/** Where the Server Card is mounted: `/mcp/server-card`. */
	serverCard?: string;
}

/**
 * Why a value cannot be the site's origin, or nothing when it can.
 *
 * Scheme and host, an optional port, and nothing else: no path, no trailing slash, no query.
 * Every absolute URL the server writes is this string followed by a path, so a trailing slash
 * here doubles one in every link, and a path silently moves every link under it.
 */
export function originProblem(origin: string): string | undefined {
	if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(origin)) {
		return `"${origin}" is not an origin. Pass the scheme and host alone, such as "https://apps.example.com", with no path and no trailing slash.`;
	}
	return undefined;
}
