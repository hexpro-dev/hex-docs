/**
 * The house phrase pack: the banned phrasings from the global rules, as data.
 *
 * Every entry here is one line of the estate's "Banned phrasings and structures" list
 * turned into something a machine can find. The list is a hard rule rather than a
 * preference, which is why `no-banned-phrase` is protected and defaults to `error`, and
 * that severity is the constraint every pattern below is written against: a project
 * cannot lower the rule, so a pattern that fires on ordinary technical prose blocks a
 * publish with no way out but a suppression comment. Where a banned word also has a
 * plain technical meaning, the pattern therefore matches the marketing construction and
 * not the bare word.
 *
 * Two traps are designed around here, and both cost a page of documentation when they
 * are undone.
 *
 * **`leverage` and `harness` are banned as verbs and are ordinary nouns.** A wiring
 * harness, a test harness and mechanical leverage all belong in a technical document. So
 * neither is patterned as a bare word. Each is recognised only with a subject pronoun or
 * an auxiliary in front of it, or an object article behind it, which is what a verb has
 * and what the nouns in those phrases do not.
 *
 * **`suggest` holds replacements, never advice.** `Finding.suggestion` is a string safe to
 * apply verbatim, so an entry whose fix is "rewrite the sentence" carries an empty array
 * and lets the reason in `why` do the work. An instruction parked in `suggest` would
 * reach an agent as text it is entitled to paste into the page.
 *
 * **A paragraph opener is only a violation at the start of a paragraph.** `Ultimately`,
 * `Moreover` and the rest are listed in the global rules as openers, and mid sentence
 * they are ordinary words. Those entries are collected in `PARAGRAPH_OPENERS` and the
 * rule applies the position, rather than a `^` being baked into a pattern that is also
 * run over the middle of a sentence. Baking it in would make the exported pack wrong for
 * anyone running it any other way, which is the whole reason the pack is exported.
 */

import type { BannedPhrase } from '../../../../src/contracts/lint.js';

/**
 * Flags stored on an entry, with `g` deliberately absent.
 *
 * A global regex carries `lastIndex` between calls, so a shared compiled instance
 * answers differently on its second use. `compiledPhrase` adds `g` where it needs a
 * scan, which keeps the stored entry a description of what is banned rather than a
 * piece of scanning state.
 */
const INSENSITIVE = 'i';

/**
 * The phrasings that are wrong wherever they appear.
 *
 * Ordered as the global rules list them, so a reader can check the two against each
 * other without a lookup table.
 */
const ANYWHERE: readonly BannedPhrase[] = [
	// "It's not just X, it's Y" and its family. Two spellings, because the construction
	// appears both with an explicit subject in front and with the pivot behind.
	{
		id: 'it-is-not-just',
		pattern:
			"\\b(?:it(?:'s|s| is)|this is|that(?:'s|s| is)|these are|they(?:'re| are))\\s+not\\s+(?:just|merely|simply|only)\\b",
		flags: INSENSITIVE,
		why: 'The construction promises a revelation the next clause never delivers, and the sentence reads as an advertisement for the product rather than a statement about it.',
		suggest: [],
	},
	{
		id: 'not-just-x-its-y',
		pattern:
			"\\bnot\\s+(?:just|merely|only)\\b[^.?!]{1,80},\\s*(?:it(?:'s| is)|they(?:'re| are))\\b",
		flags: INSENSITIVE,
		why: 'The pivot on a comma is the most recognisable shape in generated marketing copy, and a reader who has seen it once stops trusting the page.',
		suggest: [],
	},
	{
		id: 'more-than-just',
		pattern: '\\bmore\\s+than\\s+(?:just|merely|simply)\\b',
		flags: INSENSITIVE,
		why: 'It claims scope without naming any, so the sentence carries no information a reader can act on.',
		suggest: [],
	},

	// "In today's fast-paced world" and its variants.
	{
		id: 'in-todays-world',
		pattern:
			"\\bin\\s+(?:today'?s|the)\\s+(?:fast[\\s-]paced|ever[\\s-](?:evolving|changing)|rapidly[\\s-]evolving|modern|digital|connected|competitive)\\s+(?:world|landscape|market|marketplace|environment|era|age)\\b",
		flags: INSENSITIVE,
		why: 'It is an opening that says nothing about the product and dates the page the moment it is published.',
		suggest: [],
	},
	{
		id: 'in-an-era-of',
		pattern: '\\bin\\s+an\\s+era\\s+of\\b',
		flags: INSENSITIVE,
		why: 'The same empty opening in a different costume, and it commits the page to a claim about the world that nothing on it supports.',
		suggest: [],
	},

	// The single-word list. Each of these is banned outright by the global rules; the
	// patterns that look narrow are the ones whose bare word has a plain technical
	// meaning, and the narrowing is what keeps the rule from blocking a real page.
	{
		id: 'unlock',
		pattern:
			'\\bunlock(?:s|ed|ing)?\\s+(?:the\\s+|your\\s+|its\\s+|their\\s+|new\\s+|full\\s+){0,3}(?:power|potential|value|possibilities|insights|productivity|capabilities)\\b',
		flags: INSENSITIVE,
		why: 'The marketing sense of the word promises something the page cannot show, and unlocking is a real operation on a tag or a device, so only the figurative use is refused.',
		suggest: [],
	},
	{
		id: 'unleash',
		pattern: '\\bunleash(?:es|ed|ing)?\\b',
		flags: INSENSITIVE,
		why: 'There is no technical sense of the word, so every use is the advertisement it sounds like.',
		suggest: [],
	},
	{
		id: 'empower',
		pattern: '\\bempower(?:s|ed|ing|ment)?\\b',
		flags: INSENSITIVE,
		why: 'It tells the reader how to feel about a feature rather than what the feature does.',
		suggest: [],
	},
	{
		id: 'elevate',
		pattern:
			'\\belevat(?:e|es|ing)\\s+(?:your|their|the\\s+(?:user|customer|reader|experience|design))\\b',
		flags: INSENSITIVE,
		why: 'It is a claim about taste with nothing behind it, and the literal sense of raising something is left alone so an engineering page can still use the word.',
		suggest: [],
	},
	{
		id: 'supercharge',
		pattern: '\\bsupercharg(?:e|es|ed|ing)\\b',
		flags: INSENSITIVE,
		why: 'It substitutes an engine metaphor for a number a performance claim needs.',
		suggest: [],
	},
	{
		id: 'revolutionise',
		pattern: '\\brevolution(?:is|iz)(?:e|es|ed|ing)\\b',
		flags: INSENSITIVE,
		why: 'Both spellings claim an industry-wide change that a release note cannot support.',
		suggest: [],
	},
	{
		id: 'transform-your',
		pattern: '\\btransform(?:s|ed|ing)?\\s+your\\b',
		flags: INSENSITIVE,
		why: 'The possessive turns a description into a sales pitch, while the plain verb stays available for a page that really is about converting one thing into another.',
		suggest: [],
	},
	{
		id: 'next-level',
		pattern:
			'\\btak(?:e|es|ing)\\s+(?:it|this|that|things|your\\s+\\w+)\\s+to\\s+the\\s+next\\s+level\\b',
		flags: INSENSITIVE,
		why: 'It names no level and no measure, and the literal phrase is left alone so a page about nesting or hierarchy can still use it.',
		suggest: [],
	},
	{
		id: 'game-changer',
		pattern: '\\bgame[\\s-]?chang(?:er|ers|ing)\\b',
		flags: INSENSITIVE,
		why: 'It is a verdict rather than a description, and the reader has to take it on trust.',
		suggest: [],
	},
	{
		id: 'seamless',
		pattern: '\\bseamless(?:ly)?\\b',
		flags: INSENSITIVE,
		why: 'It claims an absence of friction the reader will discover for themselves, and it is the word most often used to cover a step the page has not documented.',
		suggest: [],
	},
	{
		id: 'effortless',
		pattern: '\\beffortless(?:ly)?\\b',
		flags: INSENSITIVE,
		why: 'Effort is for the reader to judge, and a page that has already claimed it has nothing left to say when a step turns out to be fiddly.',
		suggest: [],
	},
	{
		id: 'robust',
		pattern: '\\brobust(?:ly|ness)?\\b',
		flags: INSENSITIVE,
		why: 'It is an adjective that survives the deletion of every fact around it, which is why it turns up where the facts are missing.',
		suggest: [],
	},
	{
		id: 'cutting-edge',
		pattern: '\\bcutting[\\s-]edge\\b',
		flags: INSENSITIVE,
		why: 'It dates the page the moment anything newer ships.',
		suggest: [],
	},
	{
		id: 'state-of-the-art',
		pattern: '\\bstate[\\s-]of[\\s-]the[\\s-]art\\b',
		flags: INSENSITIVE,
		why: 'The same dated claim in a longer form, and no reader has ever checked it.',
		suggest: [],
	},
	{
		id: 'best-in-class',
		pattern: '\\bbest[\\s-]in[\\s-]class\\b',
		flags: INSENSITIVE,
		why: 'It names neither the class nor the measure, so it cannot be true or false.',
		suggest: [],
	},
	{
		id: 'world-class',
		pattern: '\\bworld[\\s-]class\\b',
		flags: INSENSITIVE,
		why: 'A superlative with no subject, and it reads as filler even to a reader who agrees with it.',
		suggest: [],
	},
	{
		// Verb only, and the shape of the pattern is what makes that true. An auxiliary in
		// front, or an object behind: "gives you leverage over the lock bits" has neither, and
		// a subject pronoun in the first half would have caught exactly that sentence.
		id: 'leverage-as-a-verb',
		pattern:
			'\\b(?:to|we|can|could|will|would|should|may|might|must)\\s+leverages?\\b|\\bleverag(?:e|es|ed|ing)\\s+(?:the|a|an|our|your|its|their|this|that|these|those|existing|it|them)\\b',
		flags: INSENSITIVE,
		why: 'As a verb it means "use" and costs the reader a syllable and a moment, and it is the clearest single marker of copy nobody read back.',
		suggest: ['use', 'build on'],
	},
	{
		id: 'delve',
		pattern: '\\bdelv(?:e|es|ed|ing)\\b',
		flags: INSENSITIVE,
		why: 'Nobody says it out loud, which is why it marks a page as machine written more reliably than anything else on this list.',
		suggest: ['look at', 'go through'],
	},
	{
		// Verb only, for the same reason as leverage. A wiring harness and a test harness
		// are both nouns a real page needs.
		id: 'harness-as-a-verb',
		pattern:
			'\\b(?:to|we|can|could|will|would|should|may|might|must)\\s+harness(?:es)?\\b|\\bharness(?:es|ed|ing)\\s+(?:the|a|an|our|your|its|their|this|that|these|those|it|them)\\b',
		flags: INSENSITIVE,
		why: 'As a verb it is a metaphor doing the work a plain verb would do better, while the noun is an ordinary piece of equipment and stays.',
		suggest: ['use', 'read', 'drive'],
	},
	{
		id: 'navigate-the-landscape',
		pattern:
			'\\bnavigat(?:e|es|ed|ing)\\s+the\\s+(?:landscape|complexities|complexity|challenges|ecosystem)\\b',
		flags: INSENSITIVE,
		why: 'It is a metaphor stacked on a metaphor, and what the reader has to do is still unstated afterwards.',
		suggest: [],
	},
	{
		id: 'tapestry',
		pattern: '\\btapestr(?:y|ies)\\b',
		flags: INSENSITIVE,
		why: 'A decorative noun with no place in a document about software.',
		suggest: [],
	},
	{
		id: 'testament-to',
		pattern: '\\btestament\\s+to\\b',
		flags: INSENSITIVE,
		why: 'It asks the reader to admire something rather than telling them what it is.',
		suggest: [],
	},
	{
		// "Realm" is a live technical term: a Kerberos realm, an authentication realm and
		// the Realm database are all real. Only the figurative "realm of" is refused.
		id: 'realm-of',
		pattern: '\\brealms?\\s+of\\b',
		flags: INSENSITIVE,
		why: 'The figurative sense is filler, and the technical senses of the word are left alone so an authentication page can still use it.',
		suggest: [],
	},
];

/**
 * The phrasings that are only violations where a paragraph begins.
 *
 * The global rules qualify this whole group with "as paragraph openers", and mid
 * sentence every one of them is ordinary English: "what ultimately matters" is a
 * sentence anybody might write. So the rule anchors them at the start of a prose
 * segment, which is one block, and a `Furthermore,` that opens the third sentence of a
 * paragraph escapes. That miss is deliberate: `no-banned-phrase` is protected and cannot
 * be lowered by a project, so a pattern that fires where the phrasing might be innocent
 * costs a build that nobody can unblock.
 *
 * The two structural openers are here for the same positional reason rather than a
 * qualitative one. "from it, count to two, and scan again" is a correct sentence in the
 * fixture corpus and would match `from-x-to-y` anywhere but at the start.
 */
export const PARAGRAPH_OPENERS: readonly BannedPhrase[] = [
	{
		id: 'whether-you-are',
		pattern: "\\bwhether\\s+you(?:'re|\\s+are)\\b",
		flags: INSENSITIVE,
		why: 'The opener addresses two readers at once and commits to neither, so the paragraph under it has to stay general enough to be useless to both.',
		suggest: [],
	},
	{
		id: 'from-x-to-y',
		pattern: '\\bfrom\\s+(?:\\w+\\s+){1,4}\\w+\\s+to\\s+(?:\\w+\\s+){1,4}\\w+\\s*,',
		flags: INSENSITIVE,
		why: 'The range opener implies a spectrum the page never returns to, and it is nearly always followed by a sentence that would have been a better opening.',
		suggest: [],
	},
	{
		id: 'lets-dive-in',
		pattern: "\\blet'?s\\s+dive\\s+(?:in|into)\\b",
		flags: INSENSITIVE,
		why: 'It announces that the page is about to begin, which the reader can already see.',
		suggest: [],
	},
	{
		id: 'thats-where-x-comes-in',
		pattern: "\\bthat'?s\\s+where\\s+[^.?!]{1,40}\\s+comes?\\s+in\\b",
		flags: INSENSITIVE,
		why: 'It is the hinge of a sales pitch, and it makes the paragraph before it read as a problem invented for the product to solve.',
		suggest: [],
	},
	{
		id: 'the-best-part',
		pattern: '\\bthe\\s+best\\s+part\\b',
		flags: INSENSITIVE,
		why: 'It ranks the page for the reader instead of letting them read it.',
		suggest: [],
	},
	{
		id: 'heres-the-thing',
		pattern: "\\bhere'?s\\s+the\\s+thing\\b",
		flags: INSENSITIVE,
		why: 'A false intimacy that delays the sentence carrying the information.',
		suggest: [],
	},
	{
		id: 'simply-put',
		pattern: '\\bsimply\\s+put\\b',
		flags: INSENSITIVE,
		why: 'If the next sentence is the simple one, it should have been the only one.',
		suggest: [],
	},
	{
		id: 'at-its-core',
		pattern: '\\bat\\s+its\\s+core\\b',
		flags: INSENSITIVE,
		why: 'It promises an essential truth and is followed by a summary the reader could have made.',
		suggest: [],
	},
	{
		id: 'ultimately',
		pattern: '\\bultimately\\b',
		flags: INSENSITIVE,
		why: 'As an opener it signals a conclusion the paragraph has not earned.',
		suggest: [],
	},
	{
		id: 'moreover',
		pattern: '\\bmoreover\\b',
		flags: INSENSITIVE,
		why: 'A register from an essay, not from documentation somebody is reading with a phone in one hand.',
		suggest: [],
	},
	{
		id: 'furthermore',
		pattern: '\\bfurthermore\\b',
		flags: INSENSITIVE,
		why: 'The same essay register, and the paragraph reads the same with it deleted.',
		suggest: [],
	},
	{
		id: 'additionally',
		pattern: '\\badditionally\\b',
		flags: INSENSITIVE,
		why: 'It joins two paragraphs that were never in tension, so it adds a word and no meaning.',
		suggest: ['also'],
	},
];

/**
 * Every house phrase, positional and not.
 *
 * One list, because this is what another repository imports when it wants the pack.
 * `PARAGRAPH_OPENERS` is the marking that says which of them the rule anchors, and it
 * holds the same objects rather than copies so the two cannot drift apart.
 */
export const HOUSE_PHRASES: readonly BannedPhrase[] = [...ANYWHERE, ...PARAGRAPH_OPENERS];

const OPENER_IDS: ReadonlySet<string> = new Set(PARAGRAPH_OPENERS.map((phrase) => phrase.id));

/** True when the phrase is only a violation where a paragraph begins. */
export function isParagraphOpener(id: string): boolean {
	return OPENER_IDS.has(id);
}

/**
 * Hedging stacks: two or three words of doubt where one verb would do.
 *
 * Separate from `HOUSE_PHRASES` because the finding is a different rule, and the rules
 * differ in severity: a hedging stack is a heuristic about voice, and the house phrase
 * list is a hard rule.
 */
export const HEDGING_STACKS: readonly BannedPhrase[] = [
	{
		id: 'may-potentially',
		pattern: '\\b(?:may|might|could|can)\\s+potentially\\b',
		flags: INSENSITIVE,
		why: 'Two hedges on one verb leave the reader unable to tell whether the thing happens.',
		suggest: ['may', 'can'],
	},
	{
		id: 'can-help-to',
		pattern: '\\b(?:can|may|might|will|would|should)\\s+helps?\\s+to\\b',
		flags: INSENSITIVE,
		why: 'It puts three words between the subject and what it does, and none of them says how much it helps.',
		suggest: [],
	},
	{
		id: 'aims-to',
		pattern: '\\baims?\\s+to\\s+(?:provide|deliver|ensure|help|offer|enable|support)\\b',
		flags: INSENSITIVE,
		why: 'An aim is not a behaviour, so the sentence describes an intention the software does not have.',
		suggest: [],
	},
	{
		id: 'may-be-able-to',
		pattern: '\\b(?:may|might|could)\\s+be\\s+able\\s+to\\b',
		flags: INSENSITIVE,
		why: 'The reader cannot act on a capability stated this weakly, and the page usually knows the answer.',
		suggest: [],
	},
	{
		id: 'seeks-to',
		pattern: '\\bseeks?\\s+to\\s+(?:provide|ensure|deliver|address)\\b',
		flags: INSENSITIVE,
		why: 'The same intention in place of a behaviour, in a more formal register.',
		suggest: [],
	},
];

/**
 * Filler verbs stacked in front of the real one.
 *
 * Each requires the infinitive behind it, because that is what makes the phrase filler.
 * A sentence that ends at "purpose built" or "custom built" is describing the thing
 * rather than padding a verb, and it is left alone.
 */
export const FILLER_VERB_STACKS: readonly BannedPhrase[] = [
	{
		id: 'designed-to',
		pattern: '\\bdesigned\\s+to\\s+[a-z]+\\b',
		flags: INSENSITIVE,
		why: 'The design intention adds nothing the behaviour does not already say, and it quietly excuses the case where the behaviour is different.',
		suggest: [],
	},
	{
		id: 'crafted-to',
		pattern: '\\bcrafted\\s+to\\s+[a-z]+\\b',
		flags: INSENSITIVE,
		why: 'The same filler with a workshop metaphor attached to it.',
		suggest: [],
	},
	{
		id: 'built-to',
		pattern: '\\bbuilt\\s+to\\s+[a-z]+\\b',
		flags: INSENSITIVE,
		why: 'It describes the builder rather than the software, and the reader is holding the software.',
		suggest: [],
	},
	{
		id: 'engineered-to',
		pattern: '\\bengineered\\s+to\\s+[a-z]+\\b',
		flags: INSENSITIVE,
		why: 'The same claim, and the more technical the word the more it is standing in for a measurement.',
		suggest: [],
	},
];

/**
 * The adjectives a rule-of-three triad is made of.
 *
 * A curated set, and the curation is the rule. There is no part-of-speech tagger here,
 * so a rule that flagged any three comma-separated items would flag "chip type, byte
 * counts, and the error", which is a list of facts a troubleshooting page has to carry
 * and not a rhetorical tic. Requiring every item to be one word from this list is what
 * separates the tic from the list, and the cost of the narrowness is a triad built from
 * an adjective nobody thought of, which is a miss rather than a false alarm.
 */
export const TRIAD_ADJECTIVES: readonly string[] = [
	'beautiful',
	'clean',
	'easy',
	'efficient',
	'elegant',
	'fast',
	'flexible',
	'intuitive',
	'lightweight',
	'modern',
	'performant',
	'portable',
	'powerful',
	'quick',
	'reliable',
	'responsive',
	'robust',
	'safe',
	'scalable',
	'seamless',
	'secure',
	'simple',
	'smart',
	'versatile',
];

const TRIAD_SET: ReadonlySet<string> = new Set(TRIAD_ADJECTIVES);

/** True when the word is one a triad is built from. Lower cased by the caller. */
export function isTriadAdjective(word: string): boolean {
	return TRIAD_SET.has(word);
}

/**
 * American spellings and what this estate writes instead.
 *
 * Word forms rather than lemmas, because there is no stemmer here and a rule that
 * guessed at inflections would suggest "organiseation". Every pair is a word a
 * documentation page really uses.
 *
 * Three families are deliberately absent. `practice` is a noun in Australian English and
 * only the verb is `practise`, so flagging it would fire on "in practice", which the
 * fixture corpus already contains. `program` is correct in computing here. Bare `meter`
 * is a real device, so only the unambiguous compounds are listed.
 */
export const AUSTRALIAN_SPELLINGS: readonly { american: string; australian: string }[] = [
	// ize to ise
	{ american: 'organize', australian: 'organise' },
	{ american: 'organized', australian: 'organised' },
	{ american: 'organization', australian: 'organisation' },
	{ american: 'recognize', australian: 'recognise' },
	{ american: 'recognized', australian: 'recognised' },
	{ american: 'customize', australian: 'customise' },
	{ american: 'customized', australian: 'customised' },
	{ american: 'initialize', australian: 'initialise' },
	{ american: 'initialized', australian: 'initialised' },
	{ american: 'normalize', australian: 'normalise' },
	{ american: 'serialize', australian: 'serialise' },
	{ american: 'synchronize', australian: 'synchronise' },
	{ american: 'authorize', australian: 'authorise' },
	{ american: 'authorized', australian: 'authorised' },
	{ american: 'prioritize', australian: 'prioritise' },
	{ american: 'summarize', australian: 'summarise' },
	{ american: 'minimize', australian: 'minimise' },
	{ american: 'maximize', australian: 'maximise' },
	{ american: 'optimize', australian: 'optimise' },
	{ american: 'optimized', australian: 'optimised' },
	{ american: 'utilize', australian: 'utilise' },
	{ american: 'analyze', australian: 'analyse' },
	{ american: 'analyzed', australian: 'analysed' },
	{ american: 'capitalize', australian: 'capitalise' },
	{ american: 'emphasize', australian: 'emphasise' },
	{ american: 'localize', australian: 'localise' },
	{ american: 'localized', australian: 'localised' },
	{ american: 'standardize', australian: 'standardise' },
	{ american: 'visualize', australian: 'visualise' },

	// our to or
	{ american: 'color', australian: 'colour' },
	{ american: 'colors', australian: 'colours' },
	{ american: 'colored', australian: 'coloured' },
	{ american: 'behavior', australian: 'behaviour' },
	{ american: 'behaviors', australian: 'behaviours' },
	{ american: 'favorite', australian: 'favourite' },
	{ american: 'honor', australian: 'honour' },
	{ american: 'labor', australian: 'labour' },
	{ american: 'neighbor', australian: 'neighbour' },
	{ american: 'flavor', australian: 'flavour' },
	{ american: 'humor', australian: 'humour' },
	{ american: 'rumor', australian: 'rumour' },
	{ american: 'armor', australian: 'armour' },
	{ american: 'vapor', australian: 'vapour' },
	{ american: 'endeavor', australian: 'endeavour' },

	// re to er
	{ american: 'center', australian: 'centre' },
	{ american: 'centers', australian: 'centres' },
	{ american: 'centered', australian: 'centred' },
	{ american: 'fiber', australian: 'fibre' },
	{ american: 'fibers', australian: 'fibres' },
	{ american: 'theater', australian: 'theatre' },
	{ american: 'centimeter', australian: 'centimetre' },
	{ american: 'centimeters', australian: 'centimetres' },
	{ american: 'millimeter', australian: 'millimetre' },
	{ american: 'millimeters', australian: 'millimetres' },
	{ american: 'kilometer', australian: 'kilometre' },
	{ american: 'kilometers', australian: 'kilometres' },

	// ce and se noun forms
	{ american: 'defense', australian: 'defence' },
	{ american: 'defenses', australian: 'defences' },
	{ american: 'offense', australian: 'offence' },
	{ american: 'pretense', australian: 'pretence' },
	{ american: 'license', australian: 'licence' },

	// doubled l
	{ american: 'traveled', australian: 'travelled' },
	{ american: 'traveling', australian: 'travelling' },
	{ american: 'canceled', australian: 'cancelled' },
	{ american: 'canceling', australian: 'cancelling' },
	{ american: 'modeling', australian: 'modelling' },
	{ american: 'labeled', australian: 'labelled' },
	{ american: 'labeling', australian: 'labelling' },
	{ american: 'signaled', australian: 'signalled' },
	{ american: 'fueled', australian: 'fuelled' },
	{ american: 'dialed', australian: 'dialled' },
	{ american: 'totaled', australian: 'totalled' },

	// the remainder, each a word a manual reaches for
	{ american: 'gray', australian: 'grey' },
	{ american: 'aluminum', australian: 'aluminium' },
	{ american: 'catalog', australian: 'catalogue' },
	{ american: 'catalogs', australian: 'catalogues' },
	{ american: 'maneuver', australian: 'manoeuvre' },
];

/**
 * Compiled patterns, one per entry, built once.
 *
 * Eagerly for the three tables here, so an invalid pattern is a module-load failure
 * rather than a rule that quietly finds nothing on the one page that needed it. The
 * cache stays open for the phrases a project adds in its own `docs.json`, which cannot
 * be known here and must not be recompiled per segment.
 *
 * Keyed by the entry object rather than its id, because a project phrase and a house
 * phrase can share an id and must not share a pattern.
 */
const COMPILED = new Map<BannedPhrase, RegExp>();

/**
 * The scanning form of a phrase: its own flags, plus `g`, wound back to the start.
 *
 * The rewind is not tidiness. A global regex carries `lastIndex` from its previous use,
 * so a cached instance handed to a second caller starts scanning halfway through the
 * text and answers `false` about a phrase that is right there. Callers that use
 * `matchAll` are safe either way; the ones that reach for `test` are not, and they are
 * the ones an estate script will write.
 */
export function compiledPhrase(phrase: BannedPhrase): RegExp {
	const cached = COMPILED.get(phrase);
	if (cached !== undefined) {
		cached.lastIndex = 0;
		return cached;
	}
	const flags = [...new Set([...phrase.flags, 'g'])].join('');
	const compiled = new RegExp(phrase.pattern, flags);
	COMPILED.set(phrase, compiled);
	return compiled;
}

for (const phrase of [...HOUSE_PHRASES, ...HEDGING_STACKS, ...FILLER_VERB_STACKS]) {
	compiledPhrase(phrase);
}
