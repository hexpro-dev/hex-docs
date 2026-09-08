/**
 * The status labels.
 *
 * Twenty-eight short strings, and the reason they are worth a test file is that three
 * separate failures here are silent. A missing locale renders a blank cell in one
 * language. A duplicated label makes two statuses read the same to a screen reader. And
 * an English label left in a translated table is the one thing nobody reviewing the
 * English page can see.
 */

import { describe, expect, test } from 'vitest';

import { STATUS_VALUES } from '../../src/contracts/ast.js';
import { LOCALES, SOURCE_LOCALE } from '../../src/contracts/locales.js';
import { STATUS_LABELS, statusLabel } from '../../src/ui/status.js';

describe('the table', () => {
	test('every locale carries every value', () => {
		let examined = 0;
		for (const locale of LOCALES) {
			for (const value of STATUS_VALUES) {
				const label = statusLabel(locale, value);
				expect(typeof label, `${locale}.${value}`).toBe('string');
				expect(label.trim().length, `${locale}.${value}`).toBeGreaterThan(0);
				examined += 1;
			}
		}
		expect(examined).toBe(LOCALES.length * STATUS_VALUES.length);
		expect(examined).toBe(28);
	});

	test('it has no locale and no value beyond the two unions', () => {
		expect(Object.keys(STATUS_LABELS).sort()).toEqual([...LOCALES].sort());
		for (const locale of LOCALES) {
			expect(Object.keys(STATUS_LABELS[locale]).sort()).toEqual([...STATUS_VALUES].sort());
		}
	});

	test('the four labels in a language are four different words', () => {
		// Two statuses that read the same are two statuses a reader cannot tell apart, and
		// the support matrix is the page where that is the whole content.
		for (const locale of LOCALES) {
			const labels = STATUS_VALUES.map((value) => statusLabel(locale, value));
			expect(new Set(labels).size, locale).toBe(STATUS_VALUES.length);
		}
	});

	test('no translation is left in the source language', () => {
		// The failure this catches is a table half translated: the English word sitting in
		// an Arabic column, which reads as a bug to every reader who sees it and to none of
		// the people who could fix it.
		let examined = 0;
		for (const locale of LOCALES) {
			if (locale === SOURCE_LOCALE) continue;
			for (const value of STATUS_VALUES) {
				expect(statusLabel(locale, value), `${locale}.${value}`).not.toBe(
					statusLabel(SOURCE_LOCALE, value),
				);
				examined += 1;
			}
		}
		expect(examined).toBe((LOCALES.length - 1) * STATUS_VALUES.length);
	});

	test('a label is a word rather than a sentence', () => {
		for (const locale of LOCALES) {
			for (const value of STATUS_VALUES) {
				const label = statusLabel(locale, value);
				expect(label.endsWith('.'), `${locale}.${value}`).toBe(false);
				expect(label.length, `${locale}.${value}`).toBeLessThan(24);
			}
		}
	});
});
