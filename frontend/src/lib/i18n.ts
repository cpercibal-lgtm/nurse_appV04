// English/Arabic UI strings with RTL (carried over from V03 app/src/lib/i18n.tsx;
// Observability keys dropped with that page, new-page keys added).

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { usePreferences, type Language } from '../hooks/usePreferences';
import { freshImport } from './freshImport';
import { en } from './i18n.en';

export type { TranslationKey } from './i18n.en';

function applyDirection(lang: Language) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

const importArabic = () => import('./i18n.ar');

/** Adds a language's strings the first time it is used; English is always there. */
async function load(lang: Language, importAr: typeof importArabic = importArabic) {
  if (lang === 'ar' && !i18n.hasResourceBundle('ar', 'translation')) {
    const { ar } = await importAr();
    i18n.addResourceBundle('ar', 'translation', ar);
  }
}

const initial = usePreferences.getState().language;
/** Resolves when the strings of the chosen language are loaded; main.tsx renders after it. */
export const i18nReady: Promise<void> = i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
}).then(() => load(initial)).catch(() => undefined).then(async () => {
  // If Arabic could not be loaded (offline), the app opens in English rather than not at all.
  await i18n.changeLanguage(i18n.hasResourceBundle(initial, 'translation') ? initial : 'en');
  applyDirection(i18n.language as Language);
});

// Language is owned by the preferences store; i18n and <html dir> follow it once the strings are in.
usePreferences.subscribe((s, prev) => {
  if (s.language === prev.language) return;
  // Switching to Arabic in a tab opened before a release: the strings file is gone, so reload once
  // (the choice is already saved and applies after the reload).
  void load(s.language, freshImport(importArabic)).then(async () => {
    await i18n.changeLanguage(s.language);
    applyDirection(s.language);
  });
});

export default i18n;
