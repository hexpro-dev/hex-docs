/**
 * An image's size on the node agrees with its size in the manifest.
 *
 * `renderImage` in `src/render/nodes.tsx` reserves space from the node's `width` and `height`
 * rather than from the manifest's asset record, because the node is what the renderer holds
 * and the manifest is not loaded per page. Both are described as the intrinsic size, so the
 * choice is only safe while the two agree. If they drifted, a screenshot would reserve the
 * wrong box and the page would reflow as it arrived, which is the failure the dimensions exist
 * to prevent, on exactly the mobile reader it hurts most.
 */

import { describe, expect, test } from 'vitest';

import type { AssetRecord } from '../../src/contracts/manifest.js';
import { goldenManifest, goldenPages } from '../support/golden.js';

interface ImageLike {
	type: 'image';
	src: string;
	width: number;
	height: number;
}

/** Every image node in a payload, wherever it sits: inline, in a figure, a list, a table. */
function imagesIn(value: unknown): ImageLike[] {
	if (Array.isArray(value)) return value.flatMap((item) => imagesIn(item));
	if (typeof value !== 'object' || value === null) return [];
	const record = value as Record<string, unknown>;
	const own = record['type'] === 'image' ? [record as unknown as ImageLike] : [];
	return [...own, ...Object.values(record).flatMap((child) => imagesIn(child))];
}

describe('image dimensions', () => {
	test('every image node in every compiled page matches its asset record', () => {
		const manifest = goldenManifest();
		const bySrc = new Map<string, AssetRecord>(
			manifest.assets.map((asset) => [`assets/${asset.sha256}.${asset.ext}`, asset]),
		);
		const checked: string[] = [];
		const mismatches: string[] = [];
		for (const { file, page } of goldenPages()) {
			for (const image of imagesIn(page.body)) {
				const asset = bySrc.get(image.src);
				checked.push(`${file} ${image.src}`);
				if (asset === undefined) {
					mismatches.push(`${file}: ${image.src} names no asset in the manifest`);
				} else if (asset.width !== image.width || asset.height !== image.height) {
					mismatches.push(
						`${file}: ${image.src} is ${image.width}x${image.height} on the node and ${asset.width}x${asset.height} in the manifest`,
					);
				}
			}
		}
		// The corpus has images in several locales. A walk that found none would pass over
		// anything, so it has to have looked at every asset at least once.
		const seen = new Set(checked.map((entry) => entry.split(' ')[1]));
		expect([...seen].sort()).toEqual([...bySrc.keys()].sort());
		expect(mismatches).toEqual([]);
	});
});
