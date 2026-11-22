// Small, reviewed lists that complement the generated gazetteer. Keep these
// short and documented: anything broad belongs in the upstream datasets.

// Profile locations that are not attributable to a country. A segment that
// matches one of these is ignored; a location made only of such segments is
// reported as `non-geographic-location`.
export const NON_GEOGRAPHIC_TERMS = new Set([
  'earth', 'planet earth', 'the earth', 'world', 'the world', 'worldwide', 'world wide', 'global',
  'globe', 'international', 'everywhere', 'anywhere', 'somewhere', 'nowhere', 'here', 'there',
  'remote', 'remotely', 'fully remote', 'remote first', 'remote only', 'work from home', 'wfh',
  'home', 'my home', 'internet', 'the internet', 'online', 'cyberspace', 'the cloud', 'cloud',
  'web', 'the web', 'metaverse', 'virtual', 'digital', 'matrix', 'the matrix', 'localhost',
  '127 0 0 1', '0 0 0 0', '::1', 'lan', 'github', 'git', 'code', 'linux', 'java', 'python', 'rust',
  'kernel', 'terminal', 'universe', 'the universe', 'multiverse', 'milky way', 'the milky way',
  'galaxy', 'solar system', 'space', 'outer space', 'mars', 'moon', 'the moon', 'sun', 'jupiter',
  'saturn', 'pluto', 'heaven', 'hell', 'middle earth', 'hogwarts', 'narnia', 'gotham',
  'gotham city', 'atlantis', 'wakanda', 'asgard', 'tatooine', 'westeros', 'neverland', 'mordor',
  'shire', 'the shire', 'springfield usa', 'unknown', 'n a', 'na', 'none', 'null', 'undefined',
  'nil', 'void', 'secret', 'private', 'classified', 'location', 'your heart', 'my house',
  'in your heart', 'behind you', 'on the road', 'traveling', 'travelling', 'digital nomad',
  'nomad', 'mobile', 'various', 'multiple', 'distributed', 'all over the world', 'around the world',
  'the world wide web', 'www', 'open source',
]);

// Continents and supranational regions: real places, but not countries.
export const SUPRANATIONAL_TERMS = new Set([
  'europe', 'eu', 'european union', 'asia', 'africa', 'north america', 'south america',
  'latin america', 'latam', 'central america', 'americas', 'the americas', 'oceania',
  'middle east', 'mena', 'emea', 'apac', 'asia pacific', 'southeast asia', 'south east asia',
  'east asia', 'south asia', 'central asia', 'western europe', 'eastern europe', 'northern europe',
  'southern europe', 'central europe', 'scandinavia', 'nordics', 'nordic', 'balkans', 'baltics',
  'caribbean', 'sub saharan africa', 'west africa', 'east africa', 'north africa', 'southern africa',
  'gulf', 'benelux', 'dach', 'iberia', 'iberian peninsula', 'indochina', 'arabia', 'levant',
]);

// Widely used metropolitan nicknames that are not gazetteer place names.
export const METRO_ALIASES = new Map([
  ['bay area', 'US'],
  ['sf bay area', 'US'],
  ['san francisco bay area', 'US'],
  ['silicon valley', 'US'],
  ['the bay area', 'US'],
  ['nyc', 'US'],
  ['new york city', 'US'],
  ['greater london', 'GB'],
  ['greater boston', 'US'],
  ['greater seattle area', 'US'],
  ['greater toronto area', 'CA'],
  ['gta', 'CA'],
  ['dmv', 'US'],
  ['research triangle', 'US'],
  ['randstad', 'NL'],
  ['ncr delhi', 'IN'],
  ['delhi ncr', 'IN'],
  ['greater tokyo', 'JP'],
]);

// Directional or descriptive words that can be dropped from a segment when
// the remaining words are a recognized place ("Kalutara South").
export const PLACE_QUALIFIER_WORDS = new Set([
  'north', 'south', 'east', 'west', 'central', 'northern', 'southern', 'eastern', 'western',
  'greater', 'metro', 'metropolitan', 'area', 'region', 'city', 'downtown', 'suburbs', 'district',
  'town', 'county', 'province', 'state',
]);

// Leading phrases people prefix to their location.
export const LOCATION_PREFIX = /^(?:i am |i m |im )?(?:currently |now |mostly |usually )?(?:based |living |located |working |residing |staying |born |raised )?(?:in|at|from|near|around)\s+/i;

// Locales used to add localized country names beyond the CSC translations.
export const COUNTRY_NAME_LOCALES = [
  'en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ru', 'uk', 'pl', 'tr', 'zh', 'zh-Hant', 'ja', 'ko',
  'ar', 'fa', 'he', 'hi', 'bn', 'ta', 'si', 'th', 'vi', 'id', 'ms', 'sw', 'el', 'cs', 'sk', 'sv',
  'fi', 'nb', 'da', 'hu', 'ro', 'bg', 'sr', 'hr', 'ka', 'hy', 'az', 'kk', 'uz', 'mn', 'ne', 'ur',
  'am', 'my', 'km', 'lo', 'te', 'ml', 'kn', 'mr', 'gu', 'pa', 'lt', 'lv', 'et', 'sl', 'is', 'ga',
  'ca', 'eu', 'gl', 'af', 'tl', 'be', 'mk', 'sq', 'bs',
];

// Catalog territories that some upstream datasets also list as a subdivision
// of a parent state. GitSphere's catalog treats them as separate regions, so
// the parent's duplicate subdivision (and its places) is re-homed to the
// territory instead of competing with it.
export const TERRITORY_PARENTS = new Map([
  ['HK', 'CN'], ['MO', 'CN'], ['TW', 'CN'],
  ['PR', 'US'], ['GU', 'US'], ['VI', 'US'], ['AS', 'US'], ['MP', 'US'], ['UM', 'US'],
  ['GP', 'FR'], ['MQ', 'FR'], ['GF', 'FR'], ['RE', 'FR'], ['YT', 'FR'], ['PM', 'FR'],
  ['BL', 'FR'], ['MF', 'FR'], ['NC', 'FR'], ['PF', 'FR'], ['WF', 'FR'], ['TF', 'FR'],
  ['AW', 'NL'], ['CW', 'NL'], ['SX', 'NL'], ['BQ', 'NL'],
  ['GL', 'DK'], ['FO', 'DK'], ['AX', 'FI'], ['SJ', 'NO'], ['BV', 'NO'],
  ['CX', 'AU'], ['CC', 'AU'], ['NF', 'AU'], ['HM', 'AU'],
  ['IM', 'GB'], ['JE', 'GB'], ['GG', 'GB'], ['GI', 'GB'], ['BM', 'GB'], ['KY', 'GB'],
  ['VG', 'GB'], ['AI', 'GB'], ['MS', 'GB'], ['TC', 'GB'], ['FK', 'GB'], ['SH', 'GB'],
  ['PN', 'GB'], ['IO', 'GB'], ['GS', 'GB'],
  ['CK', 'NZ'], ['NU', 'NZ'], ['TK', 'NZ'],
  ['XK', 'RS'], ['EH', 'MA'],
]);
