/**
 * The half of `scripts/check-stack.mjs` that needs no account.
 *
 * That guard reads the applied bundle store back out of AWS, and every row it has is a call.
 * This is everything underneath those calls: the comparison of one policy document against
 * another, the redaction that keeps an estate identifier out of a problem line, the reading
 * of what a tool printed, and the reading of what the simulator answered.
 *
 * ## Why it is a library rather than a section of the guard
 *
 * The policy comparison is the one piece of that guard a bug can make silently wrong. Every
 * other failure is loud: a call that does not answer, a setting that reads false, a
 * simulation that comes back denied. A wrong comparison reports **no drift on a bucket
 * policy that has actually changed**, which is a green row over a store whose write-once
 * guarantee has gone. The bucket policy is the only control in the stack that binds the
 * account root user, and the documented recovery from a wrong one is a
 * `delete-bucket-policy`, the work, and a `put-bucket-policy` back, so the interrupted state
 * is one Terraform cannot see and this comparison is what does.
 *
 * It is also the only piece of that guard a suite with no AWS credentials can hold, which is
 * the second half of the same argument. Measured at the split: 120 statements here at 100%,
 * against 231 left in the guard at 13.4%. Averaged into one file those are a number that
 * describes neither, and the floor written under it would be a floor set by what cannot be
 * tested rather than by what is. Here it is held at a real number by `test/infra.test.ts`,
 * beside `report.mjs` and `scan-imports.mjs`, which are the two zero-dependency libraries this
 * directory already holds for the same reason.
 *
 * Nothing here spawns anything, reads a file or touches the clock. Zero dependencies, plain
 * `.mjs`, node 22, like everything else in `scripts/`.
 */

// ---------------------------------------------------------------------------
// What a tool printed
// ---------------------------------------------------------------------------

/**
 * Missing, expired or unusable credentials, from either tool.
 *
 * The first half is `kit/src/s3/client.ts`'s `NO_CREDENTIALS`, copied rather than
 * imported because a zero-dependency `.mjs` cannot read the TypeScript that declares it.
 * A copy is the wrong shape in general and is the right one here: the alternative is
 * importing the toolchain through tsx from a script whose whole job is to run before
 * anybody has installed anything.
 *
 * The second half is Terraform's, which signs with the AWS SDK for Go rather than with
 * botocore and therefore says something entirely different. There are two profile states to
 * cover, not one, and each tool spells both of them its own way. Measured on this machine
 * against the s3 backend:
 *
 *   no profile in scope        Terraform: "No valid credential sources found", and
 *                              "failed to refresh cached credentials".
 *                              botocore: "Unable to locate credentials".
 *   a profile named and not
 *   in the config file         Terraform: "failed to get shared config profile, <name>".
 *                              botocore: "The config profile (<name>) could not be found".
 *
 * The botocore half arrived with both states covered and the Terraform half arrived with
 * only the first, so the same operator error was SKIPPED when the AWS CLI met it and NOT RUN
 * when `terraform output` met it first, which fails. Without the first Terraform spelling the
 * commonest state on a developer's laptop reports NOT RUN when the honest answer is that the
 * run never looked; without the second the same is true of a stale pin or a typo.
 *
 * The named-and-missing spelling is matched as a substring rather than anchored on the
 * profile name, which is also what catches the assume-role wrapping of it: "failed to load
 * assume role ..., of profile X, failed to get shared config profile, X".
 *
 * This is the predicate that decides SKIPPED against FAIL, so an ordinary AccessDenied must
 * not match it: a denial is the account answering, which is something to fix, and a run with
 * no profile has not looked. None of the Terraform spellings can appear in one, and the AWS
 * CLI prints none of them at all.
 */
export const NO_CREDENTIALS =
	/Unable to locate credentials|ExpiredToken|InvalidClientTokenId|SignatureDoesNotMatch|security token included in the request is (?:expired|invalid)|The SSO session|Error when retrieving token|The config profile \(.*\) could not be found|UnrecognizedClientException|No valid credential sources found|failed to refresh cached credentials|failed to get shared config profile|NoCredentialProviders/i;

/**
 * The decoration a tool's error output carries, derived from code points.
 *
 * Terraform draws its errors in a box and colours them, and the AWS CLI can be configured
 * to colour its own. Neither is readable inside a report row, and the box characters in
 * particular turn a one-line problem into five.
 *
 * The characters are declared as code points and the patterns are derived from them,
 * which is the trick `src/contracts/lint.ts` uses for the banned set, for the same reason
 * it uses it. An escape character written as itself is an invisible byte in a diff, and
 * this repository has already had one of those sit unnoticed in the one file where a
 * reviewer most needed to read the characters literally.
 */
const ESCAPE_SEQUENCE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, 'g');
const BOX_DRAWING = new RegExp(
	`^[${[0x2502, 0x2577, 0x2575].map((point) => String.fromCodePoint(point)).join('')}]\\s?`,
);

/**
 * A tool's output with the decoration gone and the blank lines dropped.
 *
 * Exported for `test/infra.test.ts` rather than for `check-stack.mjs`, which never names it.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function cleanLines(text) {
	return String(text)
		.replace(ESCAPE_SEQUENCE, '')
		.split('\n')
		.map((line) => line.replace(BOX_DRAWING, '').trimEnd())
		.filter((line) => line.trim() !== '');
}

/**
 * The last few meaningful lines of a tool's output, as one line.
 *
 * @param {string} text
 * @param {number} [lines]
 */
export function tail(text, lines = 4) {
	return cleanLines(text).slice(-lines).join(' ');
}

/**
 * The line that says the credentials are missing, rather than the last line.
 *
 * Terraform prints its headline first and the underlying cause afterwards, so a plain tail
 * reports "operation error ec2imds: GetMetadata, request canceled" and drops the sentence
 * that names what is actually wrong. Measured on the machine this was written on, which is
 * also where the two Terraform spellings in `NO_CREDENTIALS` came from.
 *
 * @param {string} text
 */
export function credentialsReason(text) {
	return cleanLines(text).find((line) => NO_CREDENTIALS.test(line)) ?? tail(text, 2);
}

// ---------------------------------------------------------------------------
// Keeping the estate out of a problem line
// ---------------------------------------------------------------------------

/**
 * Replaces the estate's own identifiers with placeholders.
 *
 * Applied to every problem line, including the ones assembled out of an AWS error message
 * and the ones carrying a policy path, because both can quote a value back. Plain string
 * replacement rather than a pattern, so nothing has to be escaped and nothing can be
 * matched by accident.
 *
 * @param {{ label: string, value: unknown }[]} secrets
 * @returns {(text: unknown) => string}
 */
export function redactor(secrets) {
	const pairs = secrets
		.map((entry) => ({ label: entry.label, value: String(entry.value ?? '') }))
		.filter((entry) => entry.value.length > 3)
		.sort((a, b) => b.value.length - a.value.length);
	return (text) =>
		pairs.reduce((carried, entry) => carried.split(entry.value).join(entry.label), String(text));
}

/**
 * The two shapes an AWS identifier has, whatever this estate's values are.
 *
 * Declared as patterns and applied containing shape first. An ARN carries the account id
 * inside it, so taking the twelve digit run out first would leave the ARN's own shape behind
 * with a placeholder in the middle of it, which is the same trap the length sort in `redactor`
 * above exists to avoid.
 */
const ARN_SPAN = /arn:aws[0-9a-z-]*:[^\s"'`,;)\]}]*/g;
const ACCOUNT_ID = /\b\d{12}\b/g;

/**
 * The weaker, shape based sibling of `redactor`, for the lines that exist before it does.
 *
 * `check-stack.mjs` builds its redactor out of the stack's own outputs, so on the one path
 * where reading those outputs is what failed there is nothing to build it from. That path
 * prints terraform's own stderr, and with the s3 backend a state read that fails on anything
 * other than credentials quotes an identifier back: an authorisation denial names the calling
 * principal, and the account id is inside that ARN.
 *
 * So this knows no values and matches on shape instead. That is strictly weaker and it is
 * what is available there, which is why it is a second function rather than a widening of the
 * first: `redactor` names what it removes and can be asserted to have removed all of it, and
 * nothing about this one can be.
 *
 * What it cannot take out is a name, because a name has no shape. The state bucket is the one
 * that matters, and it is not reachable from here at all: `infra/versions.tf` keeps every
 * backend value out of this public repository, so the bucket holding the state is a string
 * `check-stack.mjs` never learns and neither kind of redaction can hold. That cost is stated
 * in `check-stack.mjs`'s header, where an operator reads it, rather than only here.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function scrubIdentifiers(text) {
	return String(text).replace(ARN_SPAN, '<arn>').replace(ACCOUNT_ID, '<account>');
}

// ---------------------------------------------------------------------------
// Comparing two policy documents
// ---------------------------------------------------------------------------

/**
 * Everything in a policy statement that can carry meaning, compared field by field.
 *
 * Exported for `test/infra.test.ts` rather than for `check-stack.mjs`: the suite cross-checks
 * it against the canonical form and against its own case table, in both directions.
 */
export const STATEMENT_FIELDS = [
	'Effect',
	'Action',
	'NotAction',
	'Resource',
	'NotResource',
	'Principal',
	'NotPrincipal',
	'Condition',
];

/**
 * A deterministic string for any JSON value, with object keys sorted.
 *
 * Exported for `test/infra.test.ts` rather than for `check-stack.mjs`, which never names it.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stable(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	const record = /** @type {Record<string, unknown>} */ (value);
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
		.join(',')}}`;
}

/**
 * A policy field that is either one string or a list of them, as a sorted list.
 *
 * Exported for `test/infra.test.ts` rather than for `check-stack.mjs`, which never names it.
 *
 * @param {unknown} value
 * @returns {string[] | null}
 */
export function asList(value) {
	if (value === undefined || value === null) return null;
	return (Array.isArray(value) ? value : [value]).map(String).sort();
}

/**
 * A principal, in the one spelling.
 *
 * `"Principal": "*"` and `"Principal": {"AWS": "*"}` are the same principal, and which
 * one comes back is a property of the service rather than of the policy. Comparing the
 * two literally would report drift on a bucket policy nobody has touched, which is the
 * worst kind of red row: it teaches an operator that this check cries wolf, and the next
 * real difference is the one they scroll past.
 *
 * Exported for `test/infra.test.ts` rather than for `check-stack.mjs`, which never names it.
 *
 * @param {unknown} value
 */
export function canonicalPrincipal(value) {
	if (value === undefined || value === null) return null;
	if (typeof value === 'string') return { AWS: [value] };
	/** @type {Record<string, string[] | null>} */
	const out = {};
	for (const [type, identifiers] of Object.entries(/** @type {object} */ (value))) {
		out[type] = asList(identifiers);
	}
	return out;
}

/**
 * A condition block, operator by operator and key by key, with values sorted.
 *
 * Exported for `test/infra.test.ts` rather than for `check-stack.mjs`, which never names it.
 *
 * @param {unknown} value
 */
export function canonicalCondition(value) {
	if (value === undefined || value === null) return null;
	/** @type {Record<string, Record<string, string[] | null>>} */
	const out = {};
	for (const [operator, keys] of Object.entries(/** @type {object} */ (value))) {
		/** @type {Record<string, string[] | null>} */
		const inner = {};
		for (const [key, raw] of Object.entries(/** @type {object} */ (keys ?? {}))) {
			inner[key] = asList(raw);
		}
		out[operator] = inner;
	}
	return out;
}

/**
 * A statement reduced to the one spelling of each field this comparison understands.
 *
 * Exported for `test/infra.test.ts` rather than for `check-stack.mjs`. A field dropped here is
 * silent: `diffStatement` reads the same name off both sides, so two `undefined`s compare
 * equal and the field stops being watched with every row still green. The suite cross-checks
 * the key set against `STATEMENT_FIELDS` in both directions for exactly that reason.
 *
 * @param {Record<string, any>} statement
 */
export function canonicalStatement(statement) {
	return {
		Effect: statement.Effect ?? null,
		Action: asList(statement.Action),
		NotAction: asList(statement.NotAction),
		Resource: asList(statement.Resource),
		NotResource: asList(statement.NotResource),
		Principal: canonicalPrincipal(statement.Principal),
		NotPrincipal: canonicalPrincipal(statement.NotPrincipal),
		Condition: canonicalCondition(statement.Condition),
	};
}

/**
 * Every `operator` and `key` pair a condition block carries, with its canonical values.
 *
 * Exported for `test/infra.test.ts` rather than for `check-stack.mjs`, which never names it.
 *
 * @param {ReturnType<typeof canonicalCondition>} condition
 * @returns {Map<string, string>}
 */
export function conditionPairs(condition) {
	/** @type {Map<string, string>} */
	const pairs = new Map();
	for (const [operator, keys] of Object.entries(condition ?? {})) {
		for (const [key, values] of Object.entries(keys))
			pairs.set(`${operator} ${key}`, stable(values));
	}
	return pairs;
}

/** @param {string[]} a @param {string[]} b */
const without = (a, b) => a.filter((entry) => !b.includes(entry));

/**
 * What differs between one applied statement and the one the stack renders.
 *
 * Field names are always reported; values are reported only where they cannot carry an
 * estate identifier. An action name and a condition operator name never can. A resource,
 * a principal and a condition value all can, so those are named and not printed, and the
 * operator reads the two documents side by side with the commands in `infra/README.md`.
 *
 * Exported for `test/infra.test.ts` rather than for `check-stack.mjs`, which never names it.
 *
 * @param {string} sid
 * @param {ReturnType<typeof canonicalStatement>} applied
 * @param {ReturnType<typeof canonicalStatement>} expected
 * @returns {string[]}
 */
export function diffStatement(sid, applied, expected) {
	/** @type {string[]} */
	const problems = [];
	for (const field of STATEMENT_FIELDS) {
		const here = /** @type {Record<string, unknown>} */ (applied)[field];
		const there = /** @type {Record<string, unknown>} */ (expected)[field];
		if (stable(here) === stable(there)) continue;

		if (field === 'Action') {
			const added = without(applied.Action ?? [], expected.Action ?? []);
			const removed = without(expected.Action ?? [], applied.Action ?? []);
			problems.push(
				`Statement "${sid}" on the bucket has a different action list. On the bucket and not in the stack: ${added.join(', ') || 'nothing'}. In the stack and not on the bucket: ${removed.join(', ') || 'nothing'}.`,
			);
			continue;
		}

		if (field === 'Condition') {
			const here_ = conditionPairs(applied.Condition);
			const there_ = conditionPairs(expected.Condition);
			const names = [...new Set([...here_.keys(), ...there_.keys()])].filter(
				(name) => here_.get(name) !== there_.get(name),
			);
			problems.push(
				`Statement "${sid}" on the bucket has a different condition. The operator and key pairs that differ: ${names.join(', ')}. A condition removed from a deny is the deny no longer firing.`,
			);
			continue;
		}

		problems.push(
			`Statement "${sid}" on the bucket differs from the stack in its ${field}. The values are not printed here because they carry the bucket name and the account id; compare them with the get-bucket-policy command in infra/README.md.`,
		);
	}
	return problems;
}

/**
 * The statements of a policy, whether it wrote one or a list.
 *
 * Exported for `test/infra.test.ts` rather than for `check-stack.mjs`, which never names it.
 *
 * @param {Record<string, any>} document
 * @returns {Record<string, any>[]}
 */
export function statementsOf(document) {
	const statements = document?.Statement;
	if (Array.isArray(statements)) return statements;
	if (statements !== undefined && statements !== null) return [statements];
	return [];
}

/**
 * The applied bucket policy against the one the stack renders, Sid for Sid.
 *
 * This is the single most valuable comparison in the script. The bucket policy is the only
 * control in the stack that binds the account root user, which is the identity this estate
 * deploys with, and the documented recovery from a wrong policy is to remove it and put it
 * back by hand. A run that stops in the middle of that leaves no diff for Terraform to
 * report, because Terraform is not what removed it.
 *
 * @param {string} appliedText
 * @param {string} expectedText
 * @returns {{ problems: string[], compared: number }}
 */
export function comparePolicy(appliedText, expectedText) {
	/** @type {string[]} */
	const problems = [];

	/** @type {Record<string, any>} */
	let applied;
	/** @type {Record<string, any>} */
	let expected;
	try {
		applied = JSON.parse(appliedText);
	} catch (error) {
		return {
			problems: [
				`The policy on the bucket is not JSON: ${error instanceof Error ? error.message : String(error)}`,
			],
			compared: 0,
		};
	}
	try {
		expected = JSON.parse(expectedText);
	} catch (error) {
		return {
			problems: [
				`The bucket_policy_json output is not JSON: ${error instanceof Error ? error.message : String(error)}`,
			],
			compared: 0,
		};
	}

	const appliedStatements = statementsOf(applied);
	const expectedStatements = statementsOf(expected);
	/** @param {Record<string, any>} statement @param {number} index */
	const sidOf = (statement, index) =>
		typeof statement?.Sid === 'string' && statement.Sid !== ''
			? statement.Sid
			: `(statement ${index + 1}, which carries no Sid)`;

	const appliedSids = appliedStatements.map(sidOf);
	const expectedSids = expectedStatements.map(sidOf);

	if (new Set(appliedSids).size !== appliedSids.length) {
		problems.push(
			'The policy on the bucket carries the same Sid twice, so no statement can be matched to the stack by name.',
		);
		return { problems, compared: expectedStatements.length };
	}

	for (const sid of without(expectedSids, appliedSids)) {
		problems.push(
			`Statement "${sid}" is in the stack and is not on the bucket. It binds nothing until it is put back, and the account root user is what it binds.`,
		);
	}
	for (const sid of without(appliedSids, expectedSids)) {
		problems.push(
			`Statement "${sid}" is on the bucket and is not in the stack, so it was added outside Terraform and nothing here reviewed it.`,
		);
	}

	if (problems.length === 0 && appliedSids.join('\n') !== expectedSids.join('\n')) {
		problems.push(
			`The bucket carries all ${expectedSids.length} statements in a different order (${appliedSids.join(', ')}). IAM evaluates a deny wherever it sits, so this changes nothing about access, and it does mean the document was written by something other than this stack.`,
		);
	}

	for (const [index, sid] of expectedSids.entries()) {
		const at = appliedSids.indexOf(sid);
		if (at === -1) continue;
		problems.push(
			...diffStatement(
				sid,
				canonicalStatement(appliedStatements[at]),
				canonicalStatement(expectedStatements[index]),
			),
		);
	}

	return { problems, compared: expectedStatements.length };
}

// ---------------------------------------------------------------------------
// The two strings the credentialled rows exchange with AWS
// ---------------------------------------------------------------------------

/**
 * A location inside a policy document, as a path a reader can find.
 *
 * @param {any[]} path
 */
export function formatPath(path) {
	let out = '';
	for (const element of path ?? []) {
		if (typeof element?.key === 'string') out += out === '' ? element.key : `.${element.key}`;
		else if (typeof element?.index === 'number') out += `[${element.index}]`;
		else if (typeof element?.value === 'string') out += `.${element.value}`;
		else if (element?.substring !== undefined) out += '[substring]';
	}
	return out === '' ? '(the whole document)' : out;
}

/**
 * The context keys every simulation supplies.
 *
 * Two of them are the difference between a red row and a true one, and `s3:if-none-match`
 * is the sharper of the two. Both the bucket policy and the publisher's own policy
 * condition on it, in opposite directions: the bucket denies a put that carries no
 * If-None-Match header, and the role allows a put only when it does. A simulation that
 * left it out would report a correct stack as denying its own publisher every write, and a
 * red row on a correct stack is the worst kind: it is read once, disbelieved, and then
 * ignored on the day it is right.
 *
 * `s3:prefix` is the same trap on the listing grant, whose whole condition is that the
 * prefix belongs to this publisher. Omit it and `s3:ListBucket` simulates as denied
 * against a policy that allows it.
 *
 * `aws:SecureTransport` and `aws:PrincipalIsAWSService` are the bucket policy's transport
 * deny. They are supplied so the answer does not depend on what the simulator assumes an
 * absent key means, and `s3:ObjectCreationOperation` is the second half of the write-once
 * deny for the same reason. All five are keys the two policies actually name, so a key
 * turning up in `MissingContextValues` means a condition this row does not model has been
 * added, which is worth failing on.
 *
 * @param {string} prefix
 */
export function contextEntries(prefix) {
	return JSON.stringify([
		{
			ContextKeyName: 'aws:SecureTransport',
			ContextKeyValues: ['true'],
			ContextKeyType: 'boolean',
		},
		{
			ContextKeyName: 'aws:PrincipalIsAWSService',
			ContextKeyValues: ['false'],
			ContextKeyType: 'boolean',
		},
		{ ContextKeyName: 's3:if-none-match', ContextKeyValues: ['*'], ContextKeyType: 'string' },
		{
			ContextKeyName: 's3:ObjectCreationOperation',
			ContextKeyValues: ['true'],
			ContextKeyType: 'boolean',
		},
		{ ContextKeyName: 's3:prefix', ContextKeyValues: [prefix], ContextKeyType: 'string' },
	]);
}

// ---------------------------------------------------------------------------
// What the simulator answered
// ---------------------------------------------------------------------------

/**
 * The `SourcePolicyType` the simulator writes against a statement of the principal's own
 * policies, as against `Resource Policy` for one that came from the document passed with
 * `--resource-policy`.
 *
 * Measured against this account on 2026-09-09, and it has to be measured, because the model is
 * wrong about it: `PolicySourceType` in the local `iam/2010-05-08/service-2.json` is an enum of
 * seven lowercase values, `user`, `group`, `role`, `aws-managed`, `user-managed`, `resource`
 * and `none`, and the API returns none of them.
 *
 * If AWS ever brings the two into line, the deletion claim in `check-stack.mjs` reddens on a
 * correct stack. That is why its problem line names the sources it did get: the row then reads
 * as a vocabulary that moved rather than as a role that lost its deny.
 */
export const IAM_POLICY_SOURCE = 'IAM Policy';

/**
 * One `simulate-principal-policy` answer, as a verdict per action and resource.
 *
 * The decision is read out of `ResourceSpecificResults` rather than out of the top-level
 * `EvalDecision`. IAM's own model says the top-level `EvalResourceName` is now an ARN
 * template such as `arn:${Partition}:s3:::${BucketName}/${KeyName}` rather than the resource
 * that was asked about, so a check reading the top level would be reporting one answer for
 * every resource in the call and would not notice which.
 *
 * A pair with no entry, and an entry whose decision is missing or empty, are both left out of
 * `decision` rather than defaulted. That is not tidiness. `check-stack.mjs` reports an absent
 * pair as "the simulator returned no decision", and its negative claims read anything that is
 * not `allowed` as a denial, so a decision defaulted to the empty string would satisfy a claim
 * that a write is refused with nothing having refused it. A broken simulation would look like
 * a proved boundary, which is the one thing this row must never do.
 *
 * `sources` is the document each matched statement came from, and it is here because a
 * decision does not say which document produced it. Two documents are evaluated together, both
 * of them deny object deletion, and the claim that the role's own policy still denies it is
 * green on the decision alone with that statement removed. It is always set for a pair the
 * answer carried, and it is empty for an implicit denial, which matches nothing by definition.
 *
 * @param {any} payload the parsed `simulate-principal-policy` response
 * @returns {{ decision: Map<string, string>, missing: Map<string, string[]>, sources: Map<string, string[]> }}
 */
export function readDecisions(payload) {
	/** @type {Map<string, string>} */
	const decision = new Map();
	/** @type {Map<string, string[]>} */
	const missing = new Map();
	/** @type {Map<string, string[]>} */
	const sources = new Map();
	for (const evaluation of payload?.EvaluationResults ?? []) {
		const action = String(evaluation?.EvalActionName ?? '');
		for (const specific of evaluation?.ResourceSpecificResults ?? []) {
			const at = `${action} ${String(specific?.EvalResourceName ?? '')}`;
			const verdict = specific?.EvalResourceDecision;
			if (typeof verdict === 'string' && verdict !== '') decision.set(at, verdict);
			const keys = specific?.MissingContextValues ?? [];
			if (keys.length > 0) missing.set(at, keys.map(String));
			sources.set(
				at,
				(specific?.MatchedStatements ?? []).map((statement) =>
					String(statement?.SourcePolicyType ?? ''),
				),
			);
		}
	}
	return { decision, missing, sources };
}
