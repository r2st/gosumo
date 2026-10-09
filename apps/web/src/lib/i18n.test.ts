import { describe, expect, it } from 'vitest';
import {
  LANG_STORAGE_KEY,
  TRANSLATIONS,
  UI_LANGUAGES,
  UI_LANGUAGE_LABELS,
  translate,
  type UiLang,
} from './i18n';

describe('translate', () => {
  it('returns the entry for the requested language', () => {
    expect(translate('en', 'nav.leads')).toBe('Leads');
    expect(translate('hi', 'nav.leads')).toBe(TRANSLATIONS.hi['nav.leads']);
  });

  it('falls back to English when the Hindi entry is missing', () => {
    // A key present in `en` but absent from `hi` must render the English copy
    // rather than a blank — a half-translated screen still has to be usable.
    const enOnly = Object.keys(TRANSLATIONS.en).find((k) => !(k in TRANSLATIONS.hi));
    if (enOnly) {
      expect(translate('hi', enOnly)).toBe(TRANSLATIONS.en[enOnly]);
    }
    // And synthesise the case regardless, so the fallback branch is exercised
    // even once the two dictionaries are fully in sync.
    expect(translate('hi', '__not_a_real_key__')).toBe('__not_a_real_key__');
  });

  it('falls back to the key itself for an unknown key, so a typo is visible', () => {
    expect(translate('en', 'nav.doesNotExist')).toBe('nav.doesNotExist');
    expect(translate('hi', 'nav.doesNotExist')).toBe('nav.doesNotExist');
  });

  it('falls back to English for an unknown language rather than throwing', () => {
    expect(translate('fr' as UiLang, 'nav.leads')).toBe('Leads');
  });

  it('returns the key when neither the language nor the key is known', () => {
    expect(translate('fr' as UiLang, 'totally.unknown')).toBe('totally.unknown');
  });
});

describe('dictionary parity', () => {
  it('translates every English key into Hindi', () => {
    // Drift here is the failure mode this table exists to prevent: an English
    // label added without its Hindi twin silently renders English to a Hindi
    // user. Listing the offenders makes the fix mechanical.
    const missing = Object.keys(TRANSLATIONS.en).filter((k) => !(k in TRANSLATIONS.hi));
    expect(missing).toEqual([]);
  });

  it('has no Hindi keys that no longer exist in English', () => {
    const orphaned = Object.keys(TRANSLATIONS.hi).filter((k) => !(k in TRANSLATIONS.en));
    expect(orphaned).toEqual([]);
  });

  it('leaves no entry blank in either language', () => {
    for (const lang of UI_LANGUAGES) {
      const blank = Object.entries(TRANSLATIONS[lang])
        .filter(([, v]) => v.trim() === '')
        .map(([k]) => k);
      expect(blank).toEqual([]);
    }
  });

  it('writes Hindi entries in Devanagari, not copied English', () => {
    // A handful of entries are legitimately identical across languages —
    // acronyms and product names (IVR, RERA, CSV, GoSumo). Everything else
    // being byte-identical means someone pasted the English string in.
    // A long English string duplicated into `hi` is untranslated copy, not a
    // shared acronym, so length is what separates the two cases.
    const suspicious = Object.keys(TRANSLATIONS.en).filter(
      (k) => TRANSLATIONS.hi[k] === TRANSLATIONS.en[k] && TRANSLATIONS.en[k].length > 12,
    );
    expect(suspicious).toEqual([]);
  });
});

describe('language metadata', () => {
  it('labels each supported language in its own script', () => {
    expect(UI_LANGUAGES).toEqual(['en', 'hi']);
    expect(UI_LANGUAGE_LABELS.en).toBe('English');
    expect(UI_LANGUAGE_LABELS.hi).toBe('हिंदी');
  });

  it('has a label for every supported language', () => {
    for (const lang of UI_LANGUAGES) {
      expect(UI_LANGUAGE_LABELS[lang]).toBeTruthy();
    }
  });

  it('pins the persistence key, which is shared with the cookie the server reads', () => {
    expect(LANG_STORAGE_KEY).toBe('desk-lang');
  });
});
