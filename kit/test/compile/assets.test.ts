/**
 * What `probeAsset` reads out of a file, and what it refuses.
 *
 * Two halves. The corpus half reads the four fixture files, because they are the only
 * assets that are real: `display-p3.png` carries a genuine `cICP` chunk that `ffprobe
 * -show_entries stream=color_primaries` reports as `smpte432` while the published
 * `scan-screen.png` reports `unknown`, and `unsafe-diagram.svg` carries all five of the
 * things `asset-svg-unsafe` names. The synthetic half builds JPEG, WebP and AVIF byte
 * sequences by hand, because the corpus has none of those and every one of those
 * branches is a publish failure on the first screenshot somebody exports as a JPEG.
 *
 * Nothing here decodes an image. Every builder writes the header the reader claims to
 * read and nothing else, which is the point: a builder that produced a real file would
 * be testing the encoder that made it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
	probeAsset,
	readDimensions,
	sniffExtension,
	svgProblems,
} from '../../src/compile/assets.js';
import {
	FIXTURE_ASSETS,
	REJECTED_ASSETS,
	REJECTED_ROOT,
	SITE_ROOT,
} from '../../../fixtures/index.js';

// ---------------------------------------------------------------------------
// Reading and narrowing
// ---------------------------------------------------------------------------

type Probe = ReturnType<typeof probeAsset>;

function asset(probe: Probe) {
	if (!probe.ok) throw new Error(`expected a publishable asset, got: ${probe.message}`);
	return probe.asset;
}

function refusal(probe: Probe) {
	if (probe.ok) throw new Error('expected a refusal, got a publishable asset');
	return probe;
}

/** Read as the compiler will: `readFileSync` hands back a pooled Buffer at an offset. */
const fixture = (path: string): Uint8Array => readFileSync(join(SITE_ROOT, path));
const rejected = (path: string): Uint8Array => readFileSync(join(REJECTED_ROOT, path));

const text = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

// ---------------------------------------------------------------------------
// Byte builders
// ---------------------------------------------------------------------------

const ascii = (value: string): Uint8Array =>
	Uint8Array.from([...value].map((character) => character.charCodeAt(0)));

const utf16be = (value: string): Uint8Array => {
	const out = new Uint8Array(value.length * 2);
	for (let index = 0; index < value.length; index += 1) {
		out[index * 2] = value.charCodeAt(index) >> 8;
		out[index * 2 + 1] = value.charCodeAt(index) & 0xff;
	}
	return out;
};

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const zeros = (count: number): Uint8Array => new Uint8Array(count);
const be16 = (value: number): Uint8Array => bytes((value >> 8) & 0xff, value & 0xff);
const be32 = (value: number): Uint8Array =>
	bytes((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const le16 = (value: number): Uint8Array => bytes(value & 0xff, (value >> 8) & 0xff);
const le24 = (value: number): Uint8Array =>
	bytes(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff);
const le32 = (value: number): Uint8Array =>
	bytes(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);

const PNG_MAGIC = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/**
 * One PNG chunk.
 *
 * The four CRC bytes are zero. The reader does not check them, for the reason
 * `pngChunks` states, and the fixture PNGs on disk carry real ones: nothing in this
 * file asserts anything about a CRC.
 */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
	return concat(be32(data.length), ascii(type), data, zeros(4));
}

function png(width: number, height: number, extra: Uint8Array[] = []): Uint8Array {
	const ihdr = concat(be32(width), be32(height), bytes(8, 2, 0, 0, 0));
	return concat(
		PNG_MAGIC,
		pngChunk('IHDR', ihdr),
		...extra,
		pngChunk('IDAT', bytes(0x78, 0xda, 0x63, 0x00)),
		pngChunk('IEND', zeros(0)),
	);
}

const cicpChunk = (primaries: number): Uint8Array => pngChunk('cICP', bytes(primaries, 13, 0, 1));

/** A PNG `iCCP` chunk: the name, the terminator, the compression method, then the profile. */
const iccpChunk = (name: string): Uint8Array =>
	pngChunk('iCCP', concat(ascii(name), bytes(0), bytes(0), bytes(0x78, 0xda)));

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
	return concat(bytes(0xff, marker), be16(payload.length + 2), payload);
}

const EXIF_SEGMENT = jpegSegment(0xe1, concat(ascii('Exif'), bytes(0, 0), zeros(8)));

function sofSegment(marker: number, width: number, height: number): Uint8Array {
	return jpegSegment(marker, concat(bytes(8), be16(height), be16(width), bytes(1, 0x11, 0x00)));
}

function jpeg(...parts: Uint8Array[]): Uint8Array {
	return concat(bytes(0xff, 0xd8), ...parts, bytes(0xff, 0xda, 0x00, 0x02), bytes(0xff, 0xd9));
}

const appTwo = (profile: Uint8Array): Uint8Array =>
	jpegSegment(0xe2, concat(ascii('ICC_PROFILE'), bytes(0), bytes(1, 1), profile));

/**
 * An ICC profile: a 128 byte header, a tag table, and the tag data.
 *
 * Tag offsets are from the start of the profile, which is what makes the table worth
 * building rather than faking: an offset read as relative to the table instead would
 * still land inside the profile and would still decode to something.
 */
function iccProfile(
	tags: { signature: string; data: Uint8Array }[],
	count = tags.length,
): Uint8Array {
	const header = concat(zeros(36), ascii('acsp'), zeros(88));
	const tableSize = 4 + tags.length * 12;
	let at = 128 + tableSize;
	const table: Uint8Array[] = [be32(count)];
	const data: Uint8Array[] = [];
	for (const entry of tags) {
		table.push(concat(ascii(entry.signature), be32(at), be32(entry.data.length)));
		data.push(entry.data);
		at += entry.data.length;
	}
	return concat(header, ...table, ...data);
}

/** ICC v2 `textDescriptionType`: a count that includes the terminator, then the text. */
const descTag = (name: string): { signature: string; data: Uint8Array } => ({
	signature: 'desc',
	data: concat(ascii('desc'), zeros(4), be32(name.length + 1), ascii(name), bytes(0)),
});

/** ICC v4 `multiLocalizedUnicodeType`: one record, UTF-16BE, at an offset from the tag. */
const mlucTag = (name: string): { signature: string; data: Uint8Array } => ({
	signature: 'desc',
	data: concat(
		ascii('mluc'),
		zeros(4),
		be32(1),
		be32(12),
		ascii('enUS'),
		be32(name.length * 2),
		be32(28),
		utf16be(name),
	),
});

function riffChunk(id: string, data: Uint8Array): Uint8Array {
	const pad = data.length % 2 === 1 ? bytes(0) : zeros(0);
	return concat(ascii(id), le32(data.length), data, pad);
}

function webp(...chunks: Uint8Array[]): Uint8Array {
	const body = concat(ascii('WEBP'), ...chunks);
	return concat(ascii('RIFF'), le32(body.length), body);
}

/** A lossy frame: the three byte frame tag, the start code, then two 14 bit sizes. */
const vp8Chunk = (width: number, height: number): Uint8Array =>
	riffChunk(
		'VP8 ',
		concat(bytes(0x50, 0x00, 0x00), bytes(0x9d, 0x01, 0x2a), le16(width), le16(height)),
	);

const vp8lChunk = (width: number, height: number): Uint8Array =>
	riffChunk('VP8L', concat(bytes(0x2f), le32((width - 1) | ((height - 1) << 14))));

const vp8xChunk = (width: number, height: number): Uint8Array =>
	riffChunk('VP8X', concat(bytes(0x10, 0, 0, 0), le24(width - 1), le24(height - 1)));

function box(type: string, ...content: Uint8Array[]): Uint8Array {
	const body = concat(...content);
	return concat(be32(body.length + 8), ascii(type), body);
}

const ispeBox = (width: number, height: number): Uint8Array =>
	box('ispe', be32(0), be32(width), be32(height));

const nclxBox = (primaries: number): Uint8Array =>
	box('colr', ascii('nclx'), be16(primaries), be16(13), be16(0), bytes(0x80));

function avif(width: number, height: number, properties: Uint8Array[] = []): Uint8Array {
	const ipco = box('ipco', ispeBox(width, height), ...properties);
	// `hdlr` sits between `meta`'s full box header and `iprp` in every real file, so the
	// walk has a sibling to step over rather than finding what it wants first.
	const meta = box('meta', be32(0), box('hdlr', zeros(12)), box('iprp', ipco));
	return concat(box('ftyp', ascii('avif'), be32(0), ascii('avif'), ascii('mif1')), meta);
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

describe('the fixture assets', () => {
	test('every published fixture asset is publishable', () => {
		let swept = 0;
		for (const entry of FIXTURE_ASSETS) {
			const probe = probeAsset(fixture(entry.path), entry.path);
			expect(probe.ok, `${entry.path}: ${probe.ok ? '' : probe.message}`).toBe(true);
			swept += 1;
		}
		expect(swept).toBe(FIXTURE_ASSETS.length);
		expect(swept).toBe(2);
	});

	test('scan-screen.png is an untagged 160 by 200 raster', () => {
		const record = asset(probeAsset(fixture('assets/scan-screen.png'), 'assets/scan-screen.png'));
		expect(record).toEqual({
			ext: 'png',
			bytes: 421,
			width: 160,
			height: 200,
			colour: { space: 'srgb', probe: 'untagged' },
			lqip: null,
		});
	});

	test('nfc-glyph.svg is a vector asset sized from its own attributes', () => {
		const record = asset(probeAsset(fixture('assets/nfc-glyph.svg'), 'assets/nfc-glyph.svg'));
		expect(record.ext).toBe('svg');
		expect(record.colour).toEqual({ space: 'srgb', probe: 'vector' });
		expect({ width: record.width, height: record.height }).toEqual({ width: 24, height: 24 });
		expect(record.lqip).toBeNull();
	});

	test('every rejected fixture asset is refused under the rule it declares', () => {
		let swept = 0;
		for (const entry of REJECTED_ASSETS) {
			const probe = refusal(probeAsset(rejected(entry.path), entry.path));
			expect(probe.rule, entry.path).toBe(entry.rule);
			expect(probe.remediation).not.toBeNull();
			swept += 1;
		}
		expect(swept).toBe(REJECTED_ASSETS.length);
		expect(swept).toBe(2);
	});

	test('a Buffer at a non-zero byteOffset reads the same as a copy', () => {
		// readFileSync returns a pooled Buffer, so this is the ordinary case rather than an
		// exotic one: a DataView built from `bytes.buffer` alone reads the file before it.
		const pooled = fixture('assets/scan-screen.png');
		expect(probeAsset(new Uint8Array(pooled), 'copy.png')).toEqual({
			...probeAsset(pooled, 'copy.png'),
		});
		const shifted = new Uint8Array(pooled.length + 7);
		shifted.set(pooled, 7);
		expect(asset(probeAsset(shifted.subarray(7), 'shifted.png')).width).toBe(160);
	});
});

// ---------------------------------------------------------------------------
// Display P3
// ---------------------------------------------------------------------------

/** Where a chunk's data starts, found by an independent walk over the file. */
function findChunk(file: Uint8Array, type: string): { at: number; length: number } | undefined {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	let at = 8;
	while (at + 8 <= file.length) {
		const length = view.getUint32(at, false);
		const found = String.fromCharCode(...file.subarray(at + 4, at + 8));
		if (found === type) return { at: at + 8, length };
		at += 12 + length;
	}
	return undefined;
}

describe('display-p3.png', () => {
	const file = rejected('display-p3.png');

	test('the fixture really carries SMPTE 432 primaries in a cICP chunk', () => {
		// Verified against the file itself, not only against the reader:
		// `ffprobe -show_entries stream=color_primaries` reports smpte432 for this file and
		// unknown for the published scan-screen.png. ImageMagick reports sRGB for both.
		const chunk = findChunk(file, 'cICP');
		expect(chunk).toBeDefined();
		expect(chunk?.length).toBe(4);
		expect(file[chunk?.at ?? 0]).toBe(12);
		expect(findChunk(fixture('assets/scan-screen.png'), 'cICP')).toBeUndefined();
	});

	test('it is refused under asset-colour-space, naming the cicp probe', () => {
		const probe = refusal(probeAsset(file, 'assets/display-p3.png'));
		expect(probe.rule).toBe('asset-colour-space');
		expect(probe.message).toContain('"cicp"');
		expect(probe.message).toContain('SMPTE 432');
		expect(probe.message).toContain('Display P3');
	});

	test('the same file with BT.709 primaries passes, and reports the cicp probe', () => {
		// The one byte the refusal turns on. The CRC is left stale on purpose: the reader
		// does not check it, and patching it would test an implementation of CRC32 instead.
		const chunk = findChunk(file, 'cICP');
		const patched = new Uint8Array(file);
		patched[chunk?.at ?? 0] = 1;
		const record = asset(probeAsset(patched, 'assets/display-p3.png'));
		expect(record.colour).toEqual({ space: 'srgb', probe: 'cicp' });
		expect({ width: record.width, height: record.height }).toEqual({ width: 160, height: 200 });
	});

	test('the remediation carries the zscale conversion and the ImageMagick warning', () => {
		const probe = refusal(probeAsset(file, 'assets/display-p3.png'));
		const remediation = probe.remediation ?? '';
		expect(remediation).toContain(
			'format=gbrp,zscale=primariesin=smpte432:transferin=iec61966-2-1:matrixin=gbr:rangein=full:primaries=bt709:transfer=iec61966-2-1:matrix=gbr:range=full,format=rgb24',
		);
		expect(remediation).toContain('ffmpeg -i assets/display-p3.png');
		expect(remediation).toContain('assets/display-p3.srgb.png');
		expect(remediation).toContain('ImageMagick');
		expect(remediation).toContain('cannot read cICP');
		expect(remediation).toContain('ffprobe -show_entries stream=color_primaries');
	});

	test('a path with no extension still gets a runnable output name', () => {
		const probe = refusal(probeAsset(file, 'assets/screenshot'));
		expect(probe.remediation).toContain('assets/screenshot.srgb.png');
	});
});

// ---------------------------------------------------------------------------
// SVG safety
// ---------------------------------------------------------------------------

describe('svgProblems', () => {
	test('the unsafe fixture trips all five clauses', () => {
		// REJECTED_ASSETS says this file carries all five on purpose. Asserting only that it
		// was refused would pass with four of the five detectors broken.
		const problems = svgProblems(text(rejected('unsafe-diagram.svg')));
		expect(problems).toEqual([
			'a script element',
			'a foreignObject element',
			'an anchor with an href attribute',
			'an external href reference with the scheme "https:"',
			'an event attribute, "onload"',
		]);
		expect(problems).toHaveLength(5);
	});

	test('the unsafe fixture is refused under asset-svg-unsafe, naming every clause', () => {
		const probe = refusal(probeAsset(rejected('unsafe-diagram.svg'), 'unsafe-diagram.svg'));
		expect(probe.rule).toBe('asset-svg-unsafe');
		for (const clause of ['script element', 'foreignObject', 'anchor', 'external', 'event']) {
			expect(probe.message).toContain(clause);
		}
		expect(probe.remediation).toContain('same-origin');
	});

	test('the published glyph has no problems', () => {
		expect(svgProblems(text(fixture('assets/nfc-glyph.svg')))).toEqual([]);
	});

	test('a namespaced script element is still a script element', () => {
		expect(svgProblems('<svg><svg:script>x</svg:script></svg>')).toEqual(['a script element']);
	});

	test('an anchor with no href is not reported as an anchor', () => {
		expect(svgProblems('<svg><a><text>x</text></a></svg>')).toEqual([]);
	});

	test('an xlink:href with a scheme is an external reference', () => {
		expect(svgProblems('<svg><use xlink:href="https://example.com/a.svg#x" /></svg>')).toEqual([
			'an external href reference with the scheme "https:"',
		]);
	});

	test('a src attribute counts, in single quotes and unquoted', () => {
		expect(svgProblems("<svg><image src='ftp://example.com/a' /></svg>")).toEqual([
			'an external src reference with the scheme "ftp:"',
		]);
		expect(svgProblems('<svg><image src=ftp://example.com/a /></svg>')).toEqual([
			'an external src reference with the scheme "ftp:"',
		]);
	});

	test('a protocol-relative reference is external, leading whitespace included', () => {
		expect(svgProblems('<svg><image href="  //example.com/a.png" /></svg>')).toEqual([
			'an external href reference beginning with "//"',
		]);
	});

	test('a data URI is external, because it carries a scheme', () => {
		expect(svgProblems('<svg><image href="data:image/png;base64,AA" /></svg>')).toEqual([
			'an external href reference with the scheme "data:"',
		]);
	});

	test('a scheme spelled with character references is still a scheme', () => {
		// `&#106;avascript:` and `java&#9;script:` both resolve to a working scheme in a
		// browser, and a scan over the raw text sees neither.
		expect(svgProblems('<svg><a href="&#106;avascript:alert(1)">x</a></svg>')).toEqual([
			'an anchor with an href attribute',
			'an external href reference with the scheme "javascript:"',
		]);
		expect(svgProblems('<svg><image href="java&#9;script:alert(1)" /></svg>')).toEqual([
			'an external href reference with the scheme "javascript:"',
		]);
		expect(svgProblems('<svg><image href="&#X6A;avascript:alert(1)" /></svg>')).toEqual([
			'an external href reference with the scheme "javascript:"',
		]);
	});

	test('an unresolvable character reference decodes to nothing rather than throwing', () => {
		expect(svgProblems('<svg><image href="&#x110000;javascript:x" /></svg>')).toEqual([
			'an external href reference with the scheme "javascript:"',
		]);
	});

	test('same-document and relative references are not external', () => {
		expect(
			svgProblems(
				'<svg xmlns="http://www.w3.org/2000/svg"><use href="#tile" /><image href="tile.png" />' +
					'<image href="a&nbsp;b" /><image href="?a=1&amp;b=2" /></svg>',
			),
		).toEqual([]);
	});

	test('every on* attribute counts, whatever its case', () => {
		expect(svgProblems('<svg OnClick="x()"><rect /></svg>')).toEqual([
			'an event attribute, "onclick"',
		]);
	});

	test('only the first occurrence of a clause is reported', () => {
		const problems = svgProblems(
			'<svg><script /><script /><image href="https://a/1" /><image href="https://a/2" /></svg>',
		);
		expect(problems).toEqual([
			'a script element',
			'an external href reference with the scheme "https:"',
		]);
	});
});

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

describe('sniffExtension', () => {
	test('the corpus files sniff to their own formats', () => {
		expect(sniffExtension(fixture('assets/scan-screen.png'))).toBe('png');
		expect(sniffExtension(fixture('assets/nfc-glyph.svg'))).toBe('svg');
		expect(sniffExtension(rejected('display-p3.png'))).toBe('png');
		expect(sniffExtension(rejected('unsafe-diagram.svg'))).toBe('svg');
	});

	test('the filename is never consulted', () => {
		// A .png that is really a JPEG would be served as image/png by the static file
		// server the prefetch copies it into, and `jpeg` and `JPG` would give one file two
		// manifest keys.
		const record = asset(probeAsset(jpeg(EXIF_SEGMENT, sofSegment(0xc0, 8, 6)), 'shot.png'));
		expect(record.ext).toBe('jpg');
	});

	test('a JPEG is recognised whether it opens with JFIF, EXIF or a quantisation table', () => {
		for (const marker of [0xe0, 0xe1, 0xdb, 0xfe, 0xdd, 0xc0]) {
			expect(sniffExtension(bytes(0xff, 0xd8, 0xff, marker, 0x00, 0x10))).toBe('jpg');
		}
		expect(sniffExtension(bytes(0xff, 0xd8, 0xff, 0x00))).toBeUndefined();
		expect(sniffExtension(bytes(0xff, 0xd8, 0x00, 0xe0))).toBeUndefined();
		expect(sniffExtension(bytes(0xff, 0xd8, 0xff))).toBeUndefined();
	});

	test('a RIFF container that is not WebP is not an image', () => {
		expect(sniffExtension(concat(ascii('RIFF'), le32(4), ascii('WAVE')))).toBeUndefined();
	});

	test('an AVIF is recognised by a compatible brand as well as by its major brand', () => {
		expect(sniffExtension(avif(4, 4))).toBe('avif');
		const compatible = box('ftyp', ascii('mif1'), be32(0), ascii('mif1'), ascii('avif'));
		expect(sniffExtension(compatible)).toBe('avif');
		const sequence = box('ftyp', ascii('avis'), be32(0), ascii('avis'));
		expect(sniffExtension(sequence)).toBe('avif');
		const heic = box('ftyp', ascii('heic'), be32(0), ascii('mif1'), ascii('heic'));
		expect(sniffExtension(heic)).toBeUndefined();
	});

	test('an ftyp box declaring more than the file holds is bounded by the file', () => {
		const truncated = concat(
			be32(0x7fffffff),
			ascii('ftyp'),
			ascii('mif1'),
			be32(0),
			ascii('avif'),
		);
		expect(sniffExtension(truncated)).toBe('avif');
	});

	test('an SVG is recognised through a byte order mark, a declaration, a doctype and comments', () => {
		// The mark is built rather than typed, so this file stays plain ASCII. It reaches
		// the reader as the three bytes EF BB BF and TextDecoder removes it while decoding,
		// which is why nothing in the reader looks for one.
		const prologue =
			String.fromCharCode(0xfeff) +
			'<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n' +
			'<!-- a comment -->\n<svg width="4" height="4"></svg>';
		expect(sniffExtension(new TextEncoder().encode(prologue))).toBe('svg');
		expect(sniffExtension(ascii('<svg/>'))).toBe('svg');
	});

	test('an unterminated prologue is not an image', () => {
		expect(sniffExtension(ascii('<?xml version="1.0"'))).toBeUndefined();
		expect(sniffExtension(ascii('<!-- unterminated <svg>'))).toBeUndefined();
		expect(sniffExtension(ascii('<!DOCTYPE svg'))).toBeUndefined();
		expect(sniffExtension(ascii('<svgx />'))).toBeUndefined();
	});

	test('bytes that are no image at all are refused under asset-size', () => {
		expect(sniffExtension(zeros(0))).toBeUndefined();
		const probe = refusal(probeAsset(ascii('# A markdown file\n'), 'notes.png'));
		expect(probe.rule).toBe('asset-size');
		expect(probe.message).toContain('match none of PNG, JPEG, WebP, AVIF or SVG');
		expect(probe.remediation).toContain('The extension is not consulted');
	});
});

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

describe('readDimensions', () => {
	test('PNG comes from IHDR', () => {
		expect(readDimensions(png(1280, 720), 'png')).toEqual({ width: 1280, height: 720 });
	});

	test('JPEG walks the segments to the first frame header', () => {
		// A fill byte, a standalone marker, a Huffman table whose marker sits inside the
		// frame header range, and only then the frame header itself.
		const file = jpeg(
			EXIF_SEGMENT,
			bytes(0xff, 0xff),
			bytes(0xff, 0x01),
			jpegSegment(0xc4, zeros(20)),
			jpegSegment(0xdb, zeros(64)),
			sofSegment(0xc2, 4032, 3024),
		);
		expect(readDimensions(file, 'jpg')).toEqual({ width: 4032, height: 3024 });
	});

	test('every frame header marker in the range is read, and the three that are not are skipped', () => {
		for (const marker of [
			0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
		]) {
			expect(readDimensions(jpeg(sofSegment(marker, 12, 9)), 'jpg')).toEqual({
				width: 12,
				height: 9,
			});
		}
		for (const marker of [0xc4, 0xc8, 0xcc]) {
			expect(readDimensions(jpeg(sofSegment(marker, 12, 9)), 'jpg')).toBeUndefined();
		}
	});

	test('WebP is read from all three frame chunks', () => {
		expect(readDimensions(webp(vp8Chunk(640, 480)), 'webp')).toEqual({ width: 640, height: 480 });
		expect(readDimensions(webp(vp8lChunk(300, 200)), 'webp')).toEqual({ width: 300, height: 200 });
		expect(readDimensions(webp(vp8xChunk(1024, 768)), 'webp')).toEqual({
			width: 1024,
			height: 768,
		});
		// An extended file leads with VP8X and carries the frame after it.
		expect(readDimensions(webp(vp8xChunk(64, 32), vp8Chunk(64, 32)), 'webp')).toEqual({
			width: 64,
			height: 32,
		});
	});

	test('a WebP frame with the wrong signature is not guessed at', () => {
		const bad = riffChunk('VP8 ', concat(bytes(0x50, 0, 0), bytes(0, 0, 0), le16(8), le16(8)));
		expect(readDimensions(webp(bad), 'webp')).toBeUndefined();
		const badLossless = riffChunk('VP8L', concat(bytes(0x00), le32(0)));
		expect(readDimensions(webp(badLossless), 'webp')).toBeUndefined();
	});

	test('AVIF comes from the ispe box inside meta, iprp and ipco', () => {
		expect(readDimensions(avif(3024, 4032), 'avif')).toEqual({ width: 3024, height: 4032 });
	});

	test('an AVIF with no property container has no dimensions', () => {
		const noMeta = concat(
			box('ftyp', ascii('avif'), be32(0), ascii('avif')),
			box('mdat', zeros(8)),
		);
		expect(readDimensions(noMeta, 'avif')).toBeUndefined();
		const noIprp = concat(
			box('ftyp', ascii('avif'), be32(0), ascii('avif')),
			box('meta', be32(0), box('hdlr', zeros(12))),
		);
		expect(readDimensions(noIprp, 'avif')).toBeUndefined();
		const noIpco = concat(
			box('ftyp', ascii('avif'), be32(0), ascii('avif')),
			box('meta', be32(0), box('iprp', box('ipma', zeros(4)))),
		);
		expect(readDimensions(noIpco, 'avif')).toBeUndefined();
		const noIspe = concat(
			box('ftyp', ascii('avif'), be32(0), ascii('avif')),
			box('meta', be32(0), box('iprp', box('ipco', box('pixi', zeros(4))))),
		);
		expect(readDimensions(noIspe, 'avif')).toBeUndefined();
	});

	test('a box declaring an impossible size ends the walk instead of being followed', () => {
		const badSize = concat(
			box('ftyp', ascii('avif'), be32(0), ascii('avif')),
			concat(be32(4), ascii('meta')),
		);
		expect(readDimensions(badSize, 'avif')).toBeUndefined();
		const shortIspe = concat(
			box('ftyp', ascii('avif'), be32(0), ascii('avif')),
			box('meta', be32(0), box('iprp', box('ipco', box('ispe', be32(0))))),
		);
		expect(readDimensions(shortIspe, 'avif')).toBeUndefined();
	});

	test('SVG prefers its own attributes and falls back to the viewBox', () => {
		expect(readDimensions(ascii('<svg width="24px" height="18" />'), 'svg')).toEqual({
			width: 24,
			height: 18,
		});
		expect(readDimensions(ascii('<svg width="100%" viewBox="0 0 240 120" />'), 'svg')).toEqual({
			width: 240,
			height: 120,
		});
		// A fractional viewBox rounds, because the manifest carries integers.
		expect(readDimensions(ascii('<svg viewBox="0,0,240.6,120.4" />'), 'svg')).toEqual({
			width: 241,
			height: 120,
		});
	});

	test('an SVG with no usable size at all reads as nothing', () => {
		expect(readDimensions(ascii('<svg />'), 'svg')).toBeUndefined();
		expect(readDimensions(ascii('<svg viewBox="0 0 240" />'), 'svg')).toBeUndefined();
		expect(readDimensions(ascii('<svg viewBox="0 0 wide tall" />'), 'svg')).toBeUndefined();
		expect(
			readDimensions(ascii('<svg width="0" height="0" viewBox="0 0 0 0" />'), 'svg'),
		).toBeUndefined();
		expect(readDimensions(ascii('not an svg'), 'svg')).toBeUndefined();
	});

	test('a file sniffed as one format is not read as another', () => {
		expect(readDimensions(png(4, 4), 'jpg')).toBeUndefined();
		expect(readDimensions(png(4, 4), 'webp')).toBeUndefined();
		expect(readDimensions(png(4, 4), 'avif')).toBeUndefined();
	});
});

describe('truncated files', () => {
	test('each format is refused rather than throwing', () => {
		const cases: { name: string; bytes: Uint8Array; ext: string }[] = [
			{ name: 'shot.png', bytes: png(64, 64).subarray(0, 20), ext: 'PNG' },
			{ name: 'shot.jpg', bytes: jpeg(EXIF_SEGMENT).subarray(0, 12), ext: 'JPEG' },
			{ name: 'shot.webp', bytes: webp(vp8Chunk(8, 8)).subarray(0, 20), ext: 'WebP' },
			{ name: 'shot.avif', bytes: avif(8, 8).subarray(0, 40), ext: 'AVIF' },
			{ name: 'shot.svg', bytes: ascii('<svg width="10" height='), ext: 'SVG' },
		];
		let swept = 0;
		for (const entry of cases) {
			const probe = refusal(probeAsset(entry.bytes, entry.name));
			expect(probe.rule, entry.name).toBe('asset-size');
			expect(probe.message).toContain(`${entry.ext} header`);
			expect(probe.remediation).toContain('Re-export');
			swept += 1;
		}
		expect(swept).toBe(5);
	});

	test('a chunk declaring more than the file holds ends the walk', () => {
		const overlong = concat(
			PNG_MAGIC,
			pngChunk('IHDR', concat(be32(8), be32(8), bytes(8, 2, 0, 0, 0))),
			concat(be32(0x0fffffff), ascii('cICP'), bytes(12, 13, 0, 1), zeros(4)),
			pngChunk('IDAT', zeros(4)),
		);
		// The size is still readable, so the file passes with the colour tag unread. The
		// alternative is refusing a file whose header is intact over a chunk nothing reached.
		expect(asset(probeAsset(overlong, 'overlong.png')).colour.probe).toBe('untagged');
	});

	test('a JPEG segment claiming a length below its own header ends the walk', () => {
		const bad = concat(bytes(0xff, 0xd8), bytes(0xff, 0xe1), be16(1), zeros(8));
		expect(readDimensions(bad, 'jpg')).toBeUndefined();
	});

	test('a frame header too short to hold a size reads as nothing', () => {
		const short = concat(bytes(0xff, 0xd8), jpegSegment(0xc0, bytes(8, 0)), bytes(0xff, 0xd9));
		expect(readDimensions(short, 'jpg')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

describe('colour', () => {
	test('no tag at all is sRGB by web convention', () => {
		expect(asset(probeAsset(png(8, 8), 'a.png')).colour.probe).toBe('untagged');
		expect(asset(probeAsset(jpeg(sofSegment(0xc0, 8, 8)), 'a.jpg')).colour.probe).toBe('untagged');
		expect(asset(probeAsset(webp(vp8Chunk(8, 8)), 'a.webp')).colour.probe).toBe('untagged');
		expect(asset(probeAsset(avif(8, 8), 'a.avif')).colour.probe).toBe('untagged');
	});

	test('a cICP chunk naming BT.709 passes and a P3 one does not', () => {
		expect(asset(probeAsset(png(8, 8, [cicpChunk(1)]), 'a.png')).colour.probe).toBe('cicp');
		const probe = refusal(probeAsset(png(8, 8, [cicpChunk(12)]), 'a.png'));
		expect(probe.rule).toBe('asset-colour-space');
		expect(probe.message).toContain('SMPTE 432');
	});

	test('any other cICP value is refused by name, and the remediation says so', () => {
		const probe = refusal(probeAsset(png(8, 8, [cicpChunk(9)]), 'a.png'));
		expect(probe.message).toContain('colour primaries 9');
		expect(probe.remediation).toContain('Set primariesin to the zscale name');
	});

	test('a cICP chunk too short to read is refused rather than called untagged', () => {
		const short = png(8, 8, [pngChunk('cICP', bytes(12, 13))]);
		const probe = refusal(probeAsset(short, 'a.png'));
		expect(probe.rule).toBe('asset-colour-space');
		expect(probe.message).toContain('too short');
	});

	test('cICP wins over an embedded profile', () => {
		// A decoder that understands cICP applies it and ignores iCCP, so reading the
		// profile instead would answer a question the browser is not asking.
		const both = png(8, 8, [cicpChunk(1), iccpChunk('Display P3')]);
		expect(asset(probeAsset(both, 'a.png')).colour.probe).toBe('cicp');
	});

	test('a PNG iCCP chunk is read by name', () => {
		expect(asset(probeAsset(png(8, 8, [iccpChunk('sRGB IEC61966-2.1')]), 'a.png')).colour).toEqual({
			space: 'srgb',
			probe: 'iccp',
		});
		const probe = refusal(probeAsset(png(8, 8, [iccpChunk('Display P3')]), 'a.png'));
		expect(probe.message).toContain('"iccp"');
		expect(probe.message).toContain('Display P3');
	});

	test('a P3 profile name is recognised in the spellings that are in circulation', () => {
		for (const name of ['Display P3', 'display p3', 'DCI-P3', 'P3-D65']) {
			expect(refusal(probeAsset(png(8, 8, [iccpChunk(name)]), 'a.png')).rule).toBe(
				'asset-colour-space',
			);
		}
		for (const name of ['sRGB IEC61966-2.1', 'Generic RGB Profile', 'p3rofile']) {
			expect(asset(probeAsset(png(8, 8, [iccpChunk(name)]), 'a.png')).colour.probe).toBe('iccp');
		}
	});

	test('an iCCP name with no terminator is read to the end of the name field', () => {
		// A name field with no NUL in its first eighty bytes is a corrupt chunk. Reading it
		// to the field's end still answers the only question being asked of it, where
		// treating the chunk as absent would call the file sRGB by convention.
		const unterminated = pngChunk('iCCP', ascii(`Display P3 ${'x'.repeat(100)}`));
		const probe = refusal(probeAsset(png(8, 8, [unterminated]), 'a.png'));
		expect(probe.rule).toBe('asset-colour-space');
		expect(probe.message).toContain('Display P3');
	});

	test('a JPEG ICC profile is read from its description tag, in both ICC versions', () => {
		const v2 = jpeg(appTwo(iccProfile([descTag('Display P3')])), sofSegment(0xc0, 8, 8));
		expect(refusal(probeAsset(v2, 'a.jpg')).message).toContain('Display P3');
		const v4 = jpeg(appTwo(iccProfile([mlucTag('Display P3')])), sofSegment(0xc0, 8, 8));
		expect(refusal(probeAsset(v4, 'a.jpg')).message).toContain('Display P3');
		const srgb = jpeg(appTwo(iccProfile([descTag('sRGB IEC61966-2.1')])), sofSegment(0xc0, 8, 8));
		expect(asset(probeAsset(srgb, 'a.jpg')).colour.probe).toBe('iccp');
	});

	test('a profile whose description cannot be read falls back to its bytes', () => {
		// A tag table longer than the profile, a description tag of a type nothing here
		// reads, and a profile with no description at all: three ways to lose the name, and
		// the raw scan is what keeps a P3 file from passing as untagged.
		const overCounted = iccProfile([descTag('Display P3')], 99);
		expect(
			refusal(probeAsset(jpeg(appTwo(overCounted), sofSegment(0xc0, 8, 8)), 'a.jpg')).message,
		).toContain('description tag could not be read');

		const unknownType = iccProfile([
			{ signature: 'desc', data: concat(ascii('text'), zeros(4), ascii('Display P3'), bytes(0)) },
		]);
		expect(
			refusal(probeAsset(jpeg(appTwo(unknownType), sofSegment(0xc0, 8, 8)), 'a.jpg')).rule,
		).toBe('asset-colour-space');

		const noDesc = iccProfile([{ signature: 'wtpt', data: utf16be('Display P3') }]);
		expect(refusal(probeAsset(jpeg(appTwo(noDesc), sofSegment(0xc0, 8, 8)), 'a.jpg')).rule).toBe(
			'asset-colour-space',
		);

		const innocent = iccProfile([{ signature: 'wtpt', data: ascii('Generic RGB') }]);
		expect(
			asset(probeAsset(jpeg(appTwo(innocent), sofSegment(0xc0, 8, 8)), 'a.jpg')).colour.probe,
		).toBe('iccp');
	});

	test('a malformed description reads as unreadable rather than as a name', () => {
		const emptyDesc = iccProfile([
			{ signature: 'desc', data: concat(ascii('desc'), zeros(4), be32(0), zeros(4)) },
		]);
		expect(
			asset(probeAsset(jpeg(appTwo(emptyDesc), sofSegment(0xc0, 8, 8)), 'a.jpg')).colour.probe,
		).toBe('iccp');
		const emptyMluc = iccProfile([
			{ signature: 'desc', data: concat(ascii('mluc'), zeros(4), be32(0), zeros(20)) },
		]);
		expect(
			asset(probeAsset(jpeg(appTwo(emptyMluc), sofSegment(0xc0, 8, 8)), 'a.jpg')).colour.probe,
		).toBe('iccp');
		const runawayMluc = iccProfile([
			{
				signature: 'desc',
				data: concat(
					ascii('mluc'),
					zeros(4),
					be32(1),
					be32(12),
					ascii('enUS'),
					be32(4096),
					be32(28),
				),
			},
		]);
		expect(
			asset(probeAsset(jpeg(appTwo(runawayMluc), sofSegment(0xc0, 8, 8)), 'a.jpg')).colour.probe,
		).toBe('iccp');
		const shortTag = iccProfile([{ signature: 'desc', data: ascii('desc') }]);
		expect(
			asset(probeAsset(jpeg(appTwo(shortTag), sofSegment(0xc0, 8, 8)), 'a.jpg')).colour.probe,
		).toBe('iccp');
		const tiny = jpeg(appTwo(ascii('too short to be a profile')), sofSegment(0xc0, 8, 8));
		expect(asset(probeAsset(tiny, 'a.jpg')).colour.probe).toBe('iccp');
	});

	test('an APP2 segment that is not an ICC profile is not read as one', () => {
		const other = jpeg(jpegSegment(0xe2, ascii('FPXR something')), sofSegment(0xc0, 8, 8));
		expect(asset(probeAsset(other, 'a.jpg')).colour.probe).toBe('untagged');
	});

	test('a WebP ICCP chunk is read the same way a JPEG profile is', () => {
		const tagged = webp(riffChunk('ICCP', iccProfile([descTag('Display P3')])), vp8xChunk(8, 8));
		expect(refusal(probeAsset(tagged, 'a.webp')).message).toContain('"iccp"');
		const srgb = webp(riffChunk('ICCP', iccProfile([descTag('sRGB')])), vp8xChunk(8, 8));
		expect(asset(probeAsset(srgb, 'a.webp')).colour.probe).toBe('iccp');
	});

	test('an AVIF colr box answers with the probe its own contents name', () => {
		expect(asset(probeAsset(avif(8, 8, [nclxBox(1)]), 'a.avif')).colour.probe).toBe('cicp');
		expect(refusal(probeAsset(avif(8, 8, [nclxBox(12)]), 'a.avif')).message).toContain('"cicp"');

		const withProfile = avif(8, 8, [
			box('colr', ascii('prof'), iccProfile([descTag('Display P3')])),
		]);
		expect(refusal(probeAsset(withProfile, 'a.avif')).message).toContain('"iccp"');

		const restricted = avif(8, 8, [box('colr', ascii('rICC'), iccProfile([descTag('sRGB')]))]);
		expect(asset(probeAsset(restricted, 'a.avif')).colour.probe).toBe('iccp');

		const unknown = avif(8, 8, [box('colr', ascii('zzzz'), zeros(4))]);
		expect(asset(probeAsset(unknown, 'a.avif')).colour.probe).toBe('untagged');

		const shortNclx = avif(8, 8, [box('colr', ascii('nclx'), bytes(0))]);
		expect(asset(probeAsset(shortNclx, 'a.avif')).colour.probe).toBe('untagged');
	});

	test('an AVIF with no colr box is untagged', () => {
		// The property container is walked once for the size and once for the colour, so a
		// file that got as far as a colour reading always has one: this is the case where
		// the container is there and carries no colour property.
		expect(asset(probeAsset(avif(8, 8), 'a.avif')).colour.probe).toBe('untagged');
	});
});
