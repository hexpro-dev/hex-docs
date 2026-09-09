/**
 * The GitHub Actions workflow that turns a commit on `main` into a bundle in S3.
 *
 * Written as an array of lines rather than one template literal, because every GitHub
 * expression in the file is spelled `${{ … }}` and a template literal reads the first two
 * characters of that as an interpolation. Building it line by line means the expressions
 * are ordinary single-quoted strings and cannot be mangled by a refactor that adds a
 * substitution somewhere else in the file.
 *
 * The style is `.github/workflows/ci.yml` in this repository: a paragraph above anything
 * non-obvious saying what breaks if it is undone, every action pinned to a major, and no
 * step whose purpose has to be guessed.
 *
 * This file is deliberately **not** added to a public mirror's allowlist. In hex-nfc,
 * `.github/workflows/` is allowlisted per file and `sync-public.yml` is excluded by
 * simply not being listed; a docs publish workflow is excluded by the same mechanism,
 * absence.
 *
 * The reason is what the file points at rather than what it contains, and the difference
 * is worth stating because the older wording here said it names the bucket and the role.
 * It does not: both are `vars.` reads, which is the entire purpose of them being
 * repository variables, so somebody auditing the allowlist against that sentence would
 * find no identifier in the file and conclude the exclusion was written for a version
 * that no longer exists. What the file does publish is the shape of the estate: that a
 * bundle store exists, that a role is assumed by OIDC from one branch, which region, and
 * the two variable names to go looking for. That is reconnaissance rather than a
 * credential, which is why this is an exclusion and not a refusal to write the file.
 */

/** There is no other place GitHub Actions reads workflows from. */
export const PUBLISH_WORKFLOW_PATH = '.github/workflows/docs-publish.yml';

/**
 * The directory the generated workflow builds into. A CI-only artefact.
 *
 * Exported, and that is the whole point of it being here. It was declared twice as a
 * private const, in `templates/source.ts` and in `commands/scaffold.ts`, and the skill an
 * agent follows by hand spelled it a third way as `.hexdocs-out`. Three spellings of one
 * scratch directory is three lines an app repository has to gitignore, and the one nobody
 * added is the one that gets committed.
 */
export const BUNDLE_OUT = '.hexdocs-bundle';

/**
 * The repository variable holding the publisher role's ARN.
 *
 * A variable and never a literal. The ARN carries the AWS account id, and this file is
 * committed to an app repository whose protection from a public mirror is one line in a
 * bash array. Set it under Settings, Secrets and variables, Actions, Variables.
 */
export const ROLE_VARIABLE = 'HEXDOCS_PUBLISH_ROLE';

/** The repository variable holding the bucket name. Same reasoning as the role. */
export const BUCKET_VARIABLE = 'HEXDOCS_BUCKET';

export interface PublishWorkflowOptions {
	/**
	 * Where the toolchain submodule is mounted, relative to the repository root, with
	 * forward slashes: `hex-docs` in the app repositories, `kcalc-web/docs` in kcalc.
	 */
	kitMount: string;
	/**
	 * The AWS region.
	 *
	 * A literal in the file rather than a variable, and the asymmetry with the bucket and
	 * the role is deliberate. A region names no account and grants nothing; this
	 * repository's own CLAUDE.md states it in public. Making it a variable would be a
	 * third thing to configure before the first publish, for no secret kept.
	 */
	region: string;
	/** The directory `build` writes and `publish` reads. A CI-only build artefact. */
	out: string;
}

export function publishWorkflow(options: PublishWorkflowOptions): string {
	const hexdocs = `${options.kitMount}/kit/bin/hexdocs`;

	const lines = [
		'name: docs-publish',
		'',
		'# Every push to main, and no `paths:` filter.',
		'#',
		'# A filter reads like an optimisation and is a correctness bug here. A bundle is keyed',
		'# by commit sha, and a version is published by labelling one of those shas; release',
		'# commits are precisely the commits least likely to touch the documentation tree.',
		'# Measured on hex-nfc: nine of about a hundred commits on main touch the published',
		'# docs, and the commit somebody would label 1.0 is not one of them. Under a filter that',
		'# sha has no bundle, so the version cannot be labelled at all, and the failure surfaces',
		'# weeks later in a different repository.',
		'on:',
		'  push:',
		'    branches: [main]',
		'  workflow_dispatch:',
		'',
		'# `id-token: write` is what mints the OIDC token the credentials step below exchanges',
		'# for temporary keys. Nothing here reads a long-lived access key and nothing should: a',
		'# key in a repository secret outlives whoever added it and is valid from anywhere.',
		'permissions:',
		'  id-token: write',
		'  contents: read',
		'',
		'# One publish at a time, and never cancelled. Every object is written once per key, so',
		'# two runs over the same prefix is a refusal rather than corruption; a cancelled run is',
		'# the dangerous one, because it can leave a prefix holding some objects and no',
		'# manifest, which reads as a bundle that exists and cannot be verified.',
		'concurrency:',
		'  group: docs-publish',
		'  cancel-in-progress: false',
		'',
		'jobs:',
		'  publish:',
		'    runs-on: ubuntu-latest',
		'    steps:',
		'      # Every action below is pinned to a major whose own action.yml declares node24, and',
		'      # that was read rather than assumed, because it is the one line here nobody can',
		'      # check by eye. Measured: actions/checkout and actions/setup-node declare node24 at',
		'      # v5, v6 and v7 alike, but aws-actions/configure-aws-credentials declares node20 at',
		'      # v5 and node24 only from v6, so the comment this replaces was false for one of its',
		'      # own four pins. The runners force a node20 action onto node24 today and print a',
		'      # deprecation, and they will stop running one at all; a bump here is a bump to a',
		'      # major whose runs: block says node24, never to whatever tag is newest.',
		'      - uses: actions/checkout@v7',
		'        with:',
		'          # The toolchain is a submodule. Without this the checkout is the app repository',
		'          # on its own and there is no hexdocs to run.',
		'          submodules: true',
		'          # Full history, not the default depth of 1. Translation freshness is a',
		'          # comparison of git committer dates, and a shallow clone gives every file the',
		'          # same date, so the whole corpus reads `current` and no stale translation is',
		'          # ever reported. The build detects a shallow clone and refuses rather than',
		'          # reporting a pass, so getting this wrong fails the job instead of publishing',
		'          # a wrong answer, but the answer is still to fetch the history.',
		'          fetch-depth: 0',
		'',
		'      # Here for the lockfile. `bin/hexdocs` installs its own dependencies on first run',
		'      # and falls back to npm when pnpm is absent, and npm ignores pnpm-lock.yaml and',
		'      # resolves fresh, so a publish would install something other than what was tested.',
		"      # The version comes from the kit's own packageManager field rather than from a",
		'      # number written here as well.',
		'      - uses: pnpm/action-setup@v6',
		'        with:',
		`          package_json_file: ${options.kitMount}/kit/package.json`,
		'',
		'      - uses: actions/setup-node@v7',
		'        with:',
		'          # 22 is the floor the toolchain declares and what the estate runs.',
		"          node-version: '22'",
		'',
		'      - uses: aws-actions/configure-aws-credentials@v6',
		'        with:',
		'          # A repository variable, never a literal. The ARN carries the account id, and',
		'          # this file lives in an app repository whose public mirror is protected by an',
		'          # allowlist that excludes this file by absence rather than by a rule. The',
		'          # region is a literal for the opposite reason: it names no account, grants',
		'          # nothing, and making it a variable would be a third thing to configure.',
		`          role-to-assume: \${{ vars.${ROLE_VARIABLE} }}`,
		`          aws-region: ${options.region}`,
		'',
		'      # The gate on content, and the only one. `buildBundle` always produces a bundle,',
		"      # even when the lint has errors, because refusing to publish is the publisher's",
		"      # job rather than the compiler's; the refusal is this step's exit code, which is 3",
		'      # when the envelope carries an error, so a failing tree never reaches the step',
		'      # below.',
		'      #',
		'      # `--json` puts the answer on stdout and every human row on stderr, so the log',
		'      # still reads as a ladder and the directory handed to `publish` below is the one',
		'      # `build` says it wrote. That is not a convenience. `build` writes the bundle to',
		'      # <out>/<project>/<commit>/ast-N, so a workflow spelling that path out would carry',
		'      # an AST major frozen at the moment `hexdocs init` ran, in every app repository at',
		'      # once, and the next AST bump would break each of them with a message about a',
		'      # missing manifest rather than about the version. Reading it back is what keeps the',
		'      # layout declared in exactly one place.',
		'      - name: build the bundle',
		'        id: build',
		'        env:',
		'          BUILD_JSON: ${{ runner.temp }}/hexdocs-build.json',
		'        run: |',
		`          ${hexdocs} build --json --out ${options.out} > "$BUILD_JSON"`,
		'          node -p \'"prefix=" + require(process.env.BUILD_JSON).prefix\' >> "$GITHUB_OUTPUT"',
		'',
		'      # Write-once per key, enforced server side as well as here. A re-run on an',
		'      # unchanged commit writes nothing and exits 0; a re-run on a commit whose content',
		'      # changed refuses rather than overwriting, which is what makes a published bundle',
		'      # a thing you can quote a digest for.',
		'      #',
		'      # The step above exits 3 without reaching its second line if the bundle was not',
		'      # written, so the output read here is never absent or null.',
		'      - name: publish the bundle',
		'        env:',
		`          ${BUCKET_VARIABLE}: \${{ vars.${BUCKET_VARIABLE} }}`,
		`        run: ${hexdocs} publish "\${{ steps.build.outputs.prefix }}"`,
		'',
	];

	return lines.join('\n');
}
