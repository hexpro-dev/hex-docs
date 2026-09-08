/**
 * Type-level equality, and the diagnostics that make a failure readable.
 *
 * These exist for one job: the contracts are written twice, as TypeScript
 * interfaces in this half and as Zod schemas in `kit/`, and the two must not drift.
 * A plain `extends` check is not enough, because `{ a: string }` extends
 * `{ a: string; b?: number }` in one direction and a one-way check passes while a
 * field quietly disappears from the schema that validates the bundle.
 *
 * Nothing here emits a byte at runtime.
 */

/**
 * Invariant equality. Two types are `Exact` when each is assignable to the other
 * *and* their optionality and readonly modifiers agree, which the deferred-generic
 * trick below detects and a pair of `extends` checks does not.
 */
export type Exact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Constrains a type-level assertion to `true`. Used as
 * `type _check = Expect<AssertExact<A, B>>;`, which fails the typecheck at that line
 * when the two disagree.
 */
export type Expect<T extends true> = T;

/** Keys on the first side that the second does not have. */
export type OnlyInFirst<A, B> = Exclude<keyof A, keyof B>;

/** Shared keys whose value types are not invariantly equal. */
export type MismatchedKeys<A, B> = {
	[K in keyof A & keyof B]: Exact<A[K], B[K]> extends true ? never : K;
}[keyof A & keyof B];

/**
 * The sentences naming what moved, one per key, as a union.
 *
 * Template literals rather than an object or a named alias, and that is not cosmetic.
 * TypeScript prints an unresolved alias *by name*, so a `KeyDiff<A, B>` failure reads
 * "Type 'KeyDiff<{ ...whole type... }, VersionEntry>' does not satisfy the constraint
 * 'true'": it dumps both types and names neither offending key. Template literals
 * distribute over the key unions and are printed expanded, so the same failure reads
 * `'drift: "promotedAt" is only in the first type'`.
 */
type DriftMessages<A, B> =
	| `drift: "${OnlyInFirst<A, B> & string}" is only in the first type`
	| `drift: "${OnlyInFirst<B, A> & string}" is only in the second type`
	| `drift: "${MismatchedKeys<A, B> & string}" differs between the two`;

/**
 * What `AssertExact` reports when the two types differ in a way a key comparison
 * cannot name.
 *
 * That case is real and it used to pass silently. Every arm of `DriftMessages`
 * distributes over its key union, so when all three key unions are `never`, which is
 * what happens comparing two *unions* that share their key set, the whole type
 * collapses to `never`. `Expect<T extends true>` accepts `never`, because `never` is
 * assignable to everything, so the assertion compiled on types that genuinely
 * differed. Falling back to a literal keeps `Expect` failing.
 *
 * Seeing this message means reaching for `AssertExactUnion`, which compares whole
 * members instead of keys.
 */
type UnnameableDrift =
	'drift: the two types differ, but not in a way a key comparison can name. Use AssertExactUnion.';

/**
 * `true` when the two object types match exactly, otherwise a union of sentences
 * naming every key that moved. Wrap in `Expect<>` to turn it into a compile error.
 */
export type AssertExact<A, B> =
	Exact<A, B> extends true
		? true
		: [DriftMessages<A, B>] extends [never]
			? UnnameableDrift
			: DriftMessages<A, B>;

/**
 * The union form. `KeyDiff` is useless on a union, because `keyof (X | Y)` is only
 * the keys they share, so this reports whole members instead.
 */
export type AssertExactUnion<A, B> =
	Exact<A, B> extends true ? true : { onlyInFirst: Exclude<A, B>; onlyInSecond: Exclude<B, A> };

/**
 * `true` when a `readonly [...]` tuple's members are exactly the members of a string
 * union. This is what pins a runtime array to a compile-time union so a test can
 * iterate every case and its count moves when the union does.
 */
export type AssertCovers<Tuple extends readonly string[], Union extends string> =
	Exact<Tuple[number], Union> extends true
		? true
		: {
				missingFromArray: Exclude<Union, Tuple[number]>;
				notInUnion: Exclude<Tuple[number], Union>;
			};

/*
 * Assertions about the assertions.
 *
 * These compile only while the utilities above behave as documented, and they are the
 * only form of test a type-level tool can have: a runtime suite cannot observe a type
 * that quietly stopped failing.
 */

/** A real key difference is named. */
type _namesTheKey = Expect<
	Exact<
		AssertExact<{ a: string }, { a: string; b: number }>,
		'drift: "b" is only in the second type'
	>
>;

/** An optionality change is named, and is not mistaken for a matching type. */
type _namesOptionality = Expect<
	Exact<AssertExact<{ a?: string }, { a: string }>, 'drift: "a" differs between the two'>
>;

/**
 * Two unions that differ in a member, but share their key set and the types of every
 * shared key, do not collapse to `never`.
 *
 * `keyof` a union is the *intersection* of its members' keys, so here it is `'kind'`
 * on both sides, and `A['kind']` is `'a' | 'b'` on both sides too. All three key
 * unions are therefore empty even though the types plainly differ. Without the
 * fallback this whole type is `never`, `Expect<never>` compiles, and every union
 * assertion in the drift file passes on types that do not match.
 */
type _unionDoesNotCollapse = Expect<
	Exact<
		AssertExact<{ kind: 'a'; x: 1 } | { kind: 'b' }, { kind: 'a'; x: 2 } | { kind: 'b' }>,
		UnnameableDrift
	>
>;

/** Matching types still produce `true`, so the fallback did not break the happy path. */
type _matchIsTrue = Expect<Exact<AssertExact<{ a?: string }, { a?: string }>, true>>;

/** The union form names the members rather than the keys. */
type _unionFormNamesMembers = Expect<
	Exact<
		AssertExactUnion<{ kind: 'a' }, { kind: 'a' } | { kind: 'b' }>,
		{ onlyInFirst: never; onlyInSecond: { kind: 'b' } }
	>
>;
