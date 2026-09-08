/**
 * The rule registry: every configurable rule, what it is for and what it costs to
 * ignore.
 *
 * One entry per member of `LINT_RULE_IDS`, pinned with `satisfies Record<LintRuleId,
 * RuleDefinition>` so a rule added to the contract without an entry here fails the
 * typecheck by name rather than producing findings with no title and no consequence.
 *
 * `consequence` is copied onto every finding the rule produces, which is why it is
 * written as what breaks rather than as a restatement of the title. `diagnostics.ts`
 * puts the reasoning the other way round: an agent that has to ask why will instead
 * guess, and a guess about a house rule is how the rule gets disabled.
 *
 * **Severities are chosen against what a false positive costs.** `error` blocks a
 * publish, so it belongs to the rules that report a definite defect: a broken link,
 * front matter that does not validate, a construct this AST major cannot carry, an SVG
 * that would be a same-origin document on the consuming site. Every heuristic rule, the
 * ones that read rhythm and word choice, defaults to `warning` or `info`, because the
 * alternative is a project whose build is blocked by a sentence a human would have let
 * through. The floor is a floor and not a ceiling: a project that has finished
 * translating, or that wants its own prose held tighter, raises what it likes.
 */

import type { Severity } from '../../../../src/contracts/diagnostics.js';
import type { Locale } from '../../../../src/contracts/locales.js';
import type { LintConfig } from '../../../../src/contracts/project.js';
import {
	type LintRuleId,
	type RuleDefinition,
	isProtectedRule,
} from '../../../../src/contracts/lint.js';

/**
 * The banned characters used in the examples, written as escapes.
 *
 * The same trick `BANNED_CHARACTERS` uses in `lint.ts`, for the same reason: this
 * repository lints its own source for these characters, and a literal here would flag
 * the file that describes the rule against them. An exemption for "the file that
 * declares the rule" is the hole that later swallows a real hit.
 */
const EM_DASH = '\u2014';
const EN_DASH = '\u2013';
const RIGHTWARDS_ARROW = '\u2192';

export const RULE_DEFINITIONS = {
	// -------------------------------------------------------------------------
	// structure
	// -------------------------------------------------------------------------

	'no-h1-in-body': {
		id: 'no-h1-in-body',
		category: 'structure',
		defaultSeverity: 'error',
		title: 'Start the body at heading level two.',
		consequence:
			'The page title is already rendered as the only h1. A second one gives the page two document outlines, which is what a screen reader and a search crawler each read to decide what the page is about.',
		examples: [
			{ bad: '# Scan your first tag', good: '## Scan your first tag' },
			{ bad: '# Errors', good: '## Errors' },
		],
	},
	'heading-depth': {
		id: 'heading-depth',
		category: 'structure',
		defaultSeverity: 'warning',
		title: 'Keep headings within the depth the table of contents can show.',
		consequence:
			'A heading below the configured depth is invisible in the table of contents and in the search index heading list, so the section exists on the page and nowhere a reader can find it.',
		examples: [
			{ bad: '###### Lock bytes', good: '### Lock bytes' },
			{ bad: '##### Antenna position', good: '#### Antenna position' },
		],
	},
	'heading-order': {
		id: 'heading-order',
		category: 'structure',
		defaultSeverity: 'warning',
		title: 'Do not skip a heading level.',
		consequence:
			'A jump from level two to level four leaves a hole in the outline, and the table of contents renders the deeper heading as a sibling of the shallower one, which reads as a flat list of unrelated sections.',
		examples: [
			{ bad: '## Errors\n\n#### Retry behaviour', good: '## Errors\n\n### Retry behaviour' },
		],
	},
	'no-raw-html': {
		id: 'no-raw-html',
		category: 'structure',
		defaultSeverity: 'error',
		title: 'Write markdown, not HTML.',
		consequence:
			'There is no html node in the AST and no dangerouslySetInnerHTML in the renderer, so the tag is dropped rather than rendered. The words inside it survive and the markup silently does not, which is a published page missing the thing the author was trying to say.',
		examples: [
			{
				bad: 'Wrap the value in <span class="chip"> before printing it.',
				good: 'Wrap the value in a chip before printing it.',
			},
		],
	},
	'code-fence-language': {
		id: 'code-fence-language',
		category: 'structure',
		defaultSeverity: 'error',
		title: 'Label every code fence with a language from the project allowlist.',
		consequence:
			'An unlabelled fence renders unhighlighted and nothing on the page says whether that was intended, so a typo in the language name looks exactly like a deliberate plain block. Fences that really are not code take the plain language, which is the member that exists for them.',
		examples: [
			{
				bad: '```\nlet session = TagSession()\n```',
				good: '```swift\nlet session = TagSession()\n```',
			},
			{ bad: '```swfit\nlet x = 1\n```', good: '```swift\nlet x = 1\n```' },
		],
	},
	'table-header-required': {
		id: 'table-header-required',
		category: 'structure',
		defaultSeverity: 'error',
		title: 'Name every column in a table header.',
		consequence:
			'A blank header cell is a column a screen reader announces as nothing and a search result cannot label, and the support matrix is exactly the page where that matters. GFM makes the header row itself mandatory, so an unnamed column is the failure that is actually reachable.',
		examples: [
			{
				bad: '| Chip |  |\n| --- | --- |\n| NTAG213 | 144 |',
				good: '| Chip | User memory |\n| --- | --- |\n| NTAG213 | 144 |',
			},
		],
	},
	'page-size': {
		id: 'page-size',
		category: 'structure',
		defaultSeverity: 'error',
		title: 'Keep a compiled page under the project byte budget.',
		consequence:
			'The bundle is read at build time by the consuming site, so an unbounded page does not make a slow page. It makes a build that times out on a self-hosted box at deploy time, and the deploy reports a failure with no obvious cause.',
		examples: [
			{
				bad: 'One page carrying every chip datasheet inline.',
				good: 'A page per chip family, linked from the matrix.',
			},
		],
	},
	'unsupported-syntax': {
		id: 'unsupported-syntax',
		category: 'structure',
		defaultSeverity: 'error',
		title: 'Use only the source spellings this AST major can carry.',
		consequence:
			'A construct the AST cannot represent is dropped, not rendered. The page publishes with a hole in it and nothing on the page says why, which is why this rule is protected: a project that switched it off would ship those holes silently.',
		examples: [
			{ bad: 'The threshold is $$x > 3$$.', good: 'The threshold is `x > 3`.' },
			{ bad: ':::aside[Note]\nText.\n:::', good: ':::note[Note]\nText.\n:::' },
		],
	},

	// -------------------------------------------------------------------------
	// config
	// -------------------------------------------------------------------------

	'front-matter-invalid': {
		id: 'front-matter-invalid',
		category: 'config',
		defaultSeverity: 'error',
		title: 'Give every page front matter that validates.',
		consequence:
			'Front matter carries the title, the description and the translation state. A page that does not validate cannot be indexed, cannot be listed in the navigation and cannot be told apart from a page nobody has translated.',
		examples: [
			{
				bad: '---\ntitle:\n---',
				good: '---\ntitle: Chip support matrix\ndescription: Which chips work.\n---',
			},
		],
	},
	'title-length': {
		id: 'title-length',
		category: 'config',
		defaultSeverity: 'error',
		title: 'Keep the title inside the project title budget.',
		consequence:
			'A title longer than the budget is truncated in a search result and in the browser tab, so the part of it that identifies the page is the part the reader never sees.',
		examples: [
			{
				bad: 'Everything you could possibly need to know about reading and writing NFC tags with this application on an iPhone',
				good: 'Reading and writing NFC tags',
			},
		],
	},
	'description-length': {
		id: 'description-length',
		category: 'config',
		defaultSeverity: 'error',
		title: 'Keep the description inside the project description budget.',
		consequence:
			'The description is the meta description and the search result snippet. Over the budget it is cut mid sentence, and the cut lands in a different place in each of the seven languages.',
		examples: [
			{
				bad: 'A description that keeps going well past the point where a search engine stops printing it, and then keeps going again, and then adds one more clause for good measure so that nothing after the first line survives.',
				good: 'Which NFC chips the app can read and write, and the caveats on each.',
			},
		],
	},
	'description-is-a-sentence': {
		id: 'description-is-a-sentence',
		category: 'config',
		defaultSeverity: 'info',
		title: 'Write the description as a sentence.',
		consequence:
			'The description is printed to a reader deciding whether to open the page, so a list of keywords reads as a page that was filled in rather than written.',
		examples: [
			{ bad: 'nfc, tags, chips, ndef', good: 'Which NFC chips the app can read and write.' },
		],
	},

	// -------------------------------------------------------------------------
	// links
	// -------------------------------------------------------------------------

	'link-resolves': {
		id: 'link-resolves',
		category: 'links',
		defaultSeverity: 'error',
		title: 'Point every link at a page that exists.',
		consequence:
			'A link that does not resolve is dropped to plain text rather than published, so the words stay and the navigation quietly does not. Nothing on the rendered page shows that a link was ever there.',
		examples: [{ bad: '[the matrix](chip-suport.md)', good: '[the matrix](chip-support.md)' }],
	},
	'anchor-resolves': {
		id: 'anchor-resolves',
		category: 'links',
		defaultSeverity: 'error',
		title: 'Point every fragment link at a heading that exists.',
		consequence:
			'A fragment nothing answers loads the page at the top with no error, so the reader is left on a long page looking for a section that was renamed.',
		examples: [{ bad: '[the module graph](#modules)', good: '[the module graph](#module-graph)' }],
	},
	'snippet-resolves': {
		id: 'snippet-resolves',
		category: 'links',
		defaultSeverity: 'error',
		title: 'Transclude only snippets that exist in this locale.',
		consequence:
			'An include nothing answers leaves the page with the paragraph missing, and the missing paragraph is usually the safety note, because that is the content a snippet exists to keep identical everywhere.',
		examples: [{ bad: '::include[safety-notes]', good: '::include[safety-note]' }],
	},

	// -------------------------------------------------------------------------
	// nav
	// -------------------------------------------------------------------------

	'orphan-page': {
		id: 'orphan-page',
		category: 'nav',
		defaultSeverity: 'warning',
		title: 'Put every published page in the navigation, or mark it hidden on purpose.',
		consequence:
			'A page nothing links to is reachable only by search, so it is written, translated and published and then read by nobody. A page that really should be out of the sidebar says so in its front matter, which is the difference between a decision and an oversight.',
		examples: [
			{
				bad: 'A page under content/en/guide/ with no entry in nav.json.',
				good: 'The same page listed in the guide group, or marked hidden.',
			},
		],
	},
	'nav-duplicate': {
		id: 'nav-duplicate',
		category: 'nav',
		defaultSeverity: 'error',
		title: 'List each page once in the navigation.',
		consequence:
			'A slug in two groups gives the page two positions in the sidebar and two entries in the previous and next chain, and the reader who follows one of them arrives somewhere the other says they cannot be.',
		examples: [
			{
				bad: 'guide/first-tag in both the guide group and the reference group.',
				good: 'guide/first-tag in the guide group only.',
			},
		],
	},
	'nav-depth': {
		id: 'nav-depth',
		category: 'nav',
		defaultSeverity: 'error',
		title: 'Keep the navigation inside the depth the sidebar renders.',
		consequence:
			'The sidebar renders a fixed number of levels. A group nested deeper than that is in the file and not on the screen, so the pages under it are orphans that the orphan check cannot see.',
		examples: [
			{ bad: 'A group inside a group inside a group.', good: 'A group with pages under it.' },
		],
	},
	'slug-reserved': {
		id: 'slug-reserved',
		category: 'nav',
		defaultSeverity: 'error',
		title: 'Do not use a slug the routing already owns.',
		consequence:
			'A page whose slug collides with a machine endpoint is shadowed by the route that was declared first, and which one wins is a property of declaration order rather than of anything on the page.',
		examples: [{ bad: 'A page at the search slug.', good: 'A page at the searching-tags slug.' }],
	},

	// -------------------------------------------------------------------------
	// i18n
	// -------------------------------------------------------------------------

	'translation-missing': {
		id: 'translation-missing',
		category: 'i18n',
		defaultSeverity: 'warning',
		title: 'Translate every published page into every published locale.',
		consequence:
			'Under graceful parity the site serves the source text with a notice and no indexing, which is a reader in one of seven languages reading English. Under required parity the same state blocks the publish, which is what the mode is for.',
		examples: [
			{
				bad: 'content/en/guide/first-tag.md with no Japanese file.',
				good: 'content/ja/guide/first-tag.md alongside it.',
			},
		],
	},
	'translation-stale': {
		id: 'translation-stale',
		category: 'i18n',
		defaultSeverity: 'warning',
		title: 'Retranslate a page after its English source changes.',
		consequence:
			'A stale translation describes behaviour the app no longer has, and it carries no sign of that on the page. It is worse than a missing translation, which at least tells the reader what they are looking at.',
		examples: [
			{
				bad: 'The English page revised in March and the Spanish one last touched in January.',
				good: 'Both committed after the change.',
			},
		],
	},
	'translation-is-source-text': {
		id: 'translation-is-source-text',
		category: 'i18n',
		defaultSeverity: 'warning',
		title: 'Do not leave a scaffolded page carrying the English body.',
		consequence:
			'A scaffolded file is committed after the source, so every timestamp says it is current and the translation notice never appears. Nothing but this check and the translated flag can tell the reader they are looking at English on a page that claims to be their language.',
		examples: [
			{
				bad: 'A Spanish page whose body is the English text with a Spanish title.',
				good: 'The same page translated, or marked as not translated.',
			},
		],
	},
	'heading-set-matches-source': {
		id: 'heading-set-matches-source',
		category: 'i18n',
		// Lower than the defect deserves, and deliberately. `diagnostics.ts` describes this
		// as an error when the translation is current and a warning when it is already
		// stale, and a rule cannot express that split: severity is resolved from the
		// registry and the config outside the rule, so one id carries one default. The
		// lower of the two is the safe one, because the higher would deadlock a project
		// into retranslating every page before it could publish a typo fix. A project whose
		// translations are current raises it.
		defaultSeverity: 'warning',
		title: 'Keep the heading set identical across translations.',
		consequence:
			'Anchors are derived from headings, so a heading that exists in one language and not another breaks every inbound deep link into that page in that language, and nothing on the page reports a fragment that matched nothing.',
		examples: [
			{
				bad: 'The English page has five headings and the French one has four.',
				good: 'Both have the same five, translated.',
			},
		],
	},
	'glossary-term-translated': {
		id: 'glossary-term-translated',
		category: 'i18n',
		defaultSeverity: 'warning',
		title: 'Translate a glossary term exactly one way, and leave the untranslatable ones alone.',
		consequence:
			'Seven languages and one page written across several sessions is how the same object ends up with three words for it in one manual, and how a chip part number ends up translated and then unsearchable.',
		examples: [
			{
				bad: 'NDEF rendered as a localised acronym.',
				good: 'NDEF left as it is printed on the chip.',
			},
		],
	},
	'bidi-balance': {
		id: 'bidi-balance',
		category: 'i18n',
		defaultSeverity: 'error',
		title: 'Balance every bidirectional control character.',
		consequence:
			'An unclosed isolate does not affect one word. It reorders the rest of the paragraph and often the rest of the page, and the damage is invisible in a diff because the characters have no width.',
		examples: [
			{
				bad: 'An Arabic paragraph opening an isolate that nothing pops.',
				good: 'Every isolate closed where the Latin run ends.',
			},
		],
	},

	// -------------------------------------------------------------------------
	// house style
	// -------------------------------------------------------------------------

	'no-em-dash': {
		id: 'no-em-dash',
		category: 'house-style',
		defaultSeverity: 'error',
		title: 'Do not use em dashes in prose.',
		consequence:
			'The em dash is the single most reliable marker of copy nobody read back, and this is one of the estate house rules, stated as a hard rule rather than a preference. That is why a project may raise it and may not lower it.',
		examples: [
			{
				bad: `The session ends ${EM_DASH} the tag is left readable.`,
				good: 'The session ends, and the tag is left readable.',
			},
		],
	},
	'no-en-dash-prose': {
		id: 'no-en-dash-prose',
		category: 'house-style',
		defaultSeverity: 'error',
		title: 'Do not use en dashes as prose punctuation.',
		consequence:
			'It reads as an em dash to everyone but a typesetter, and it is the same house rule. Between digits it is correct and permitted, because rewriting a numeric range is not an improvement.',
		examples: [
			{
				bad: `Hold the tag still ${EN_DASH} the write takes two seconds.`,
				good: `The lock bits changed across the 2019${EN_DASH}2024 revisions.`,
			},
		],
	},
	'no-decorative-unicode': {
		id: 'no-decorative-unicode',
		category: 'house-style',
		defaultSeverity: 'error',
		title: 'Do not use arrows, bullets or emoji as punctuation.',
		consequence:
			'A screen reader announces the character by name in every one of the seven languages, and a search for the word the character was standing in for matches nothing. A glyph that is really data is recognised as a status node before this rule runs, so what it sees is decoration.',
		examples: [
			{
				bad: `On a successful connect the state is polling ${RIGHTWARDS_ARROW} connected.`,
				good: 'On a successful connect the state goes from polling to connected.',
			},
		],
	},
	'no-banned-phrase': {
		id: 'no-banned-phrase',
		category: 'house-style',
		defaultSeverity: 'error',
		title: 'Do not use a phrase from the house banned list.',
		consequence:
			'Each phrase on the list is one a reader has met a thousand times in generated copy, and one of them on a page is enough for the whole page to read as machine written. The list is a hard rule, which is why a project may add to it and may not remove from it.',
		examples: [
			{
				bad: 'Passing a payload between them is seamless.',
				good: 'Passing a payload between them needs no conversion.',
			},
		],
	},
	'no-filler-verb-stack': {
		id: 'no-filler-verb-stack',
		category: 'house-style',
		defaultSeverity: 'warning',
		title: 'Delete the filler in front of the verb.',
		consequence:
			'"Designed to" and its family describe an intention rather than a behaviour, which quietly excuses the case where the software does something else. The reader is holding the software, not the design.',
		examples: [
			{
				bad: 'The retry loop is designed to handle a tag that moves.',
				good: 'The retry loop handles a tag that moves.',
			},
		],
	},
	'no-hedging-stack': {
		id: 'no-hedging-stack',
		category: 'house-style',
		defaultSeverity: 'warning',
		title: 'Use one hedge, not two.',
		consequence:
			'Stacked hedges leave the reader unable to tell whether the thing happens, and a troubleshooting page that cannot say that has not helped anybody.',
		examples: [
			{
				bad: 'A thicker case may potentially block the antenna.',
				good: 'A case thicker than 3 mm blocks the antenna.',
			},
		],
	},
	'no-rhetorical-opener': {
		id: 'no-rhetorical-opener',
		category: 'house-style',
		defaultSeverity: 'warning',
		title: 'Do not ask a question you answer in the next sentence.',
		consequence:
			'The question costs the reader a line and tells them nothing, and in a heading it makes the table of contents a list of questions rather than a list of subjects. A page whose front matter says it is a set of questions is exempt, because there the question is the content.',
		examples: [
			{
				bad: 'Why does the read fail? The antenna sits at the top edge of the phone.',
				good: 'A read fails when the antenna is not over the tag.',
			},
		],
	},
	'no-triad': {
		id: 'no-triad',
		category: 'house-style',
		defaultSeverity: 'info',
		title: 'Do not stack three adjectives for rhythm.',
		consequence:
			'Three adjectives in a row is a cadence rather than a claim, and a reader can act on none of them. It defaults low because there is no part-of-speech tagger here and a list of three facts is not the same thing.',
		examples: [
			{
				bad: 'The reader is fast, simple and reliable.',
				good: 'The reader answers in 700 ms and needs no pairing.',
			},
		],
	},
	'no-symmetric-pairs': {
		id: 'no-symmetric-pairs',
		category: 'house-style',
		defaultSeverity: 'info',
		title: 'Vary sentence length deliberately.',
		consequence:
			'A run of sentences the same length is the strongest structural tell there is, and it is also the fuzziest thing this linter measures, which is why it is advice rather than a warning.',
		examples: [
			{
				bad: 'The reader opens a session and waits for a tag to come into range. The writer replaces the message and reports the free bytes left. The logger records the chip type and the time the scan finished.',
				good: 'The reader opens a session and waits. The writer replaces the whole message, reports the free bytes left, and hands the session back. Then the logger records it.',
			},
		],
	},
	'no-bolded-bullet-leadins': {
		id: 'no-bolded-bullet-leadins',
		category: 'house-style',
		defaultSeverity: 'warning',
		title: 'Do not open every bullet in a list with a bold phrase.',
		consequence:
			'Bold on every item is bold on none of them, and the pattern turns a list of sentences into a glossary the author did not mean to write.',
		examples: [
			{
				bad: '- **Fast:** it answers quickly.\n- **Safe:** it never rewrites.',
				good: '- It answers in 700 ms.\n- It never rewrites a locked tag.',
			},
		],
	},
	'australian-spelling': {
		id: 'australian-spelling',
		category: 'house-style',
		defaultSeverity: 'info',
		title: 'Use Australian English spelling.',
		consequence:
			'Mixed spelling inside one manual reads as pages written by different people at different times, which is exactly what it is. It defaults low because a project has technical terms this rule must be told about, and because it runs on the source locale only.',
		examples: [
			{
				bad: 'The Design package holds the color tokens.',
				good: 'The Design package holds the colour tokens.',
			},
		],
	},

	// -------------------------------------------------------------------------
	// brand
	// -------------------------------------------------------------------------

	'no-competitor-name': {
		id: 'no-competitor-name',
		category: 'brand',
		defaultSeverity: 'error',
		title: 'Do not name a competitor on a published page.',
		consequence:
			'The names come from the deny list, which lives outside the publishable root because it is the list of things that must not ship. A competitor named on a public page is a comparison the company has to stand behind, made by whoever wrote that sentence.',
		examples: [
			{
				bad: 'Contoso Tap keeps its codec inside the app target.',
				good: 'Some readers keep the codec inside the app target.',
			},
		],
	},
	'internal-leak': {
		id: 'internal-leak',
		category: 'brand',
		defaultSeverity: 'error',
		title: 'Do not publish anything the deny list patterns match.',
		consequence:
			'This is the rule that stands between an internal tree name, an export-compliance note or a device identifier and a public mirror. It is protected for the same reason the public sync script dies on any hit: a scan that examined nothing has cleared nothing.',
		examples: [
			{
				bad: 'Internal builds add station-pack-alpha to the profile set.',
				good: 'Internal builds add a separate profile set.',
			},
		],
	},

	// -------------------------------------------------------------------------
	// assets
	// -------------------------------------------------------------------------

	'alt-text-required': {
		id: 'alt-text-required',
		category: 'assets',
		defaultSeverity: 'error',
		title: 'Give every image alt text.',
		consequence:
			'An image with no alt text is announced as its file name, and on a procedure page the screenshot is often the step. There is no version of this that a reader using a screen reader can work around.',
		examples: [
			{
				bad: '![](../../../assets/scan-screen.png)',
				good: '![The Scan sheet waiting for a tag](../../../assets/scan-screen.png)',
			},
		],
	},
	'asset-colour-space': {
		id: 'asset-colour-space',
		category: 'assets',
		defaultSeverity: 'error',
		title: 'Publish assets in sRGB.',
		consequence:
			'A Display P3 screenshot published as if it were sRGB lands every colour short of where it should be, and the page looks flat on every display that does not know better. This is a refusal rather than a conversion, because a conversion here would have to run a tool whose output varies by build and the manifest has to be reproducible from the commit alone.',
		examples: [
			{
				bad: 'A screenshot straight off the device, tagged Display P3.',
				good: 'The same screenshot converted to sRGB before it was committed.',
			},
		],
	},
	'asset-size': {
		id: 'asset-size',
		category: 'assets',
		defaultSeverity: 'error',
		title: 'Keep every asset inside the project byte budget.',
		consequence:
			'Assets are copied into the consuming site public directory and served from its origin, so an oversized one is downloaded by every reader of the page and counted against the build it is copied through.',
		examples: [
			{
				bad: 'A 12 MB PNG of a phone screen.',
				good: 'The same screenshot at the size it renders.',
			},
		],
	},
	'asset-svg-unsafe': {
		id: 'asset-svg-unsafe',
		category: 'assets',
		defaultSeverity: 'error',
		title: 'Ship only inert SVG.',
		consequence:
			'An SVG is a document on the origin of the consuming site, not only an image source, so a script element or an external reference inside one runs against that origin. That is why this rule is protected and why the sanitiser is held at full coverage.',
		examples: [
			{
				bad: '<svg><script>fetch("/admin")</script></svg>',
				good: '<svg><path d="M7 8.5a6 6 0 0 1 0 7" /></svg>',
			},
		],
	},
} satisfies Record<LintRuleId, RuleDefinition>;

/**
 * The severity a rule runs at for one locale, after the project has had its say.
 *
 * A protected rule always resolves to `error`, whatever the config says. The schema
 * already refuses a config that lowers one, and this is the second half of the same
 * guarantee rather than a duplicate of it: a config that reached the runner without
 * going through the schema, from a hand-edited file, a test, or a future loader, must
 * not be able to switch off `internal-leak`. The guarantee is a property of the estate,
 * so it holds wherever the config came from.
 *
 * `RuleConfig.locales` narrows an override rather than the rule. An override that does
 * not name this locale leaves the rule at its default here, which is what lets a project
 * hold its English prose to a higher standard than a translation it has not reviewed.
 */
export function resolveSeverity(
	id: LintRuleId,
	lint: LintConfig | undefined,
	locale: Locale,
): Severity | 'off' {
	if (isProtectedRule(id)) return 'error';

	const fallback: Severity = RULE_DEFINITIONS[id].defaultSeverity;
	const setting = lint?.rules?.[id];
	if (setting === undefined) return fallback;
	if (typeof setting === 'string') return setting;

	const locales = setting.locales;
	if (locales !== undefined && locales.length > 0 && !locales.includes(locale)) return fallback;
	return setting.severity;
}
