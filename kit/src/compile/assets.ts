/**
 * Reading an image asset's bytes, and deciding whether it may be published.
 *
 * Everything here reads the bytes. The path is carried only so a refusal can name the
 * file: what a file **is** comes from its magic numbers, never from its extension. The
 * consuming site serves these as static files and the extension is what the server
 * types them with, so a `.png` that is really a JPEG would go out as `image/png`. The
 * manifest has the second half of the same reason: the key is `assets/<sha256>.<ext>`,
 * so a non-canonical spelling (`jpeg`, `JPG`) gives one file two keys and defeats
 * write-once.
 *
 * Two refusals are the point of the module.
 *
 * **A Display P3 asset is refused, never converted.** Converting during the build would
 * make the same source file hash differently on a different runner, because ffmpeg
 * output varies by build and the content hash is the key: the same commit would publish
 * two different assets, and the write-once refusal would fire on a re-run that changed
 * nothing. Refusing puts the conversion in the author's hands, once, where the result
 * can be measured. The remediation carries the exact zscale filter, and the warning
 * that ImageMagick cannot read `cICP` at all: it reports the file as sRGB whatever the
 * tag says and silently no-ops a `-profile` conversion, so a file converted with it
 * comes back unchanged, still P3, and looking converted.
 *
 * **An SVG is read for what it can do, not only for how it draws.** Inside an `img`
 * element an SVG cannot run script, which is how the renderer uses it. But `hexdocs
 * prefetch` copies assets into the consuming site's `public/`, Vite copies that into
 * `build/client/`, and the result is a directly navigable same-origin URL. Navigated
 * to, the file is a document served as `image/svg+xml`, and any `script` element,
 * `foreignObject` or `on*` handler in it runs in the site's own origin.
 * `ASSET_EXTENSIONS` in `manifest.ts` states the same thing from the contract's side,
 * and `asset-svg-unsafe` is a protected rule, so no project can switch it off.
 *
 * What this module does not decide: the byte budget, which the caller applies from
 * `budgets.assetBytesMax` against the `bytes` reported here, and the LQIP placeholder,
 * which is `null` for the reason `ProbedAsset.lqip` gives.
 */

import type { AssetExtension, ColourProbe } from '../../../src/contracts/manifest.js';
import type { LintRuleId } from '../../../src/contracts/lint.js';
import type { AssetProbe } from './types.js';

// ---------------------------------------------------------------------------
// Byte readers
// ---------------------------------------------------------------------------

/**
 * `latin1` rather than `utf-8` for tags and profile names.
 *
 * Every fourcc, chunk type and ICC v2 description read here is one byte per character
 * by specification, and a UTF-8 decoder turns a stray high byte into U+FFFD, which
 * makes two different four byte tags compare equal.
 */
const LATIN1 = new TextDecoder('latin1');
const UTF8 = new TextDecoder('utf-8');
/** ICC v4 stores its description as UTF-16BE. */
const UTF16BE = new TextDecoder('utf-16be');

/** Built rather than written as an escape, so this file carries no control character. */
const NUL = String.fromCharCode(0);

/**
 * A `DataView` over the bytes, honouring the offsets.
 *
 * `readFileSync` returns a pooled `Buffer` whose `byteOffset` is routinely non-zero, so
 * a view constructed from `bytes.buffer` alone reads somebody else's file.
 */
function viewOf(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * ASCII from a byte range, clamped to the end of the file.
 *
 * A range running past the end yields a short string rather than a throw or an
 * `undefined`, which is what every caller wants: a truncated file's four byte tag
 * cannot equal any tag it is compared against, so the comparison answers correctly with
 * no separate length check at each call site.
 */
function tag(bytes: Uint8Array, at: number, length: number): string {
	return LATIN1.decode(bytes.subarray(at, at + length));
}

/** Whether a byte sequence sits at an offset. Signatures with high bytes are compared
 * numerically rather than decoded, because `latin1` is windows-1252 in a `TextDecoder`
 * and it does not map every byte to the code point of the same value. */
function matchesAt(bytes: Uint8Array, at: number, signature: readonly number[]): boolean {
	return signature.every((value, index) => bytes[at + index] === value);
}

interface Dimensions {
	width: number;
	height: number;
}

/**
 * Dimensions, or nothing when they are unusable.
 *
 * Rounds, because SVG lengths are fractional and the manifest's `width` and `height`
 * are integers; a raster header is already an integer and rounding it changes nothing.
 * A zero or negative size is refused rather than published: the renderer sets an
 * intrinsic size from these, and a zero one collapses the image and reflows the page.
 */
function usable(width: number, height: number): Dimensions | undefined {
	if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
	const rounded = { width: Math.round(width), height: Math.round(height) };
	if (rounded.width < 1 || rounded.height < 1) return undefined;
	return rounded;
}

// ---------------------------------------------------------------------------
// Format sniffing
// ---------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Markers a JPEG may carry immediately after SOI.
 *
 * A bare `FF D8` test calls any file that happens to start with those two bytes a JPEG.
 * A `FF D8 FF E0` test, which is what a JFIF-only sniffer does, refuses every
 * photograph a phone or a camera produced, because those start `FF D8 FF E1` with an
 * EXIF segment. So the third byte has to be a marker and the fourth has to open a
 * segment that legitimately comes first: any APPn, a quantisation table, a restart
 * interval, a comment, or a frame header in a file written with no application segment
 * at all.
 */
const JPEG_OPENING_MARKERS = new Set<number>([
	0xdb, // DQT
	0xdd, // DRI
	0xfe, // COM
]);
for (let marker = 0xc0; marker <= 0xcf; marker += 1) JPEG_OPENING_MARKERS.add(marker);
for (let marker = 0xe0; marker <= 0xef; marker += 1) JPEG_OPENING_MARKERS.add(marker);

function isJpeg(bytes: Uint8Array): boolean {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false;
	const marker = bytes[3];
	return marker !== undefined && JPEG_OPENING_MARKERS.has(marker);
}

function isRiffWebp(bytes: Uint8Array): boolean {
	return tag(bytes, 0, 4) === 'RIFF' && tag(bytes, 8, 4) === 'WEBP';
}

const AVIF_BRANDS = new Set(['avif', 'avis']);

/**
 * An `ftyp` box whose major brand, or one of whose compatible brands, is `avif` or
 * `avis`.
 *
 * The compatible brands matter: an encoder is free to write `mif1` as the major brand
 * and list `avif` behind it, and a sniffer reading only the major brand would call that
 * file unknown and refuse a perfectly ordinary AVIF.
 */
function isAvif(bytes: Uint8Array): boolean {
	if (tag(bytes, 4, 4) !== 'ftyp') return false;
	if (AVIF_BRANDS.has(tag(bytes, 8, 4))) return true;
	// The `ftyp` check above proves eight bytes exist, so this read cannot run off the
	// end. A declared size larger than the file is a truncated header, and the walk is
	// bounded by the file instead.
	const declared = viewOf(bytes).getUint32(0, false);
	const end = declared >= 16 && declared <= bytes.length ? declared : bytes.length;
	for (let at = 16; at + 4 <= end; at += 4) {
		if (AVIF_BRANDS.has(tag(bytes, at, 4))) return true;
	}
	return false;
}

function isSpace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** How much of a file is decoded when looking for an SVG root element. */
const SVG_PROLOGUE_BYTES = 1024;

/**
 * Where the `svg` root element starts, or -1.
 *
 * Only a prologue is skipped: whitespace, an XML declaration, a doctype and comments,
 * in any order and any number. A doctype carrying an internal subset with a `>` in it
 * ends the scan early and the file is refused as unrecognised, which is the direction to
 * be wrong in: the alternative is a scanner that hunts for `<svg` anywhere in a file and
 * calls a text document mentioning one an image.
 *
 * A byte order mark is not handled here because it never arrives: every caller decodes
 * with `TextDecoder`, which removes a leading UTF-8 BOM as it decodes. A file saved as
 * UTF-16 decodes to nothing that matches and is refused, which is the honest answer for
 * a spelling nothing in the estate produces.
 */
function svgRootIndex(head: string): number {
	let at = 0;
	for (;;) {
		while (isSpace(head.charCodeAt(at))) at += 1;
		if (head.startsWith('<?', at)) {
			const end = head.indexOf('?>', at);
			if (end === -1) return -1;
			at = end + 2;
			continue;
		}
		if (head.startsWith('<!--', at)) {
			const end = head.indexOf('-->', at);
			if (end === -1) return -1;
			at = end + 3;
			continue;
		}
		if (/^<!doctype/i.test(head.slice(at, at + 9))) {
			const end = head.indexOf('>', at);
			if (end === -1) return -1;
			at = end + 1;
			continue;
		}
		break;
	}
	return /^<svg[\s>/]/i.test(head.slice(at, at + 5)) ? at : -1;
}

function isSvg(bytes: Uint8Array): boolean {
	return svgRootIndex(UTF8.decode(bytes.subarray(0, SVG_PROLOGUE_BYTES))) !== -1;
}

/**
 * The format, from the bytes.
 *
 * `undefined` means the bytes match none of the five formats a bundle can carry, which
 * the caller turns into a refusal. It never means "fall back to the extension".
 */
export function sniffExtension(bytes: Uint8Array): AssetExtension | undefined {
	if (matchesAt(bytes, 0, PNG_MAGIC)) return 'png';
	if (isJpeg(bytes)) return 'jpg';
	if (isRiffWebp(bytes)) return 'webp';
	if (isAvif(bytes)) return 'avif';
	if (isSvg(bytes)) return 'svg';
	return undefined;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

interface PngChunk {
	type: string;
	/** Offset of the chunk's data, past the length and type fields. */
	at: number;
	length: number;
}

/**
 * The chunks before the image data.
 *
 * The walk stops at `IDAT`. Every chunk this module reads is required to appear before
 * the image data, so walking a multi-megabyte `IDAT` sequence to reach `IEND` is work
 * with no answer at the end of it. CRCs are not checked: a corrupt chunk is a file the
 * browser refuses on its own, and a CRC failure here would need a refusal the manifest
 * has no way to describe.
 */
function pngChunks(bytes: Uint8Array): PngChunk[] {
	const view = viewOf(bytes);
	const chunks: PngChunk[] = [];
	let at = 8;
	while (at + 8 <= bytes.length) {
		const length = view.getUint32(at, false);
		const type = tag(bytes, at + 4, 4);
		const data = at + 8;
		if (data + length > bytes.length) break;
		chunks.push({ type, at: data, length });
		if (type === 'IDAT' || type === 'IEND') break;
		// Four more for the CRC that follows the data.
		at = data + length + 4;
	}
	return chunks;
}

/** `IHDR` is required to be the first chunk, so its position is fixed rather than searched. */
function pngDimensions(bytes: Uint8Array): Dimensions | undefined {
	if (tag(bytes, 12, 4) !== 'IHDR' || bytes.length < 24) return undefined;
	const view = viewOf(bytes);
	return usable(view.getUint32(16, false), view.getUint32(20, false));
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

interface JpegSegment {
	marker: number;
	/** Offset of the payload, past the marker and the length field. */
	at: number;
	/** Payload length, with the two length bytes already subtracted. */
	length: number;
}

/**
 * The marker segments, up to the first scan.
 *
 * Entropy coded data follows SOS and is not a sequence of segments, so the walk stops
 * there. Both things this module reads out of a JPEG, the frame header and the ICC
 * profile, are required to precede it.
 */
function jpegSegments(bytes: Uint8Array): JpegSegment[] {
	const view = viewOf(bytes);
	const segments: JpegSegment[] = [];
	let at = 2;
	while (at + 4 <= bytes.length) {
		if (view.getUint8(at) !== 0xff) break;
		const marker = view.getUint8(at + 1);
		// A run of 0xFF bytes before a marker is legal padding, not a marker of its own.
		if (marker === 0xff) {
			at += 1;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) break;
		// TEM and the eight restart markers stand alone: no length, no payload.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2;
			continue;
		}
		const length = view.getUint16(at + 2, false);
		if (length < 2 || at + 2 + length > bytes.length) break;
		segments.push({ marker, at: at + 4, length: length - 2 });
		at += 2 + length;
	}
	return segments;
}

/**
 * Frame headers occupy 0xC0 to 0xCF, with three exceptions.
 *
 * DHT (0xC4), JPG (0xC8) and DAC (0xCC) sit inside that range and are not frame
 * headers. Reading a Huffman table as a frame header yields a plausible looking size
 * from the table's own bytes, which is worse than reading none: the page then reflows
 * around an intrinsic size belonging to nothing.
 */
function isFrameHeader(marker: number): boolean {
	return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegDimensions(bytes: Uint8Array): Dimensions | undefined {
	const view = viewOf(bytes);
	for (const segment of jpegSegments(bytes)) {
		if (!isFrameHeader(segment.marker)) continue;
		// Sample precision, then height, then width.
		if (segment.length < 5) return undefined;
		return usable(view.getUint16(segment.at + 3, false), view.getUint16(segment.at + 1, false));
	}
	return undefined;
}

/** `ICC_PROFILE` and the NUL that terminates it, as bytes. */
const ICC_MARKER_SIGNATURE = [
	0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00,
];

/**
 * The ICC profile out of the first APP2 marker carrying one.
 *
 * A profile larger than a marker segment is split across several APP2 segments,
 * numbered by the two bytes after the signature. Only the first is returned, because it
 * is the one holding the profile header and the tag table; a description that spilled
 * into the second segment is what the raw byte scan in `rawMentionsP3` covers.
 */
function jpegIccProfile(bytes: Uint8Array): Uint8Array | undefined {
	for (const segment of jpegSegments(bytes)) {
		if (segment.marker !== 0xe2) continue;
		if (!matchesAt(bytes, segment.at, ICC_MARKER_SIGNATURE)) continue;
		// Twelve signature bytes, then the chunk number and the chunk count.
		return bytes.subarray(segment.at + 14, segment.at + segment.length);
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

interface RiffChunk {
	id: string;
	at: number;
	length: number;
}

function riffChunks(bytes: Uint8Array): RiffChunk[] {
	const view = viewOf(bytes);
	const chunks: RiffChunk[] = [];
	let at = 12;
	while (at + 8 <= bytes.length) {
		const id = tag(bytes, at, 4);
		const length = view.getUint32(at + 4, true);
		const data = at + 8;
		if (data + length > bytes.length) break;
		chunks.push({ id, at: data, length });
		// Chunks are padded to an even length, and the pad byte is not counted in the size.
		at = data + length + (length % 2);
	}
	return chunks;
}

/** The three byte start code that follows a lossy frame tag. */
const VP8_START_CODE = [0x9d, 0x01, 0x2a];

/**
 * Dimensions from whichever of the three frame chunks the file carries.
 *
 * `VP8 ` is a lossy frame, `VP8L` a lossless one, and `VP8X` the extended header that
 * opens an animated, alpha or ICC-tagged file. All three occur in the wild and all
 * three spell the size differently, so a reader handling only the lossy one would
 * refuse every WebP with transparency.
 */
function webpDimensions(bytes: Uint8Array): Dimensions | undefined {
	const view = viewOf(bytes);
	for (const chunk of riffChunks(bytes)) {
		if (chunk.id === 'VP8 ' && chunk.length >= 10) {
			// Three byte frame tag, then the start code, then two 14 bit dimensions.
			if (!matchesAt(bytes, chunk.at + 3, VP8_START_CODE)) return undefined;
			return usable(
				view.getUint16(chunk.at + 6, true) & 0x3fff,
				view.getUint16(chunk.at + 8, true) & 0x3fff,
			);
		}
		if (chunk.id === 'VP8L' && chunk.length >= 5) {
			if (view.getUint8(chunk.at) !== 0x2f) return undefined;
			// Fourteen bits of width then fourteen of height, packed little endian, each
			// stored one less than the real value.
			const packed = view.getUint32(chunk.at + 1, true);
			return usable((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
		}
		if (chunk.id === 'VP8X' && chunk.length >= 10) {
			// Four flag bytes, then the canvas size as two 24 bit little endian values,
			// each stored one less than the real value.
			return usable(uint24le(view, chunk.at + 4) + 1, uint24le(view, chunk.at + 7) + 1);
		}
	}
	return undefined;
}

function uint24le(view: DataView, at: number): number {
	return view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
}

// ---------------------------------------------------------------------------
// AVIF
// ---------------------------------------------------------------------------

interface Box {
	/** Offset of the box's content, past the size and type fields. */
	content: number;
	end: number;
}

/**
 * The first box of a type among the siblings in a range.
 *
 * A box declaring size 0 (to the end of the file) or size 1 (a 64 bit largesize) ends
 * the walk rather than being followed. Neither spelling is legal for `meta`, `iprp`,
 * `ipco` or the property boxes inside them, which are the only boxes this reads, and a
 * walk guessing at a size it could not read would report an intrinsic size taken from
 * the wrong box instead of refusing.
 */
function findBox(bytes: Uint8Array, from: number, to: number, type: string): Box | undefined {
	const view = viewOf(bytes);
	let at = from;
	while (at + 8 <= to) {
		const size = view.getUint32(at, false);
		if (size < 8 || at + size > to) return undefined;
		if (tag(bytes, at + 4, 4) === type) return { content: at + 8, end: at + size };
		at += size;
	}
	return undefined;
}

/**
 * The item property container, which is where both the size and the colour live.
 *
 * Found by walking rather than by scanning for `ispe`, because a scan finds the same
 * four bytes wherever they occur inside compressed image data and answers with whatever
 * follows them.
 */
function avifProperties(bytes: Uint8Array): Box | undefined {
	const meta = findBox(bytes, 0, bytes.length, 'meta');
	if (meta === undefined) return undefined;
	// `meta` is a full box: one version byte and three flag bytes before its children.
	const iprp = findBox(bytes, meta.content + 4, meta.end, 'iprp');
	if (iprp === undefined) return undefined;
	return findBox(bytes, iprp.content, iprp.end, 'ipco');
}

/**
 * The first `ispe` in the property container.
 *
 * A file whose alpha or thumbnail property sorted ahead of the primary item's would
 * report that item's size, and resolving `pitm` and `ipma` is what would fix it. That is
 * not written here because the failure is a wrong intrinsic size on one image, nothing
 * in the corpus is AVIF at all, and the colour and safety refusals, which are what this
 * module exists for, do not depend on it.
 */
function avifDimensions(bytes: Uint8Array): Dimensions | undefined {
	const ipco = avifProperties(bytes);
	if (ipco === undefined) return undefined;
	const ispe = findBox(bytes, ipco.content, ipco.end, 'ispe');
	if (ispe === undefined || ispe.end - ispe.content < 12) return undefined;
	// `ispe` is a full box too: version and flags, then width and height.
	const view = viewOf(bytes);
	return usable(view.getUint32(ispe.content + 4, false), view.getUint32(ispe.content + 8, false));
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/**
 * An element's opening tag: its name, and everything up to the closing angle bracket.
 *
 * The attribute part steps over quoted values, so an angle bracket inside an attribute
 * does not end the tag early. This is a scanner, not an XML parser, and the ways it is
 * approximate all fail closed: a `script` element inside a comment or a CDATA section is
 * reported even though it would never run, and the answer to that is to delete a
 * commented out script nobody needed.
 */
const TAG_PATTERN = /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)/g;

const ATTRIBUTE_PATTERN =
	/([a-zA-Z_:][-a-zA-Z0-9:._]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

interface SvgAttribute {
	name: string;
	value: string;
}

interface SvgTag {
	/** Lower case, with any namespace prefix removed. */
	name: string;
	attributes: SvgAttribute[];
}

function attributesOf(source: string): SvgAttribute[] {
	const attributes: SvgAttribute[] = [];
	for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
		attributes.push({ name: match[1] ?? '', value: match[2] ?? match[3] ?? match[4] ?? '' });
	}
	return attributes;
}

function localName(name: string): string {
	const colon = name.indexOf(':');
	return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

function svgTags(source: string): SvgTag[] {
	const tags: SvgTag[] = [];
	for (const match of source.matchAll(TAG_PATTERN)) {
		tags.push({ name: localName(match[1] ?? ''), attributes: attributesOf(match[2] ?? '') });
	}
	return tags;
}

const NAMED_REFERENCES = new Map([
	['amp', '&'],
	['lt', '<'],
	['gt', '>'],
	['quot', '"'],
	['apos', "'"],
]);

function referencedCharacter(code: number): string {
	return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/**
 * Character references decoded, because an attribute value is not read literally.
 *
 * `&#106;avascript:` is a legal spelling of `javascript:` and a browser resolves it
 * before it looks at the scheme. A scan over the raw text sees a value with no scheme in
 * it and passes the file.
 */
function decodeCharacterReferences(value: string): string {
	return value.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (/^#[xX]/.test(body)) return referencedCharacter(Number.parseInt(body.slice(2), 16));
		if (body.startsWith('#')) return referencedCharacter(Number.parseInt(body.slice(1), 10));
		return NAMED_REFERENCES.get(body.toLowerCase()) ?? whole;
	});
}

/** Tab, newline and carriage return, which every browser strips out of a URL. */
const URL_STRIPPED = new RegExp(`[${String.fromCharCode(9, 10, 13)}]`, 'g');

/**
 * An attribute value as a browser resolves it before parsing it as a URL.
 *
 * Those three characters are removed rather than trimmed, so `java&#9;script:` is seen
 * as the scheme it is, and the trim stops leading whitespace hiding a protocol-relative
 * reference from a `startsWith` test.
 */
function normaliseReference(value: string): string {
	return decodeCharacterReferences(value).replace(URL_STRIPPED, '').trim();
}

const URL_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * What is unsafe about an SVG, one string per clause of `asset-svg-unsafe`.
 *
 * One per clause rather than one per occurrence, so a diagnostic names every kind of
 * problem the file has and an author fixes them in one pass instead of publishing five
 * times. An empty array means the file is publishable.
 *
 * The five clauses are the ones `ASSET_EXTENSIONS` names: a `script` element, a
 * `foreignObject`, an anchor with an `href`, an external reference, and any `on*` event
 * attribute. They matter because the prefetch turns this file into a directly navigable
 * same-origin document on the consuming site, where all five run or load.
 *
 * An external reference is a scheme or a leading `//` in an `href` or a `src`, which
 * catches `data:` along with the network schemes. That is stricter than the same-origin
 * argument needs, and it is the rule as stated; the cost is that an inlined raster has
 * to be unpacked into its own asset, and the alternative is a scheme allowlist that has
 * to be maintained against every scheme a browser learns.
 */
export function svgProblems(source: string): string[] {
	let script = false;
	let foreign = false;
	let anchor = false;
	let external: string | undefined;
	let handler: string | undefined;

	for (const element of svgTags(source)) {
		if (element.name === 'script') script = true;
		if (element.name === 'foreignobject') foreign = true;
		if (element.name === 'a' && element.attributes.some((one) => localName(one.name) === 'href')) {
			anchor = true;
		}

		for (const attribute of element.attributes) {
			const name = localName(attribute.name);
			if ((name === 'href' || name === 'src') && external === undefined) {
				const value = normaliseReference(attribute.value);
				const scheme = URL_SCHEME.exec(value);
				if (scheme !== null) {
					external = `an external ${name} reference with the scheme "${scheme[1] ?? ''}:"`;
				} else if (value.startsWith('//')) {
					external = `an external ${name} reference beginning with "//"`;
				}
			}
			if (handler === undefined && /^on[a-z]/i.test(attribute.name)) {
				handler = `an event attribute, "${attribute.name.toLowerCase()}"`;
			}
		}
	}

	const problems: string[] = [];
	if (script) problems.push('a script element');
	if (foreign) problems.push('a foreignObject element');
	if (anchor) problems.push('an anchor with an href attribute');
	if (external !== undefined) problems.push(external);
	if (handler !== undefined) problems.push(handler);
	return problems;
}

/**
 * The root element's attributes, exactly as written.
 *
 * Not lower cased, unlike the safety scan: XML is case sensitive and `viewBox` is the
 * only spelling a browser honours, so a reader accepting `viewbox` would publish an
 * intrinsic size the page will not have.
 */
function svgRootAttributes(source: string): SvgAttribute[] | undefined {
	const at = svgRootIndex(source);
	if (at === -1) return undefined;
	const match = /^<svg((?:[^>"']|"[^"]*"|'[^']*')*)/i.exec(source.slice(at));
	if (match === null) return undefined;
	return attributesOf(match[1] ?? '');
}

const SVG_LENGTH = /^\s*([+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+))\s*(?:px)?\s*$/i;

/**
 * A `width` or `height` attribute as a number of pixels.
 *
 * A percentage, an `em` or any other unit reads as nothing rather than as a number,
 * which sends the caller to the `viewBox`. `width="100%"` is the ordinary spelling for a
 * diagram meant to fill its container, and taking the 100 would put a hundred pixel
 * intrinsic size on a full width figure.
 */
function svgLength(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const match = SVG_LENGTH.exec(value);
	if (match === null) return undefined;
	return Number.parseFloat(match[1] ?? '');
}

function attribute(attributes: SvgAttribute[], name: string): string | undefined {
	return attributes.find((entry) => entry.name === name)?.value;
}

function svgDimensions(source: string): Dimensions | undefined {
	const attributes = svgRootAttributes(source);
	if (attributes === undefined) return undefined;
	const width = svgLength(attribute(attributes, 'width'));
	const height = svgLength(attribute(attributes, 'height'));
	if (width !== undefined && height !== undefined) return usable(width, height);

	const box = attribute(attributes, 'viewBox');
	if (box === undefined) return undefined;
	const parts = box.trim().split(/[\s,]+/);
	if (parts.length !== 4) return undefined;
	return usable(Number.parseFloat(parts[2] ?? ''), Number.parseFloat(parts[3] ?? ''));
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * The intrinsic size, or nothing when the header cannot be read.
 *
 * Both are required in an `AssetRecord`, so nothing is a publish error rather than a
 * default: the renderer has no image library to ask at runtime, and a page whose images
 * carry no intrinsic size reflows as each one loads.
 */
export function readDimensions(bytes: Uint8Array, ext: AssetExtension): Dimensions | undefined {
	switch (ext) {
		case 'png':
			return pngDimensions(bytes);
		case 'jpg':
			return jpegDimensions(bytes);
		case 'webp':
			return webpDimensions(bytes);
		case 'avif':
			return avifDimensions(bytes);
		case 'svg':
			return svgDimensions(UTF8.decode(bytes));
	}
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** CICP colour primaries 1: BT.709, which is what sRGB uses. */
const CICP_BT709 = 1;
/** CICP colour primaries 12: SMPTE EG 432-1, which is what Display P3 uses. */
const CICP_SMPTE432 = 12;

interface ColourProblem {
	reason: string;
	/**
	 * The zscale name for the file's own primaries, when it is known.
	 *
	 * Null means the remediation cannot fill `primariesin` in and has to say so. A
	 * conversion run with the wrong input primaries is not a refusal the author sees; it
	 * is a file that comes back the wrong colour and passes.
	 */
	input: string | null;
}

interface ColourReading {
	probe: ColourProbe;
	/** Null when the file may be published as sRGB. */
	problem: ColourProblem | null;
}

function fromCicp(primaries: number, source: string): ColourReading {
	if (primaries === CICP_BT709) return { probe: 'cicp', problem: null };
	if (primaries === CICP_SMPTE432) {
		return {
			probe: 'cicp',
			problem: {
				reason: `declares SMPTE 432 primaries in ${source}, which is Display P3`,
				input: 'smpte432',
			},
		};
	}
	return {
		probe: 'cicp',
		problem: {
			reason: `declares colour primaries ${primaries} in ${source}, which is not BT.709 and cannot be published as sRGB`,
			input: null,
		},
	};
}

/**
 * Profile names meaning Display P3.
 *
 * Matched on the name rather than on the profile's own colorant tags, which would mean
 * inverting a matrix to recover the primaries. The names in circulation are "Display
 * P3", "DCI-P3" and "P3-D65", and every one of them says P3 as a word.
 */
const P3_PROFILE_NAME = /display\s*p3|(?:^|[^a-z0-9])p3(?:[^a-z0-9]|$)/i;

function fromProfileName(name: string, source: string): ColourReading {
	if (!P3_PROFILE_NAME.test(name)) return { probe: 'iccp', problem: null };
	return {
		probe: 'iccp',
		problem: {
			reason: `carries an ICC profile in ${source} named "${name.slice(0, 60)}"`,
			input: 'smpte432',
		},
	};
}

/**
 * The profile description, from the tag table.
 *
 * Both spellings are read because both are in service: `desc` is the ICC v2 form every
 * screenshot pipeline still writes, and `mluc` is the v4 one.
 */
function describedText(profile: Uint8Array, at: number, size: number): string | undefined {
	const view = viewOf(profile);
	const type = tag(profile, at, 4);
	if (type === 'desc') {
		// Type and reserved, then an ASCII count that includes the terminator.
		const count = view.getUint32(at + 8, false);
		if (count < 2 || 12 + count > size) return undefined;
		return LATIN1.decode(profile.subarray(at + 12, at + 12 + count - 1));
	}
	if (type === 'mluc') {
		if (size < 28 || view.getUint32(at + 8, false) === 0) return undefined;
		// The first record is enough: a profile whose English name says P3 and whose
		// French name does not is not a thing that happens.
		const length = view.getUint32(at + 20, false);
		const offset = view.getUint32(at + 24, false);
		if (at + offset + length > profile.length) return undefined;
		return UTF16BE.decode(profile.subarray(at + offset, at + offset + length));
	}
	return undefined;
}

function iccProfileName(profile: Uint8Array): string | undefined {
	if (profile.length < 132) return undefined;
	const view = viewOf(profile);
	const count = view.getUint32(128, false);
	// A tag table longer than the profile is a corrupt profile, not a large one.
	if (count > (profile.length - 132) / 12) return undefined;
	for (let index = 0; index < count; index += 1) {
		const entry = 132 + index * 12;
		if (tag(profile, entry, 4) !== 'desc') continue;
		const offset = view.getUint32(entry + 4, false);
		const size = view.getUint32(entry + 8, false);
		if (size < 12 || offset + size > profile.length) return undefined;
		return describedText(profile, offset, size);
	}
	return undefined;
}

/**
 * The last resort when a profile's description tag cannot be read.
 *
 * Scanned in both spellings a profile stores text in: a v4 profile holds its name as
 * UTF-16BE, so a Latin-1 scan alone sees `D`, a NUL, `i`, a NUL, and matches nothing.
 */
function rawMentionsP3(profile: Uint8Array): boolean {
	return (
		P3_PROFILE_NAME.test(LATIN1.decode(profile)) || P3_PROFILE_NAME.test(UTF16BE.decode(profile))
	);
}

function fromProfileBytes(profile: Uint8Array, source: string): ColourReading {
	const name = iccProfileName(profile);
	if (name !== undefined) return fromProfileName(name, source);
	if (!rawMentionsP3(profile)) return { probe: 'iccp', problem: null };
	return {
		probe: 'iccp',
		problem: {
			reason: `carries an ICC profile in ${source} whose bytes name P3 and whose description tag could not be read`,
			input: 'smpte432',
		},
	};
}

const UNTAGGED: ColourReading = { probe: 'untagged', problem: null };

/**
 * PNG colour, from `cICP` first and an embedded profile second.
 *
 * `cICP` wins when both are present, because that is the order a decoder applies them:
 * reading the profile instead would answer a question the browser is not asking. A
 * `cICP` chunk too short to read is refused rather than ignored, since falling through
 * to `untagged` would record "sRGB by web convention" about a file that tried to say
 * otherwise.
 */
function pngColour(bytes: Uint8Array): ColourReading {
	const chunks = pngChunks(bytes);
	const cicp = chunks.find((chunk) => chunk.type === 'cICP');
	if (cicp !== undefined) {
		if (cicp.length < 4) {
			return {
				probe: 'cicp',
				problem: { reason: 'carries a cICP chunk too short to read', input: null },
			};
		}
		return fromCicp(viewOf(bytes).getUint8(cicp.at), 'its PNG cICP chunk');
	}

	const iccp = chunks.find((chunk) => chunk.type === 'iCCP');
	if (iccp === undefined) return UNTAGGED;
	// The chunk opens with a NUL terminated profile name of at most 79 bytes, then the
	// compression method and the deflated profile, which is not read: the name carries
	// the answer, and inflating a profile to reach a description it already states is
	// work for the same result.
	const head = LATIN1.decode(bytes.subarray(iccp.at, iccp.at + Math.min(iccp.length, 80)));
	const end = head.indexOf(NUL);
	return fromProfileName(end === -1 ? head : head.slice(0, end), 'its PNG iCCP chunk');
}

function jpegColour(bytes: Uint8Array): ColourReading {
	const profile = jpegIccProfile(bytes);
	if (profile === undefined) return UNTAGGED;
	return fromProfileBytes(profile, 'its APP2 marker');
}

/**
 * WebP and AVIF colour.
 *
 * Neither format appears in the corpus and neither was named in the brief for this
 * module. They are read anyway, because the alternative is worse than silence: a probe
 * of `untagged` is a positive claim that the file is sRGB by web convention, and making
 * that claim about a P3 screenshot exported as WebP is the exact failure the `cICP`
 * reader exists to prevent. An AVIF `nclx` box carries the same CICP triple a PNG `cICP`
 * chunk does, so it answers with the same probe name.
 */
function webpColour(bytes: Uint8Array): ColourReading {
	const iccp = riffChunks(bytes).find((chunk) => chunk.id === 'ICCP');
	if (iccp === undefined) return UNTAGGED;
	return fromProfileBytes(bytes.subarray(iccp.at, iccp.at + iccp.length), 'its ICCP chunk');
}

function avifColour(bytes: Uint8Array): ColourReading {
	const ipco = avifProperties(bytes);
	if (ipco === undefined) return UNTAGGED;
	const colr = findBox(bytes, ipco.content, ipco.end, 'colr');
	if (colr === undefined) return UNTAGGED;
	const kind = tag(bytes, colr.content, 4);
	if (kind === 'nclx' && colr.end - colr.content >= 6) {
		return fromCicp(viewOf(bytes).getUint16(colr.content + 4, false), 'its AVIF colr box');
	}
	if (kind === 'rICC' || kind === 'prof') {
		return fromProfileBytes(bytes.subarray(colr.content + 4, colr.end), 'its AVIF colr box');
	}
	return UNTAGGED;
}

function readColour(bytes: Uint8Array, ext: AssetExtension): ColourReading {
	switch (ext) {
		case 'png':
			return pngColour(bytes);
		case 'jpg':
			return jpegColour(bytes);
		case 'webp':
			return webpColour(bytes);
		case 'avif':
			return avifColour(bytes);
		case 'svg':
			return { probe: 'vector', problem: null };
	}
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

const FORMAT_NAMES = {
	png: 'PNG',
	jpg: 'JPEG',
	webp: 'WebP',
	avif: 'AVIF',
	svg: 'SVG',
} as const satisfies Record<AssetExtension, string>;

function refuse(rule: LintRuleId, message: string, remediation: string): AssetProbe {
	return { ok: false, rule, message, remediation };
}

/** The same path with `.srgb` before its extension, which is where the conversion goes. */
function convertedPath(path: string): string {
	if (!/\.[^./]+$/.test(path)) return `${path}.srgb.png`;
	return path.replace(/\.[^./]+$/, (ext) => `.srgb${ext}`);
}

/**
 * How to convert, and what not to convert with.
 *
 * The filter is the one in the estate standard, measured there against an ICC
 * conversion at 0.011% RMSE. The ImageMagick warning is not a preference: it cannot read
 * `cICP` at all, reports `Colorspace: sRGB` for a P3 file, and no-ops a `-profile`
 * conversion without an error, so an author who reaches for it gets the same bytes back
 * and a second refusal they cannot explain.
 */
function colourRemediation(path: string, input: string | null): string {
	const filter =
		`format=gbrp,zscale=primariesin=${input ?? '<this file own primaries>'}` +
		':transferin=iec61966-2-1:matrixin=gbr:rangein=full' +
		':primaries=bt709:transfer=iec61966-2-1:matrix=gbr:range=full,format=rgb24';
	const note =
		input === null
			? ' Set primariesin to the zscale name for the primaries this file declares before running it.'
			: '';
	return (
		'Convert the file to sRGB once, by hand, and commit the result:\n' +
		`ffmpeg -i ${path} -vf "${filter}" ${convertedPath(path)}\n` +
		`Then replace the original with it.${note}\n` +
		'Do not use ImageMagick for this. It cannot read cICP at all, reports the file as ' +
		'sRGB whatever the tag says, and silently no-ops a -profile conversion, so the file ' +
		'comes back unchanged and looking converted. Check the result with ' +
		'ffprobe -show_entries stream=color_primaries: an sRGB file reads bt709 or unknown, ' +
		'and a Display P3 one reads smpte432.'
	);
}

const SVG_REMEDIATION =
	'Delete the constructs named above and commit the diagram again. Inline the artwork ' +
	'instead of referencing it, and drop the anchor: a link inside a diagram is not ' +
	'reachable through the img element the page renders it with anyway. This is refused ' +
	'even though an SVG inside an img element cannot run script, because hexdocs prefetch ' +
	"copies the file into the consuming site's public directory, Vite copies that into " +
	'build/client, and the result is a directly navigable same-origin URL where the file ' +
	"is a document and everything in it runs in the site's own origin.";

const DIMENSIONS_REMEDIATION =
	'Re-export the file with a tool that writes a complete header, or convert it to PNG, ' +
	'and check that the result opens in a browser. A truncated download and a file edited ' +
	'by hand are the two ways a header goes missing.';

const FORMAT_REMEDIATION =
	'Convert it to one of png, jpg, webp, avif or svg. The extension is not consulted: ' +
	'what a file is comes from its bytes, because that is what the static file server ' +
	'types it with once the prefetch has copied it into the site.';

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * Everything the manifest needs about one asset, or the reason it cannot be published.
 *
 * One refusal per file, in this order: what the file is, then whether a vector file can
 * run script, then the two facts an `AssetRecord` cannot be written without. An unsafe
 * SVG is refused before its dimensions are read because the answer does not change with
 * the geometry, and `AssetProbe` carries one refusal, so an order has to be chosen here
 * rather than a caller guessing which of several came back.
 *
 * `path` is used for nothing but the messages. Every decision is made from the bytes.
 */
export function probeAsset(bytes: Uint8Array, path: string): AssetProbe {
	const ext = sniffExtension(bytes);
	if (ext === undefined) {
		return refuse(
			'asset-size',
			`${path} is not an image a bundle can carry. Its bytes match none of PNG, JPEG, WebP, AVIF or SVG.`,
			FORMAT_REMEDIATION,
		);
	}

	if (ext === 'svg') {
		const problems = svgProblems(UTF8.decode(bytes));
		if (problems.length > 0) {
			return refuse(
				'asset-svg-unsafe',
				`${path} carries ${problems.join(', ')}. Published, this file is a same-origin document on the consuming site, not only an img source.`,
				SVG_REMEDIATION,
			);
		}
	}

	const size = readDimensions(bytes, ext);
	if (size === undefined) {
		return refuse(
			'asset-size',
			`The dimensions of ${path} could not be read from its ${FORMAT_NAMES[ext]} header. Both are required in the manifest, because the renderer sets an intrinsic size and has no image library to ask at runtime.`,
			DIMENSIONS_REMEDIATION,
		);
	}

	const colour = readColour(bytes, ext);
	if (colour.problem !== null) {
		return refuse(
			'asset-colour-space',
			`Colour probe "${colour.probe}": ${path} ${colour.problem.reason}. A published bundle is sRGB only, and a Display P3 asset is refused rather than converted at build time.`,
			colourRemediation(path, colour.problem.input),
		);
	}

	return {
		ok: true,
		asset: {
			ext,
			bytes: bytes.length,
			width: size.width,
			height: size.height,
			colour: { space: 'srgb', probe: colour.probe },
			lqip: null,
		},
	};
}
