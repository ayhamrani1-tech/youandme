/**
 * Section identity.
 *
 * Each of the five sections owns a hue and a glyph. The hue is applied as the
 * CSS custom property `--accent`, which the component layer reads for leading
 * edges, meter fills and accent buttons — so section colour is set in one place
 * and never interpolated into a class name.
 */
export const SECTION_HUES = {
  sports_field: '#2E9E5B',
  barber: '#C9873D',
  salon: '#D4557F',
  dental: '#3EA8C4',
  gym: '#7C66E0',
};

export const SECTIONS = ['sports_field', 'barber', 'salon', 'dental', 'gym'];

export const SECTION_PATHS = {
  sports_field: '/fields',
  barber: '/barber',
  salon: '/salon',
  dental: '/dental',
  gym: '/gyms',
};

/** Path segment → section key, for the generic browse route. */
export const PATH_SECTIONS = {
  fields: 'sports_field',
  barber: 'barber',
  salon: 'salon',
  dental: 'dental',
  gyms: 'gym',
};

/** `style` object that sets the section hue for a subtree. */
export const accent = (section) => ({ '--accent': SECTION_HUES[section] || '#D9A334' });

/** Inline hue, for one-off swatches. */
export const hueOf = (section) => SECTION_HUES[section] || '#D9A334';

export const GENDER_LOCKED = { barber: 'male', salon: 'female' };

export const TREATMENTS = ['extraction', 'filling', 'cleaning', 'veneer', 'checkup'];

/** Jordan's governorates, with their principal cities. */
export const GOVERNORATES = [
  { ar: 'العاصمة', en: 'Amman', cities: ['عمان', 'الجبيهة', 'الصويفية', 'مرج الحمام', 'سحاب', 'وادي السير'] },
  { ar: 'إربد', en: 'Irbid', cities: ['إربد', 'الرمثا', 'الحصن', 'بني كنانة'] },
  { ar: 'الزرقاء', en: 'Zarqa', cities: ['الزرقاء', 'الرصيفة', 'الأزرق'] },
  { ar: 'البلقاء', en: 'Balqa', cities: ['السلط', 'دير علا', 'عين الباشا'] },
  { ar: 'المفرق', en: 'Mafraq', cities: ['المفرق', 'الرويشد'] },
  { ar: 'الكرك', en: 'Karak', cities: ['الكرك', 'القصر', 'المزار'] },
  { ar: 'جرش', en: 'Jerash', cities: ['جرش'] },
  { ar: 'مادبا', en: 'Madaba', cities: ['مادبا', 'ذيبان'] },
  { ar: 'عجلون', en: 'Ajloun', cities: ['عجلون', 'كفرنجة'] },
  { ar: 'العقبة', en: 'Aqaba', cities: ['العقبة', 'القويرة'] },
  { ar: 'معان', en: "Ma'an", cities: ['معان', 'البتراء', 'الشوبك'] },
  { ar: 'الطفيلة', en: 'Tafilah', cities: ['الطفيلة', 'بصيرا'] },
];

/** Jordanian mobile prefixes, by operator. */
export const PHONE_PREFIXES = { '077': 'Orange', '078': 'Umniah', '079': 'Zain' };

export function carrierOf(phone) {
  const prefix = String(phone || '').slice(0, 3);
  return PHONE_PREFIXES[prefix] || null;
}

export const isValidJordanPhone = (phone) => /^07[789]\d{7}$/.test(String(phone || '').trim());
