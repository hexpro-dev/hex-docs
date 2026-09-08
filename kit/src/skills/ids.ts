/**
 * The bundled skills, as a closed union.
 *
 * In its own module rather than beside the loader, because `registry/command.ts` needs
 * the type for `taughtBy` and the loader needs the registry to validate against. A
 * single module would be a cycle.
 *
 * Five, and the merges are the ones the adversarial review of the original design named
 * and it then declined to make. Four authoring skills (`author-page`, `add-images`,
 * `translate-page`, `review-translation`) are one session's work done in sequence, so
 * they are one skill with sections. Migration runs once per repository ever, so it folds
 * into `docs-init-source`. `docs-write-user-manual` is not here at all: its load-bearing
 * first step was a coverage report over an app's string catalogue keyed by screen prefix,
 * and the only app with strings keys them by their English source text, so a skill whose
 * first instruction is "do not guess" would have been built on a file format that does
 * not exist. `docs-tune-search` is not here because nobody has typed a query yet.
 */

export const SKILL_IDS = [
	'docs-init-source',
	'docs-authoring',
	'docs-install-site',
	'docs-publish-version',
	'docs-diagnose',
] as const;

export type SkillId = (typeof SKILL_IDS)[number];

export function isSkillId(value: string): value is SkillId {
	return (SKILL_IDS as readonly string[]).includes(value);
}
