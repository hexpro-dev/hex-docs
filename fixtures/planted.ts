/**
 * What the corpus carries on purpose, and which rule each thing exists to trip.
 *
 * Two kinds of thing, and the distinction is the point. A **violation** is prose the
 * linter must flag; a **data** character is one the compiler must recognise as content
 * before any prose rule looks at it. The same em dash is both, depending on where it
 * sits, which is exactly why neither can be left to a comment.
 *
 * Characters live in `planted.json` rather than here, because `scripts/lint.mjs` is a
 * zero-dependency `.mjs` that has to read them without a compiler. This file is the
 * typed view of that data plus the planted prose, which only the toolchain reads.
 *
 * Rule ids are typed as `LintRuleId`, so renaming a rule without updating the corpus
 * fails the typecheck rather than leaving a planted violation that nothing claims.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LintRuleId } from '../src/contracts/lint.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export type PlantedKind = 'data' | 'violation';

export interface PlantedCharacterGroup {
	id: string;
	kind: PlantedKind;
	/** `status` for the data groups, which are recognised rather than reported. */
	rule: string;
	/** `U+XXXX` spellings, so this file carries no literal banned character either. */
	codePoints: string[];
	files: string[];
	why: string;
}

export interface PlantedCharacters {
	why: string;
	scope: string;
	groups: PlantedCharacterGroup[];
}

/** The same JSON `scripts/lint.mjs` reads, so the guard and the suite cannot disagree. */
export function plantedCharacters(): PlantedCharacters {
	return JSON.parse(readFileSync(join(HERE, 'planted.json'), 'utf8')) as PlantedCharacters;
}

/** `"U+2705"` to 0x2705. The one place the spelling is decoded. */
export function decodeCodePoint(spelling: string): number {
	const match = /^U\+([0-9A-F]{4,6})$/.exec(spelling);
	if (match === null) {
		throw new Error(
			`"${spelling}" is not a code point. Write it as U+XXXX in upper case hex, so that this ` +
				`declaration never contains the character it declares and never flags itself.`,
		);
	}
	return Number.parseInt(match[1] as string, 16);
}

/**
 * Source the linter must flag, and source that must survive a suppression.
 *
 * `needle` is the exact substring, so the suite can prove the planted text is still
 * there. A planted violation that quietly disappears leaves the rule with no coverage
 * and every row still green, which is the same failure the character declarations
 * close from the other side.
 */
export interface PlantedProse {
	/** Relative to `app/docs/site/`. */
	file: string;
	rule: LintRuleId;
	needle: string;
	/** True when the corpus also carries a suppression comment for this hit. */
	suppressed?: true;
	why: string;
}

export const PLANTED_PROSE: readonly PlantedProse[] = [
	{
		file: 'content/en/reference/api.md',
		rule: 'code-fence-language',
		needle: '```\nTagSession begin',
		why: 'The only fence in the corpus with no language. `Code.lang` is optional because an unlabelled fence is representable, and a bundle compiled under a project that downgraded this rule will contain one, so the AST needs the case and the linter still has to report it. Labelling it would take the absent-lang case out of the corpus; deleting the rule coverage would take the other half.',
	},
	{
		file: 'content/en/reference/api.md',
		rule: 'no-banned-phrase',
		needle: 'tap and go',
		suppressed: true,
		why: "A phrase the project bans in its own `docs.json` rather than one from the house pack, so the two sources of banned phrases are both exercised. It is the corpus's only suppressed hit, which is what gives `maxDisables` something to count.",
	},
	{
		file: 'content/en/developer/architecture.md',
		rule: 'no-banned-phrase',
		needle: 'seamless',
		why: 'A house-pack phrase, unsuppressed, so the same rule is exercised in both states on the same run.',
	},
	{
		file: 'content/en/developer/architecture.md',
		rule: 'internal-leak',
		needle: 'station-pack-alpha',
		why: 'Matches the `station-pack` pattern in `docs/docs.private.json`. This is the rule that stands between an internal tree name and a public page, and it is protected, so a project cannot lower it.',
	},
	{
		file: 'content/en/developer/architecture.md',
		rule: 'no-competitor-name',
		needle: 'Contoso Tap',
		why: 'Matches a string in the deny list. Both brand rules read that file, which is deliberately outside `docs/site/`: it names the things that must not ship, so keeping it inside the tree the publisher reads would be the same mistake in miniature.',
	},
];

/**
 * The corpus's suppression comments, which `maxDisables` caps at two.
 *
 * One, on purpose. A suppression with a reason is legitimate and a growing pile of them
 * is an opt-out nobody decided on, so the corpus has to contain at least one for the
 * counting to be exercised and fewer than the cap for the build to pass.
 */
export const PLANTED_SUPPRESSIONS: readonly { file: string; rule: LintRuleId; why: string }[] = [
	{
		file: 'content/en/reference/api.md',
		rule: 'no-banned-phrase',
		why: 'The page quotes the store listing verbatim, which is the one case where the phrase is the subject rather than the voice.',
	},
];
