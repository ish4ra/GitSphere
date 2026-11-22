const ISO2_CODES = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ
EC EE EG EH ER ES ET
FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU
ID IE IL IM IN IO IQ IR IS IT
JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ
LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ
OM
PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA
RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ
VA VC VE VG VI VN VU
WF WS
YE YT
ZA ZM ZW
`.trim().split(/\s+/);

const EXTRA_COUNTRIES = [
  { code: 'XK', name: 'Kosovo' },
];

const NAME_OVERRIDES = new Map([
  ['BO', 'Bolivia'],
  ['BN', 'Brunei'],
  ['CD', 'DR Congo'],
  ['CG', 'Republic of the Congo'],
  ['CI', "Côte d'Ivoire"],
  ['CZ', 'Czechia'],
  ['FM', 'Micronesia'],
  ['HK', 'Hong Kong'],
  ['GB', 'United Kingdom'],
  ['IR', 'Iran'],
  ['KP', 'North Korea'],
  ['KR', 'South Korea'],
  ['LA', 'Laos'],
  ['MD', 'Moldova'],
  ['MO', 'Macao'],
  ['PS', 'Palestine'],
  ['RU', 'Russia'],
  ['SY', 'Syria'],
  ['TZ', 'Tanzania'],
  ['US', 'United States'],
  ['VE', 'Venezuela'],
  ['VN', 'Vietnam'],
]);

const COUNTRY_ALIASES = new Map([
  ['AE', ['UAE', 'U.A.E.', 'Emirates']],
  ['BA', ['Bosnia', 'Bosnia-Herzegovina']],
  ['BO', ['Plurinational State of Bolivia']],
  ['BN', ['Brunei Darussalam']],
  ['CD', ['Democratic Republic of the Congo', 'DRC', 'D.R.C.', 'Congo-Kinshasa']],
  ['CG', ['Congo-Brazzaville']],
  ['CI', ['Ivory Coast']],
  ['CN', ['PRC', "People's Republic of China", 'Mainland China', 'P.R. China', 'P.R.China']],
  ['CV', ['Cape Verde']],
  ['CZ', ['Czech Republic']],
  ['FM', ['Federated States of Micronesia']],
  ['GB', ['UK', 'U.K.', 'Great Britain', 'Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland']],
  ['HK', ['Hong Kong SAR', 'Hong Kong S.A.R.', 'Hong Kong SAR China', 'Hong Kong Special Administrative Region', 'HKSAR']],
  ['IE', ['Republic of Ireland', 'Eire']],
  ['IN', ['Bharat']],
  ['IR', ['Islamic Republic of Iran']],
  ['KP', ['DPRK', 'D.P.R.K.', "Democratic People's Republic of Korea"]],
  ['KR', ['Republic of Korea', 'ROK', 'R.O.K.', 'Korea']],
  ['LA', ["Lao People's Democratic Republic", 'Lao PDR']],
  ['LK', ['Srilanka', 'Sri-Lanka', 'Ceylon', 'Lanka']],
  ['MD', ['Republic of Moldova']],
  ['MK', ['Macedonia', 'North Macedonia']],
  ['MO', ['Macau', 'Macau SAR', 'Macao SAR', 'Macao SAR China', 'Macao Special Administrative Region']],
  ['MM', ['Burma']],
  ['NL', ['The Netherlands', 'Holland']],
  ['PH', ['Phillipines', 'Philipines']],
  ['PS', ['State of Palestine', 'Palestinian Territories']],
  ['RU', ['Russian Federation']],
  ['SA', ['KSA', 'Kingdom of Saudi Arabia']],
  ['SZ', ['Swaziland']],
  ['TL', ['East Timor']],
  ['TR', ['Turkey', 'Türkiye', 'Turkiye']],
  ['TW', ['Republic of China', 'R.O.C.']],
  ['TZ', ['United Republic of Tanzania']],
  ['US', ['USA', 'U.S.A.', 'U.S.', 'United States of America', 'United States of America (USA)']],
  ['VA', ['Vatican City', 'Vatican']],
  ['VE', ['Bolivarian Republic of Venezuela']],
  ['VN', ['Viet Nam']],
  ['XK', ['Republic of Kosovo']],
]);

const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });

export const COUNTRIES = [
  ...ISO2_CODES.map((code) => ({
    code,
    name: NAME_OVERRIDES.get(code) || displayNames.of(code) || code,
  })),
  ...EXTRA_COUNTRIES,
]
  .map((country) => ({
    ...country,
    slug: slugify(country.name),
    flag: countryCodeToFlag(country.code),
    aliases: COUNTRY_ALIASES.get(country.code) || [],
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const BY_CODE = new Map(COUNTRIES.map((country) => [country.code, country]));

export function getCountry(code) {
  return BY_CODE.get(String(code || '').trim().toUpperCase()) || null;
}

export function countryCodeToFlag(code) {
  const normalized = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return '🌐';
  return normalized.replace(/[A-Z]/g, (char) =>
    String.fromCodePoint(127397 + char.charCodeAt(0)),
  );
}

export function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
