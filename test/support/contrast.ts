/**
 * WCAG 2.x relative luminance and contrast, written once.
 *
 * Two suites need it: the theme token table states a floor and a measurement for each
 * colour it ships, and the palette states one for each of the thirty-one colours the
 * renderer paints. Two implementations of a formula is how one of them ends up measuring
 * something else, and the pair that proves this one is right is asserted once, in
 * `test/contracts/theme.test.ts`, rather than in each caller.
 *
 * It lives under `test/` rather than under `src/` because nothing at runtime measures
 * contrast: the numbers are decided here and the stylesheet ships the results.
 */

const channel = (value: number): number =>
	value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

export function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => channel(Number.parseInt(hex.slice(i, i + 2), 16) / 255));
	return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

export function contrast(a: string, b: string): number {
	const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return ((lighter as number) + 0.05) / ((darker as number) + 0.05);
}

/** Rounded the way a role string states it, so a stated number and a measured one compare. */
export function stated(ratio: number): number {
	return Math.round(ratio * 100) / 100;
}
