/**
 * What a status glyph says, in words, in each of the seven languages.
 *
 * The `status` node exists because `chip-support-matrix.md` carries 86 glyphs that are
 * data rather than decoration, and `ast.ts` lists the three things that break if they
 * stay as text. Two of those three are closed here rather than in the renderer: a
 * screen reader announces a word instead of "white heavy check mark", and the search
 * index carries a real term so that a search for "supported" matches a row.
 *
 * It ships in the package in all seven languages for the same reason every other UI
 * string does. `kcalc-web/front` has no i18next and no shared locale package, so a
 * table the consumer had to supply would be a table one of the two consumers would not
 * have, and the cell would render blank on the site that forgot.
 *
 * These are the only UI strings in the package so far. The rest arrive with the
 * renderer in step 4, and this table moves in beside them when they do.
 */

import type { StatusValue } from '../contracts/ast.js';
import type { Locale } from '../contracts/locales.js';

export const STATUS_LABELS: Record<Locale, Record<StatusValue, string>> = {
	en: { yes: 'Supported', partial: 'Partial', no: 'Not supported', na: 'Not applicable' },
	zh: { yes: '支持', partial: '部分支持', no: '不支持', na: '不适用' },
	ar: { yes: 'مدعوم', partial: 'مدعوم جزئيا', no: 'غير مدعوم', na: 'لا ينطبق' },
	es: { yes: 'Compatible', partial: 'Parcial', no: 'No compatible', na: 'No aplicable' },
	ja: { yes: '対応', partial: '一部対応', no: '非対応', na: '該当なし' },
	fr: {
		yes: 'Pris en charge',
		partial: 'Partiel',
		no: 'Non pris en charge',
		na: 'Sans objet',
	},
	'pt-BR': {
		yes: 'Compatível',
		partial: 'Parcial',
		no: 'Não compatível',
		na: 'Não se aplica',
	},
};

/** The label for one value in one locale. Total: every locale carries every value. */
export function statusLabel(locale: Locale, value: StatusValue): string {
	return STATUS_LABELS[locale][value];
}
