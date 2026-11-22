// Shared, Unicode-safe location normalization used by every GitSphere
// pipeline. Latin combining diacritics are folded ("München" -> "munchen"),
// while combining marks required by other scripts (Sinhala, Devanagari, ...)
// are preserved so native-language names still match.

export function normalizeLocation(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[ßẞ]/g, 'ss')
    .replace(/[łŁ]/g, 'l')
    .replace(/[øØ]/g, 'o')
    .replace(/[đĐ]/g, 'd')
    .replace(/[ıİ]/g, 'i')
    .replace(/&/g, ' and ')
    .replace(/['’`´ʻ]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
}

// Romanization folding for South Asian place names, where the same place is
// commonly written with or without aspirated "h" ("Mathugama" / "Matugama",
// "Kaluthara" / "Kalutara"). Only used as a fallback lookup key.
export function foldTransliteration(normalized) {
  return String(normalized || '')
    .replace(/([bcdgjkpt])h/g, '$1')
    .replace(/aa/g, 'a')
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/w/g, 'v');
}

export const TRANSLITERATION_COUNTRIES = new Set(['LK', 'IN', 'NP', 'BD', 'MV', 'PK', 'BT']);
