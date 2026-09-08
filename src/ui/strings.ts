/**
 * Every word this package says, in all seven languages.
 *
 * It ships inside the package rather than being supplied by the consumer, and the reason
 * is not convenience. `kcalc-web/front` has no i18next and no shared locale package, and
 * `hex-web` runs `check-locales.mjs`, which compares all seven locale files key for key in
 * both directions, so a chrome key this package needed would be fourteen mandatory edits
 * in one consumer and an invented mechanism in the other. Keeping the strings here is what
 * makes installing documentation need no locale-file edits at all.
 *
 * `src/ui/status.ts` is the same table for the four status values and predates this one;
 * it stayed a separate file because a status label is content read out of a support
 * matrix rather than a piece of interface chrome, and because the compiler reads it to
 * build the search index while nothing here is read at publish time.
 *
 * ## The shape is total, so there is no fallback layer
 *
 * `Record<Locale, Record<UiKey, string>>` makes a missing key a typecheck failure rather
 * than a runtime hole, so the "active language, then English, then nothing" resolution
 * every i18n library ships has nothing to resolve. A string that reached English on a
 * Japanese page would be a bug nobody here could see; a string that cannot exist is not a
 * bug at all.
 *
 * ## Interpolation
 *
 * `{name}`, substituted by `interpolate`, which is the spelling `hex-web`'s own `i18n.tsx`
 * uses so a translator moving between the two behaves identically. An unknown token is
 * left verbatim rather than deleted, because a visible `{tolal}` in one language is a bug
 * report and a silently empty sentence is not.
 *
 * ## Why the language names are a table and not `Intl.DisplayNames`
 *
 * The same reason `plural.ts` gives for not using `Intl.PluralRules`. `Intl` answers from
 * whatever ICU the runtime was built with, so a server on one Node and a browser on
 * another can disagree about a string the reader sees, which is a hydration mismatch in
 * the one place a mismatch is most visible: a notice that says the page is not translated.
 */

import type { CalloutKind } from '../contracts/ast.js';
import type { Locale } from '../contracts/locales.js';
import { pluralForm, type PluralForms } from './plural.js';

export const UI_KEYS = [
	'skipToContent',
	'treeLabel',
	'tocLabel',
	'breadcrumbLabel',
	'pagerLabel',
	'previous',
	'next',
	'editPage',
	'pageLoaded',
	'versionPinned',
	'versionLatest',
	'noticeStale',
	'noticeFallback',
	'noticeReadEnglish',
	'searchOpen',
	'searchPlaceholder',
	'searchClose',
	'searchNoResults',
	'searchLoading',
	'searchHint',
	'searchOtherAudienceUser',
	'searchOtherAudienceDeveloper',
	'searchEnglishInstead',
	'copyCode',
	'copyMarkdown',
	'copied',
	'codeRegion',
	'codeRegionNamed',
	'tableRegion',
	'expandGroup',
	'collapseGroup',
	'externalLink',
	'stepLabel',
	'taskDone',
	'taskTodo',
	'notFoundTitle',
	'notFoundBody',
	'unsupportedTitle',
	'unsupportedBody',
] as const;

export type UiKey = (typeof UI_KEYS)[number];

export const UI_STRINGS: Record<Locale, Record<UiKey, string>> = {
	en: {
		skipToContent: 'Skip to documentation',
		treeLabel: 'Documentation',
		tocLabel: 'On this page',
		breadcrumbLabel: 'Breadcrumb',
		pagerLabel: 'More pages',
		previous: 'Previous',
		next: 'Next',
		editPage: 'Edit this page',
		pageLoaded: '{title} loaded',
		versionPinned: 'You are reading version {version}.',
		versionLatest: 'Go to the latest version, {version}.',
		noticeStale: 'This translation is older than the English page, which was updated {date}.',
		noticeFallback: 'This page has not been translated into {language} yet.',
		noticeReadEnglish: 'Read the English page',
		searchOpen: 'Search',
		searchPlaceholder: 'Search documentation',
		searchClose: 'Close search',
		searchNoResults: 'No results for {query}.',
		searchLoading: 'Loading the search index',
		searchHint: 'Press / to search',
		searchOtherAudienceUser: 'Also in the user guide',
		searchOtherAudienceDeveloper: 'Also in the developer documentation',
		searchEnglishInstead: 'Search the English documentation',
		copyCode: 'Copy',
		copyMarkdown: 'Copy as Markdown',
		copied: 'Copied',
		codeRegion: 'Code block',
		codeRegionNamed: '{language} code block',
		tableRegion: 'Table',
		expandGroup: 'Expand {group}',
		collapseGroup: 'Collapse {group}',
		externalLink: 'Opens in a new window',
		stepLabel: 'Step {number}',
		taskDone: 'Done',
		taskTodo: 'Not done',
		notFoundTitle: 'Page not found',
		notFoundBody: 'This page does not exist in this version of the documentation.',
		unsupportedTitle: 'This page cannot be displayed',
		unsupportedBody: 'It was published in a newer format than this site understands.',
	},
	zh: {
		skipToContent: '跳至文档内容',
		treeLabel: '文档',
		tocLabel: '本页内容',
		breadcrumbLabel: '面包屑导航',
		pagerLabel: '更多页面',
		previous: '上一页',
		next: '下一页',
		editPage: '编辑此页',
		pageLoaded: '{title}已加载',
		versionPinned: '您正在阅读 {version} 版本。',
		versionLatest: '前往最新版本 {version}。',
		noticeStale: '此翻译早于英文页面，英文页面已于{date}更新。',
		noticeFallback: '此页面尚未翻译成{language}。',
		noticeReadEnglish: '阅读英文页面',
		searchOpen: '搜索',
		searchPlaceholder: '搜索文档',
		searchClose: '关闭搜索',
		searchNoResults: '没有与 {query} 匹配的结果。',
		searchLoading: '正在加载搜索索引',
		searchHint: '按 / 键搜索',
		searchOtherAudienceUser: '另见用户指南',
		searchOtherAudienceDeveloper: '另见开发者文档',
		searchEnglishInstead: '搜索英文文档',
		copyCode: '复制',
		copyMarkdown: '复制为 Markdown',
		copied: '已复制',
		codeRegion: '代码块',
		codeRegionNamed: '{language} 代码块',
		tableRegion: '表格',
		expandGroup: '展开{group}',
		collapseGroup: '收起{group}',
		externalLink: '在新窗口中打开',
		stepLabel: '第 {number} 步',
		taskDone: '已完成',
		taskTodo: '未完成',
		notFoundTitle: '未找到页面',
		notFoundBody: '此版本的文档中没有该页面。',
		unsupportedTitle: '无法显示此页面',
		unsupportedBody: '此页面发布时使用的格式较新，本站尚无法识别。',
	},
	ar: {
		skipToContent: 'تخطي إلى التوثيق',
		treeLabel: 'التوثيق',
		tocLabel: 'في هذه الصفحة',
		breadcrumbLabel: 'مسار التنقل',
		pagerLabel: 'صفحات أخرى',
		previous: 'السابق',
		next: 'التالي',
		editPage: 'تحرير هذه الصفحة',
		pageLoaded: 'تم تحميل {title}',
		versionPinned: 'أنت تقرأ الإصدار {version}.',
		versionLatest: 'الانتقال إلى أحدث إصدار {version}.',
		noticeStale: 'هذه الترجمة أقدم من الصفحة الإنجليزية، التي جرى تحديثها في {date}.',
		noticeFallback: 'لم تُترجم هذه الصفحة إلى {language} بعد.',
		noticeReadEnglish: 'قراءة الصفحة الإنجليزية',
		searchOpen: 'بحث',
		searchPlaceholder: 'البحث في التوثيق',
		searchClose: 'إغلاق البحث',
		searchNoResults: 'لا توجد نتائج لـ {query}.',
		searchLoading: 'جارٍ تحميل فهرس البحث',
		searchHint: 'اضغط على / للبحث',
		searchOtherAudienceUser: 'أيضًا في دليل المستخدم',
		searchOtherAudienceDeveloper: 'أيضًا في توثيق المطوّرين',
		searchEnglishInstead: 'البحث في التوثيق الإنجليزي',
		copyCode: 'نسخ',
		copyMarkdown: 'نسخ بصيغة Markdown',
		copied: 'تم النسخ',
		codeRegion: 'كتلة برمجية',
		codeRegionNamed: 'كتلة برمجية بلغة {language}',
		tableRegion: 'جدول',
		expandGroup: 'توسيع {group}',
		collapseGroup: 'طي {group}',
		externalLink: 'يفتح في نافذة جديدة',
		stepLabel: 'الخطوة {number}',
		taskDone: 'مكتمل',
		taskTodo: 'غير مكتمل',
		notFoundTitle: 'الصفحة غير موجودة',
		notFoundBody: 'هذه الصفحة غير موجودة في هذا الإصدار من التوثيق.',
		unsupportedTitle: 'تعذّر عرض هذه الصفحة',
		unsupportedBody: 'نُشرت بتنسيق أحدث مما يفهمه هذا الموقع.',
	},
	es: {
		skipToContent: 'Saltar a la documentación',
		treeLabel: 'Documentación',
		tocLabel: 'En esta página',
		breadcrumbLabel: 'Ruta de navegación',
		pagerLabel: 'Más páginas',
		previous: 'Anterior',
		next: 'Siguiente',
		editPage: 'Editar esta página',
		pageLoaded: 'Se ha cargado {title}',
		versionPinned: 'Estás leyendo la versión {version}.',
		versionLatest: 'Ir a la última versión, {version}.',
		noticeStale: 'Esta traducción es anterior a la página en inglés, que se actualizó el {date}.',
		noticeFallback: 'Esta página aún no se ha traducido al {language}.',
		noticeReadEnglish: 'Leer la página en inglés',
		searchOpen: 'Buscar',
		searchPlaceholder: 'Buscar en la documentación',
		searchClose: 'Cerrar la búsqueda',
		searchNoResults: 'No hay resultados para {query}.',
		searchLoading: 'Cargando el índice de búsqueda',
		searchHint: 'Pulsa / para buscar',
		searchOtherAudienceUser: 'También en la guía de usuario',
		searchOtherAudienceDeveloper: 'También en la documentación para desarrolladores',
		searchEnglishInstead: 'Buscar en la documentación en inglés',
		copyCode: 'Copiar',
		copyMarkdown: 'Copiar como Markdown',
		copied: 'Copiado',
		codeRegion: 'Bloque de código',
		codeRegionNamed: 'Bloque de código en {language}',
		tableRegion: 'Tabla',
		expandGroup: 'Expandir {group}',
		collapseGroup: 'Contraer {group}',
		externalLink: 'Se abre en una ventana nueva',
		stepLabel: 'Paso {number}',
		taskDone: 'Hecho',
		taskTodo: 'Sin hacer',
		notFoundTitle: 'Página no encontrada',
		notFoundBody: 'Esta página no existe en esta versión de la documentación.',
		unsupportedTitle: 'No se puede mostrar esta página',
		unsupportedBody: 'Se publicó en un formato más reciente del que este sitio puede leer.',
	},
	ja: {
		skipToContent: 'ドキュメントへスキップ',
		treeLabel: 'ドキュメント',
		tocLabel: 'このページの内容',
		breadcrumbLabel: 'パンくずリスト',
		pagerLabel: '他のページ',
		previous: '前へ',
		next: '次へ',
		editPage: 'このページを編集',
		pageLoaded: '{title}を読み込みました',
		versionPinned: 'バージョン {version} を表示しています。',
		versionLatest: '最新バージョン {version} へ移動',
		noticeStale: 'この翻訳は英語ページより古い内容です。英語ページは{date}に更新されました。',
		noticeFallback: 'このページはまだ{language}に翻訳されていません。',
		noticeReadEnglish: '英語ページを読む',
		searchOpen: '検索',
		searchPlaceholder: 'ドキュメントを検索',
		searchClose: '検索を閉じる',
		searchNoResults: '{query} に一致する結果はありません。',
		searchLoading: '検索インデックスを読み込んでいます',
		searchHint: '/ キーで検索',
		searchOtherAudienceUser: 'ユーザーガイドにもあります',
		searchOtherAudienceDeveloper: '開発者向けドキュメントにもあります',
		searchEnglishInstead: '英語のドキュメントを検索',
		copyCode: 'コピー',
		copyMarkdown: 'Markdown としてコピー',
		copied: 'コピーしました',
		codeRegion: 'コードブロック',
		codeRegionNamed: '{language} のコードブロック',
		tableRegion: '表',
		expandGroup: '{group}を展開',
		collapseGroup: '{group}を折りたたむ',
		externalLink: '新しいウィンドウで開きます',
		stepLabel: '手順 {number}',
		taskDone: '完了',
		taskTodo: '未完了',
		notFoundTitle: 'ページが見つかりません',
		notFoundBody: 'このページは、このバージョンのドキュメントには存在しません。',
		unsupportedTitle: 'このページは表示できません',
		unsupportedBody: 'このサイトが対応していない新しい形式で公開されています。',
	},
	fr: {
		skipToContent: 'Aller à la documentation',
		treeLabel: 'Documentation',
		tocLabel: 'Sur cette page',
		breadcrumbLabel: "Fil d'Ariane",
		pagerLabel: 'Autres pages',
		previous: 'Précédent',
		next: 'Suivant',
		editPage: 'Modifier cette page',
		pageLoaded: 'Page chargée\u202f: {title}',
		versionPinned: 'Vous consultez la version {version}.',
		versionLatest: 'Aller à la dernière version, {version}.',
		noticeStale: 'Cette traduction est antérieure à la page en anglais, mise à jour le {date}.',
		noticeFallback: "Cette page n'est pas encore traduite en {language}.",
		noticeReadEnglish: 'Lire la page en anglais',
		searchOpen: 'Rechercher',
		searchPlaceholder: 'Rechercher dans la documentation',
		searchClose: 'Fermer la recherche',
		searchNoResults: 'Aucun résultat pour {query}.',
		searchLoading: "Chargement de l'index de recherche",
		searchHint: 'Appuyez sur / pour rechercher',
		searchOtherAudienceUser: "Également dans le guide de l'utilisateur",
		searchOtherAudienceDeveloper: 'Également dans la documentation développeur',
		searchEnglishInstead: 'Rechercher dans la documentation en anglais',
		copyCode: 'Copier',
		copyMarkdown: 'Copier au format Markdown',
		copied: 'Copié',
		codeRegion: 'Bloc de code',
		codeRegionNamed: 'Bloc de code {language}',
		tableRegion: 'Tableau',
		expandGroup: 'Développer {group}',
		collapseGroup: 'Réduire {group}',
		externalLink: 'Ouvre une nouvelle fenêtre',
		stepLabel: 'Étape {number}',
		taskDone: 'Fait',
		taskTodo: 'À faire',
		notFoundTitle: 'Page introuvable',
		notFoundBody: "Cette page n'existe pas dans cette version de la documentation.",
		unsupportedTitle: 'Cette page ne peut pas être affichée',
		unsupportedBody:
			'Elle a été publiée dans un format plus récent que celui que ce site sait lire.',
	},
	'pt-BR': {
		skipToContent: 'Ir para a documentação',
		treeLabel: 'Documentação',
		tocLabel: 'Nesta página',
		breadcrumbLabel: 'Trilha de navegação',
		pagerLabel: 'Mais páginas',
		previous: 'Anterior',
		next: 'Próxima',
		editPage: 'Editar esta página',
		pageLoaded: 'Página carregada: {title}',
		versionPinned: 'Você está lendo a versão {version}.',
		versionLatest: 'Ir para a versão mais recente, {version}.',
		noticeStale: 'Esta tradução é anterior à página em inglês, que foi atualizada em {date}.',
		noticeFallback: 'Esta página ainda não foi traduzida para {language}.',
		noticeReadEnglish: 'Ler a página em inglês',
		searchOpen: 'Buscar',
		searchPlaceholder: 'Buscar na documentação',
		searchClose: 'Fechar a busca',
		searchNoResults: 'Nenhum resultado para {query}.',
		searchLoading: 'Carregando o índice de busca',
		searchHint: 'Pressione / para buscar',
		searchOtherAudienceUser: 'Também no guia do usuário',
		searchOtherAudienceDeveloper: 'Também na documentação para desenvolvedores',
		searchEnglishInstead: 'Buscar na documentação em inglês',
		copyCode: 'Copiar',
		copyMarkdown: 'Copiar como Markdown',
		copied: 'Copiado',
		codeRegion: 'Bloco de código',
		codeRegionNamed: 'Bloco de código em {language}',
		tableRegion: 'Tabela',
		expandGroup: 'Expandir {group}',
		collapseGroup: 'Recolher {group}',
		externalLink: 'Abre em uma nova janela',
		stepLabel: 'Etapa {number}',
		taskDone: 'Concluído',
		taskTodo: 'Não concluído',
		notFoundTitle: 'Página não encontrada',
		notFoundBody: 'Esta página não existe nesta versão da documentação.',
		unsupportedTitle: 'Não é possível exibir esta página',
		unsupportedBody: 'Ela foi publicada em um formato mais novo do que este site consegue ler.',
	},
};

export const CALLOUT_LABELS: Record<Locale, Record<CalloutKind, string>> = {
	en: {
		note: 'Note',
		tip: 'Tip',
		important: 'Important',
		warning: 'Warning',
		caution: 'Caution',
	},
	zh: {
		note: '说明',
		tip: '提示',
		important: '重要',
		warning: '警告',
		caution: '注意',
	},
	ar: {
		note: 'ملاحظة',
		tip: 'تلميح',
		important: 'مهم',
		warning: 'تحذير',
		caution: 'تنبيه',
	},
	es: {
		note: 'Nota',
		tip: 'Sugerencia',
		important: 'Importante',
		warning: 'Advertencia',
		caution: 'Precaución',
	},
	ja: {
		note: 'メモ',
		tip: 'ヒント',
		important: '重要',
		warning: '警告',
		caution: '注意',
	},
	fr: {
		note: 'Remarque',
		tip: 'Conseil',
		important: 'Important',
		warning: 'Avertissement',
		caution: 'Attention',
	},
	'pt-BR': {
		note: 'Observação',
		tip: 'Dica',
		important: 'Importante',
		warning: 'Aviso',
		caution: 'Cuidado',
	},
};

export const PLURAL_KEYS = ['readingTime', 'resultCount'] as const;

export type PluralKey = (typeof PLURAL_KEYS)[number];

export const PLURAL_STRINGS: Record<PluralKey, Record<Locale, PluralForms>> = {
	readingTime: {
		en: { one: '{count} min read', other: '{count} min read' },
		zh: { other: '阅读 {count} 分钟' },
		ar: {
			zero: '{count} دقيقة للقراءة',
			one: '{count} دقيقة للقراءة',
			two: 'دقيقتان للقراءة',
			few: '{count} دقائق للقراءة',
			many: '{count} دقيقة للقراءة',
			other: '{count} دقيقة للقراءة',
		},
		es: { one: '{count} min de lectura', other: '{count} min de lectura' },
		ja: { other: '読了時間 {count} 分' },
		fr: { one: '{count} min de lecture', other: '{count} min de lecture' },
		'pt-BR': { one: '{count} min de leitura', other: '{count} min de leitura' },
	},
	resultCount: {
		en: { one: '{count} result', other: '{count} results' },
		zh: { other: '{count} 个结果' },
		ar: {
			zero: '{count} نتيجة',
			one: '{count} نتيجة',
			two: 'نتيجتان',
			few: '{count} نتائج',
			many: '{count} نتيجة',
			other: '{count} نتيجة',
		},
		es: { one: '{count} resultado', other: '{count} resultados' },
		ja: { other: '{count} 件の結果' },
		fr: { one: '{count} résultat', other: '{count} résultats' },
		'pt-BR': { one: '{count} resultado', other: '{count} resultados' },
	},
};

export const LANGUAGE_NAMES: Record<Locale, Record<Locale, string>> = {
	en: {
		en: 'English',
		zh: 'Chinese',
		ar: 'Arabic',
		es: 'Spanish',
		ja: 'Japanese',
		fr: 'French',
		'pt-BR': 'Portuguese (Brazil)',
	},
	zh: {
		en: '英语',
		zh: '中文',
		ar: '阿拉伯语',
		es: '西班牙语',
		ja: '日语',
		fr: '法语',
		'pt-BR': '葡萄牙语（巴西）',
	},
	ar: {
		en: 'الإنجليزية',
		zh: 'الصينية',
		ar: 'العربية',
		es: 'الإسبانية',
		ja: 'اليابانية',
		fr: 'الفرنسية',
		'pt-BR': 'البرتغالية (البرازيل)',
	},
	es: {
		en: 'inglés',
		zh: 'chino',
		ar: 'árabe',
		es: 'español',
		ja: 'japonés',
		fr: 'francés',
		'pt-BR': 'portugués (Brasil)',
	},
	ja: {
		en: '英語',
		zh: '中国語',
		ar: 'アラビア語',
		es: 'スペイン語',
		ja: '日本語',
		fr: 'フランス語',
		'pt-BR': 'ポルトガル語（ブラジル）',
	},
	fr: {
		en: 'anglais',
		zh: 'chinois',
		ar: 'arabe',
		es: 'espagnol',
		ja: 'japonais',
		fr: 'français',
		'pt-BR': 'portugais (Brésil)',
	},
	'pt-BR': {
		en: 'inglês',
		zh: 'chinês',
		ar: 'árabe',
		es: 'espanhol',
		ja: 'japonês',
		fr: 'francês',
		'pt-BR': 'português (Brasil)',
	},
};

/**
 * Forms that deliberately carry no `{count}`.
 *
 * Declared rather than tolerated, and checked in both directions by the string test, so a
 * translation that quietly dropped the number is a failure and this one is a decision.
 *
 * Arabic's dual is the only case, and it is a real one: the language expresses "two" in
 * the noun's own form, so a reader expects the bare word. Keeping the numeral would give
 * "2 minutes-dual", which is redundant, and using the singular noun with the numeral would
 * disagree with it, which is worse.
 */
export const TOKENLESS_PLURAL_FORMS = [
	{
		locale: 'ar',
		category: 'two',
		why: 'Arabic marks the dual in the noun, so the numeral is not written.',
	},
] as const;

/**
 * `{name}` substitution.
 *
 * A token with no value is left as it was written. Deleting it would turn a missing value
 * into a sentence that reads correctly and says something false, which is the failure mode
 * that survives review; a visible brace does not.
 */
export function interpolate(
	template: string,
	values: Readonly<Record<string, string>> = {},
): string {
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		Object.prototype.hasOwnProperty.call(values, name) ? (values[name] as string) : match,
	);
}

/** One interface string, interpolated. Total: every locale carries every key. */
export function uiString(
	locale: Locale,
	key: UiKey,
	values?: Readonly<Record<string, string>>,
): string {
	return interpolate(UI_STRINGS[locale][key], values);
}

/** The default heading for a callout whose author supplied none. */
export function calloutLabel(locale: Locale, kind: CalloutKind): string {
	return CALLOUT_LABELS[locale][kind];
}

/**
 * The name of a language, written in another language.
 *
 * `languageName('ja', 'fr')` is the Japanese word for French. The fallback notice needs
 * the reader's own language named in their own language, which is the diagonal.
 */
export function languageName(display: Locale, named: Locale): string {
	return LANGUAGE_NAMES[display][named];
}

/** A counted string in the form its language needs for that number. */
export function uiPlural(locale: Locale, key: PluralKey, count: number): string {
	return interpolate(pluralForm(locale, PLURAL_STRINGS[key][locale], count), {
		count: String(count),
	});
}
