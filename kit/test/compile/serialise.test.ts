import { gunzipSync, gzipSync } from 'node:zlib';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { GZIP_SETTINGS } from '../../../src/contracts/manifest.js';
import {
	canonicalJson,
	gunzipMember,
	gzipMember,
	sha256Hex,
	utf8Bytes,
} from '../../src/compile/serialise.js';

/**
 * The writer primitives, measured rather than described.
 *
 * Two things here are worth knowing before changing anything. The digest literals are
 * computed outside this repository, with `shasum -a 256`, so they check node's crypto
 * against a second implementation rather than against itself. And the three assertions
 * inside `gzipMember` are unreachable against a working zlib, so they are driven by
 * mocking `node:zlib` to return a member that breaks each one. Without that they would
 * be three guards nothing had ever run, which is the state this repository treats as a
 * failure rather than as a detail.
 */

// ---------------------------------------------------------------------------
// canonicalJson: key order
// ---------------------------------------------------------------------------

describe('key order, which two builders have to agree on', () => {
	test('keys are written in code unit order, not in the order they were assigned', () => {
		const written = canonicalJson({ zebra: 1, Zebra: 2, apple: 3, 'guide/first-tag': 4, é: 5 });
		expect(written).toBe('{"Zebra":2,"apple":3,"guide/first-tag":4,"zebra":1,"é":5}');
	});

	test('an integer-like key is moved, which is where the engine own order disagrees', () => {
		// `Object.keys` returns integer-index keys first, in ascending numeric order, whatever
		// order they were assigned in. A serialiser that trusted it would write "2" before
		// "10" while `validateManifestShape` sorts them the other way.
		const record = { '10': 1, '2': 2, x: 3 };
		expect(Object.keys(record)).toEqual(['2', '10', 'x']);
		expect(canonicalJson(record)).toBe('{"10":1,"2":2,"x":3}');
	});

	test('the comparison is not locale aware, which is what makes the sha the same everywhere', () => {
		// Measured on this runner rather than assumed: a locale-aware comparison sorts the
		// accented key next to its unaccented neighbour, and which answer a machine gives
		// depends on its ICU build. That is precisely the machine dependence being refused.
		const byLocale = ['a', 'ä', 'b'].sort((one, two) => one.localeCompare(two)).join(',');
		expect(byLocale).not.toBe('a,b,ä');
		expect(canonicalJson({ a: 1, ä: 2, b: 3 })).toBe('{"a":1,"b":3,"ä":2}');
	});

	test('the order is code unit order, not code point order, outside the basic plane', () => {
		// A supplementary character is a surrogate pair, and its first unit sorts below
		// U+FFFD while its code point sorts above it. Code point order would swap these two,
		// and then the writer and `validateManifestShape`, which sorts with the default
		// comparator, would disagree about which page wins a duplicate slug.
		expect(canonicalJson({ '\ufffd': 1, '\u{1f600}': 2 })).toBe('{"\u{1f600}":2,"\ufffd":1}');
	});

	test('the order equals the default sort the manifest validator checks with', () => {
		const keys = ['a', 'z', 'Z', '10', '2', '\u{1f600}', '\ufffd', 'é', 'guide/x', '_'];
		const record: Record<string, number> = {};
		for (const [index, key] of keys.entries()) record[key] = index;
		const expected = [...keys]
			.sort()
			.map((key) => `${JSON.stringify(key)}:${record[key]}`)
			.join(',');
		expect(canonicalJson(record)).toBe(`{${expected}}`);
		expect(keys.length).toBe(10);
	});

	test('every object is sorted, at every depth, and arrays keep their order', () => {
		expect(canonicalJson({ b: [3, { d: 4, c: 5 }], a: null })).toBe(
			'{"a":null,"b":[3,{"c":5,"d":4}]}',
		);
	});
});

// ---------------------------------------------------------------------------
// canonicalJson: the bytes
// ---------------------------------------------------------------------------

describe('the document the writer produces', () => {
	test('there is no whitespace anywhere', () => {
		const written = canonicalJson({ a: [1, 2], b: { c: true, d: false } });
		expect(written).toBe('{"a":[1,2],"b":{"c":true,"d":false}}');
		expect(written).not.toMatch(/\s/);
	});

	test.each([
		[null, 'null'],
		[true, 'true'],
		[false, 'false'],
		[0, '0'],
		[-0, '0'],
		[-7, '-7'],
		[1.5, '1.5'],
		[1e21, '1e+21'],
		[1e-7, '1e-7'],
		['x', '"x"'],
		[[], '[]'],
		[{}, '{}'],
	])('%p is written as %s', (value, expected) => {
		expect(canonicalJson(value)).toBe(expected);
	});

	test('a finite number is spelled exactly as JSON.stringify spells it', () => {
		// The two have to agree, because a page payload compiled here is compared against a
		// digest taken elsewhere by whatever reads it back.
		const numbers = [0, -0, 1, -1, 1.5, 1e21, 1e-7, 123456789012345678901234567890];
		for (const number of numbers) expect(canonicalJson(number)).toBe(JSON.stringify(number));
		expect(numbers.length).toBe(8);
	});

	test('non-ASCII is emitted literally, because the digest is over these bytes', () => {
		const written = canonicalJson({ title: '指南', note: 'café' });
		expect(written).toBe('{"note":"café","title":"指南"}');
		expect(written).not.toContain('\\u');
		expect(written).toContain('指南');
	});

	test('a lone surrogate is escaped, which is the one place an escape is mandatory', () => {
		// Unescaped it has no UTF-8 encoding, so the bytes the digest covers would carry a
		// replacement character and two different strings would hash the same.
		expect(canonicalJson('\ud800')).toBe('"\\ud800"');
		expect(utf8Bytes(canonicalJson('\ud800'))).toHaveLength(8);
	});

	test('quotes, backslashes and control characters are escaped as JSON requires', () => {
		expect(canonicalJson('a"b\\c\nd\u0007')).toBe('"a\\"b\\\\c\\nd\\u0007"');
	});

	test('a key is escaped the same way a string value is', () => {
		expect(canonicalJson({ 'a"b': 1 })).toBe('{"a\\"b":1}');
	});

	test('what comes out parses back to what went in', () => {
		const document = {
			manifest: 1,
			pages: { 'guide/first-tag': { locales: { en: { words: 12, headings: [] } } } },
			locales: ['en', 'ja'],
			redirects: {},
		};
		expect(JSON.parse(canonicalJson(document))).toEqual(document);
	});
});

// ---------------------------------------------------------------------------
// canonicalJson: absence
// ---------------------------------------------------------------------------

describe('undefined, the one absence that is not a refusal', () => {
	test('an object property set to undefined is dropped, which is optional-and-omitted', () => {
		expect(canonicalJson({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
	});

	test('an object of nothing but undefined properties is an empty object', () => {
		expect(canonicalJson({ a: undefined, b: undefined })).toBe('{}');
	});

	test('a dropped first property leaves no leading comma', () => {
		// The comma is written before each property after the first written one, not before
		// each property after the first key. Counting keys instead produces `{,"b":2}`.
		expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
	});

	test('a null property is kept, because null is a value and absence is not', () => {
		expect(canonicalJson({ since: null })).toBe('{"since":null}');
	});
});

// ---------------------------------------------------------------------------
// canonicalJson: the refusals
// ---------------------------------------------------------------------------

/** Something with a prototype of its own, to check what the refusal calls it. */
class PageRecordish {
	slug = 'index';
}

function selfReferentialObject(): unknown {
	const page: Record<string, unknown> = { slug: 'index' };
	page['parent'] = page;
	return { pages: { 'guide/first-tag': page } };
}

function selfReferentialArray(): unknown {
	const nav: unknown[] = [];
	nav.push(nav);
	return nav;
}

const REFUSED: ReadonlyArray<[string, () => unknown, RegExp]> = [
	['NaN in an object', () => ({ budget: Number.NaN }), /^\$\.budget is NaN, which JSON has no/],
	['Infinity in an array', () => ({ a: { b: [1, Infinity] } }), /^\$\.a\.b\[1\] is Infinity/],
	['minus Infinity', () => ({ ratio: -Infinity }), /^\$\.ratio is -Infinity/],
	[
		'undefined in an array',
		() => [undefined],
		/^\$\[0\] is undefined\. JSON\.stringify writes null/,
	],
	['a function in an array', () => [() => 1], /^\$\[0\] is function\. JSON\.stringify writes null/],
	[
		'a symbol in an array',
		() => [Symbol('nav')],
		/^\$\[0\] is symbol\. JSON\.stringify writes null/,
	],
	['a bigint in an object', () => ({ bytes: 1n }), /^\$\.bytes is a bigint/],
	['a bigint in an array', () => [1n], /^\$\[0\] is a bigint/],
	['undefined at the root', () => undefined, /^\$ is undefined, which has no JSON spelling/],
	['a function at the root', () => () => 1, /^\$ is function, which has no JSON spelling/],
	['a function in an object', () => ({ resolve: () => 1 }), /^\$\.resolve is function/],
	['a symbol in an object', () => ({ tag: Symbol('x') }), /^\$\.tag is symbol/],
	[
		'a cycle through a quoted key',
		selfReferentialObject,
		/^\$\.pages\["guide\/first-tag"\]\.parent points back/,
	],
	['a cycle in an array', selfReferentialArray, /^\$\[0\] points back at a value/],
	['a Date', () => ({ updatedAt: new Date(0) }), /^\$\.updatedAt is a Date, not a plain object/],
	['a Map', () => ({ locales: new Map() }), /^\$\.locales is a Map, not a plain object/],
	['a Uint8Array', () => ({ raw: new Uint8Array(1) }), /^\$\.raw is a Uint8Array, not a plain/],
	['a class instance', () => ({ page: new PageRecordish() }), /^\$\.page is a PageRecordish/],
	[
		'an object whose prototype is itself prototypeless',
		() => ({ odd: Object.create(Object.create(null)) as object }),
		/^\$\.odd is an object of no class/,
	],
];

describe('the refusals, each naming where it happened', () => {
	test.each(REFUSED)('%s is refused', (_label, build, pattern) => {
		expect(() => canonicalJson(build())).toThrow(pattern);
	});

	test('all nineteen refusals name a path, so none of them sends anyone looking', () => {
		let named = 0;
		for (const [, build] of REFUSED) {
			try {
				canonicalJson(build());
			} catch (error) {
				if ((error as Error).message.startsWith('$')) named += 1;
			}
		}
		expect(named).toBe(REFUSED.length);
		expect(REFUSED.length).toBe(19);
	});

	test('an object with a null prototype is a plain object and is written', () => {
		const bare = Object.create(null) as Record<string, number>;
		bare['b'] = 2;
		bare['a'] = 1;
		expect(canonicalJson(bare)).toBe('{"a":1,"b":2}');
	});

	test('the same object twice in one document is not a cycle', () => {
		// The check is against the ancestors of the value being written, not against
		// everything already seen. A shared asset record appearing under two pages is
		// ordinary, and a seen-set would refuse it.
		const shared = { sha256: 'a'.repeat(64) };
		expect(canonicalJson({ x: shared, y: shared })).toBe(
			`{"x":{"sha256":"${'a'.repeat(64)}"},"y":{"sha256":"${'a'.repeat(64)}"}}`,
		);
		const list = [1];
		expect(canonicalJson([list, list])).toBe('[[1],[1]]');
	});
});

// ---------------------------------------------------------------------------
// canonicalJson: determinism
// ---------------------------------------------------------------------------

describe('determinism, which is the whole reason this module exists', () => {
	test('the same value written twice is the same string', () => {
		const page = { title: 'Scanning a tag', words: 412, headings: [{ id: 'a', depth: 2 }] };
		expect(canonicalJson(page)).toBe(canonicalJson(page));
	});

	test('two records assembled in different orders write the same bytes and the same sha', () => {
		const one = { z: 1, a: { c: 3, b: 2 }, m: [{ y: 1, x: 2 }] };
		const two = { m: [{ x: 2, y: 1 }], a: { b: 2, c: 3 }, z: 1 };
		expect(canonicalJson(one)).toBe(canonicalJson(two));
		expect(sha256Hex(utf8Bytes(canonicalJson(one)))).toBe(sha256Hex(utf8Bytes(canonicalJson(two))));
	});
});

// ---------------------------------------------------------------------------
// sha256Hex and utf8Bytes
// ---------------------------------------------------------------------------

describe('the digest, against a second implementation', () => {
	// Computed with `shasum -a 256`, not with node, so this compares two implementations
	// rather than comparing node's crypto with itself.
	test.each([
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
		['café', '850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e'],
		['{"a":1}', '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862'],
	])('sha256 of %j is pinned', (text, digest) => {
		expect(sha256Hex(text)).toBe(digest);
	});

	test('the digest of a canonical document is the digest of its text', () => {
		expect(sha256Hex(canonicalJson({ a: 1 }))).toBe(
			'015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
		);
	});

	test('a string and its UTF-8 bytes hash identically, because one goes through the other', () => {
		for (const text of ['', 'abc', 'café', '指南']) {
			expect(sha256Hex(text)).toBe(sha256Hex(utf8Bytes(text)));
		}
	});

	test('the output is 64 lower-case hex characters, which is what the schemas accept', () => {
		expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
	});

	test('utf8Bytes encodes as UTF-8 and nothing else', () => {
		expect([...utf8Bytes('é')]).toEqual([0xc3, 0xa9]);
		expect(utf8Bytes('café')).toHaveLength(5);
		expect(utf8Bytes('')).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// The gzip member
// ---------------------------------------------------------------------------

const SAMPLE = utf8Bytes('a page of documentation, compressed twice\n'.repeat(64));

describe('the gzip member', () => {
	test('the same input compresses to the same bytes twice', () => {
		expect(gzipMember(SAMPLE).equals(gzipMember(SAMPLE))).toBe(true);
	});

	test('byte 9 is the OS the constant asks for, not the one the build host writes', () => {
		expect(gzipMember(SAMPLE)[9]).toBe(255);
		expect(gzipMember(SAMPLE)[9]).toBe(GZIP_SETTINGS.os);
	});

	test('the header carries no timestamp and no filename', () => {
		const member = gzipMember(SAMPLE);
		expect([...member.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
		expect(member.readUInt8(3) & 0b0000_1000).toBe(0);
	});

	test('the patched member still decompresses to its input', () => {
		expect(gunzipMember(gzipMember(SAMPLE)).equals(SAMPLE)).toBe(true);
		expect(gunzipSync(gzipMember(SAMPLE)).equals(SAMPLE)).toBe(true);
	});

	test('an empty payload is a member like any other', () => {
		const member = gzipMember(new Uint8Array(0));
		expect(member[9]).toBe(255);
		expect(gunzipMember(member)).toHaveLength(0);
	});

	test('the patch touches byte 9 and no other byte', () => {
		// The rest of the member is whatever zlib produced, which is what makes the patch a
		// normalisation rather than a re-encoding.
		const raw = gzipSync(SAMPLE, { level: GZIP_SETTINGS.level });
		const member = gzipMember(SAMPLE);
		expect(member).toHaveLength(raw.length);
		const differing = [...member].flatMap((byte, index) => (byte === raw[index] ? [] : [index]));
		expect(differing.every((index) => index === 9)).toBe(true);
		expect(member[9]).toBe(255);
	});

	test('spreading GZIP_SETTINGS into gzipSync produces the same bytes as level alone', () => {
		// The measurement the contract cites, and the reason this writer patches the header
		// by hand: node has no os or mtime option and ignores both in silence. If node ever
		// grows them, this fails and gzipMember is what needs rewriting.
		const spread = gzipSync(SAMPLE, GZIP_SETTINGS);
		const levelOnly = gzipSync(SAMPLE, { level: GZIP_SETTINGS.level });
		expect(spread.equals(levelOnly)).toBe(true);
		expect(spread[9]).not.toBe(GZIP_SETTINGS.os);
	});

	test('the level is the one option that reaches zlib, so it changes the payload', () => {
		expect(gzipMember(SAMPLE).equals(gzipSync(SAMPLE, { level: 1 }))).toBe(false);
	});

	test('gunzipMember reads a member this module did not write', () => {
		expect(gunzipMember(gzipSync(SAMPLE, { level: 6 })).equals(SAMPLE)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The three assertions inside gzipMember, driven by a zlib that breaks each one
// ---------------------------------------------------------------------------

/**
 * A member of something else entirely, used to break the round trip.
 *
 * Built here with the real zlib so that the tampered module returns a valid member whose
 * only fault is that it holds the wrong bytes. A corrupted member would throw inside
 * `gunzipSync` and prove nothing about the comparison that follows it.
 */
const DECOY = gzipSync(utf8Bytes('a different page entirely'), { level: 9 });

async function serialiserWithGzip(tamper: (member: Buffer) => Buffer) {
	vi.resetModules();
	vi.doMock('node:zlib', async () => {
		const actual = await vi.importActual<typeof import('node:zlib')>('node:zlib');
		return {
			...actual,
			gzipSync: (input: Uint8Array, options?: { level?: number }) =>
				tamper(Buffer.from(actual.gzipSync(input, options))),
		};
	});
	return import('../../src/compile/serialise.js');
}

afterEach(() => {
	vi.doUnmock('node:zlib');
	vi.resetModules();
});

describe('what gzipMember refuses to publish', () => {
	test('a member carrying a filename is refused, because its bytes name the build host', async () => {
		// Nothing here can remove an FNAME field once zlib has written one, so the honest
		// answer is to stop rather than to publish a member whose bytes depend on a path.
		const module = await serialiserWithGzip((member) => {
			const tampered = Buffer.from(member);
			tampered.writeUInt8(tampered.readUInt8(3) | 0b0000_1000, 3);
			return tampered;
		});
		expect(() => module.gzipMember(SAMPLE)).toThrow(/set the FNAME flag/);
		expect(() => module.gzipMember(SAMPLE)).toThrow(/GZIP_SETTINGS\.filename is null/);
	});

	test('a member carrying a timestamp is refused, because the clock is not an input', async () => {
		const module = await serialiserWithGzip((member) => {
			const tampered = Buffer.from(member);
			tampered.writeUInt32LE(1757218312, 4);
			return tampered;
		});
		expect(() => module.gzipMember(SAMPLE)).toThrow(/wrote MTIME 1757218312/);
	});

	test('a member that does not decompress to its input is refused', async () => {
		// The check that cannot be skipped: byte 9 is outside the CRC, so a member this
		// function had damaged would carry a valid checksum and would then be written to a
		// commit-addressed key nothing is allowed to overwrite.
		const module = await serialiserWithGzip(() => Buffer.from(DECOY));
		expect(() => module.gzipMember(SAMPLE)).toThrow(
			/does not decompress to the bytes it was built from \(25 bytes back, 2688 in\)/,
		);
	});
});
