#!/usr/bin/env node
/**
 * Seed the database with a realistic Jordanian dataset covering all five
 * sections, so every screen has something in it the moment you sign in.
 *
 *   node src/db/seed.js              add seed data (skips if already seeded)
 *   node src/db/seed.js --force      wipe all rows and reseed
 */
import { initDb, closeDb } from './index.js';
import { config } from '../config.js';
import { hashPassword, randomReference } from '../lib/security.js';
import { addDays, addMonths, nowIso, dateOnly } from '../lib/time.js';

const force = process.argv.includes('--force');
const db = await initDb();

const existing = await db.value('SELECT COUNT(*) AS c FROM users').catch(() => null);
if (existing === null) {
  console.log('[seed] schema not found — running migration first');
  await db.migrate();
}
if (Number(existing ?? 0) > 0) {
  if (!force) {
    console.log(`[seed] database already has ${existing} user(s). Use --force to wipe and reseed.`);
    await closeDb();
    process.exit(0);
  }
  console.log('[seed] --force: clearing all rows');
  await db.truncateAll();
}

const PASSWORD = hashPassword(config.seed.defaultPassword);
const ADMIN_PASSWORD = hashPassword(config.seed.adminPassword);

/** Approximate coordinates for Jordanian cities, used for nearby-gym search. */
const PLACES = {
  amman: { governorate: 'العاصمة', city: 'عمان', lat: 31.9539, lng: 35.9106 },
  jubeiha: { governorate: 'العاصمة', city: 'الجبيهة', lat: 32.0215, lng: 35.8702 },
  sweifieh: { governorate: 'العاصمة', city: 'الصويفية', lat: 31.9484, lng: 35.8686 },
  irbid: { governorate: 'إربد', city: 'إربد', lat: 32.5556, lng: 35.85 },
  zarqa: { governorate: 'الزرقاء', city: 'الزرقاء', lat: 32.0728, lng: 36.0876 },
  aqaba: { governorate: 'العقبة', city: 'العقبة', lat: 29.5321, lng: 35.0063 },
};

async function createUser(fields) {
  return db.insert('users', {
    password_hash: PASSWORD,
    role: 'client',
    locale: 'ar',
    is_active: true,
    ...fields,
  });
}

console.log('[seed] users');
const admin = await db.insert('users', {
  full_name: 'مدير المنصة',
  email: config.seed.adminEmail,
  password_hash: ADMIN_PASSWORD,
  role: 'admin',
  gender: 'male',
  phone: '0790000000',
  locale: 'ar',
  ...PLACES.amman,
  is_active: true,
});

const owners = {
  field: await createUser({
    full_name: 'سامر الخطيب',
    email: 'fields@youandme.jo',
    role: 'owner',
    gender: 'male',
    phone: '0791111111',
    ...PLACES.amman,
  }),
  barber: await createUser({
    full_name: 'محمود العلي',
    email: 'barber@youandme.jo',
    role: 'owner',
    gender: 'male',
    phone: '0782222222',
    ...PLACES.jubeiha,
  }),
  salon: await createUser({
    full_name: 'ريم الشامي',
    email: 'salon@youandme.jo',
    role: 'owner',
    gender: 'female',
    phone: '0773333333',
    ...PLACES.sweifieh,
  }),
  dental: await createUser({
    full_name: 'د. أحمد الزعبي',
    email: 'clinic@youandme.jo',
    role: 'owner',
    gender: 'male',
    phone: '0794444444',
    ...PLACES.irbid,
  }),
  gym: await createUser({
    full_name: 'عمر الفايز',
    email: 'gym@youandme.jo',
    role: 'owner',
    gender: 'male',
    phone: '0795555555',
    ...PLACES.amman,
  }),
  gym2: await createUser({
    full_name: 'ليلى حدادين',
    email: 'gym2@youandme.jo',
    role: 'owner',
    gender: 'female',
    phone: '0796666666',
    ...PLACES.irbid,
  }),
};

const clients = {
  khaled: await createUser({
    full_name: 'خالد المصري',
    email: 'khaled@example.com',
    gender: 'male',
    phone: '0797777777',
    ...PLACES.amman,
  }),
  yousef: await createUser({
    full_name: 'يوسف الرواشدة',
    email: 'yousef@example.com',
    gender: 'male',
    phone: '0788888888',
    ...PLACES.zarqa,
  }),
  nour: await createUser({
    full_name: 'نور العبادي',
    email: 'nour@example.com',
    gender: 'female',
    phone: '0779999999',
    ...PLACES.sweifieh,
  }),
  salma: await createUser({
    full_name: 'سلمى القضاة',
    email: 'salma@example.com',
    gender: 'female',
    phone: '0791234567',
    // Deliberately in Irbid, to demonstrate distance to the Amman gyms.
    ...PLACES.irbid,
  }),
};

// Extra players so a match can actually reach its 14-player quota.
const extraPlayers = [];
for (let i = 1; i <= 12; i += 1) {
  extraPlayers.push(
    await createUser({
      full_name: `لاعب ${i}`,
      email: `player${i}@example.com`,
      gender: 'male',
      phone: `079000${String(i).padStart(4, '0')}`,
      ...PLACES.amman,
    }),
  );
}

async function createBusiness(fields) {
  return db.insert('businesses', {
    gender_policy: 'any',
    opens_at: '09:00',
    closes_at: '22:00',
    slot_minutes: 30,
    is_active: true,
    ...fields,
  });
}

// ---------------------------------------------------------------------------
// Section 1 — Sports fields
// ---------------------------------------------------------------------------
console.log('[seed] sports fields');
const fieldVenue = await createBusiness({
  section: 'sports_field',
  owner_id: owners.field.id,
  name_ar: 'ملاعب الأبطال',
  name_en: 'Champions Fields',
  description_ar:
    'مجمع ملاعب كرة قدم في عمان بأرضية عشب صناعي حديثة وإضاءة ليلية كاملة، مع غرف تبديل ومواقف واسعة. الحجز بالحصة ويُحسب السعر لكل لاعب.',
  description_en:
    'A football complex in Amman with modern artificial turf, full floodlighting, changing rooms and ample parking. Sessions are booked per player.',
  phone: '0791111111',
  ...PLACES.amman,
  opens_at: '08:00',
  closes_at: '23:30',
  cover_url: 'https://images.unsplash.com/photo-1459865264687-595d652de67e?w=1200&q=80',
});

const pitchA = await db.insert('fields', {
  business_id: fieldVenue.id,
  name: 'الملعب الرئيسي',
  surface: 'artificial',
  size_label: '7 ضد 7',
  price_per_person: 4.5,
  required_players: 14,
  description:
    'ملعب عشب صناعي بمقاس 7 ضد 7، مزود بإضاءة ليلية وشبكات جديدة ومدرجات صغيرة للمشاهدين. الحصة ساعة ونصف وتتأكد المباراة عند اكتمال 14 لاعبًا.',
  is_active: true,
});
const pitchB = await db.insert('fields', {
  business_id: fieldVenue.id,
  name: 'الملعب المغطى',
  surface: 'indoor',
  size_label: '5 ضد 5',
  price_per_person: 5.5,
  required_players: 10,
  description: 'ملعب مغطى مناسب للشتاء، أرضية مطاطية وتهوية جيدة.',
  is_active: true,
});

const slotTimes = ['18:00', '19:30', '21:00'];
const createdSlots = [];
for (let day = 0; day < 10; day += 1) {
  const date = dateOnly(addDays(nowIso(), day));
  for (const time of slotTimes) {
    const startsAt = `${date}T${time}:00.000Z`;
    if (new Date(startsAt) <= new Date()) continue;
    createdSlots.push(
      await db.insert('field_slots', {
        field_id: pitchA.id,
        starts_at: startsAt,
        ends_at: new Date(new Date(startsAt).getTime() + 90 * 60000).toISOString(),
        duration_min: 90,
        price_per_person: 4.5,
        required_players: 14,
        joined_players: 0,
        status: 'open',
      }),
    );
  }
}
for (let day = 0; day < 6; day += 1) {
  const date = dateOnly(addDays(nowIso(), day));
  const startsAt = `${date}T20:00:00.000Z`;
  if (new Date(startsAt) <= new Date()) continue;
  createdSlots.push(
    await db.insert('field_slots', {
      field_id: pitchB.id,
      starts_at: startsAt,
      ends_at: new Date(new Date(startsAt).getTime() + 90 * 60000).toISOString(),
      duration_min: 90,
      price_per_person: 5.5,
      required_players: 10,
      joined_players: 0,
      status: 'open',
    }),
  );
}

/** Fill a session to a given headcount, confirming it if the quota is met. */
async function fillSlot(slot, users) {
  let joined = 0;
  for (const user of users) {
    await db.insert('field_participants', {
      slot_id: slot.id,
      user_id: user.id,
      players_count: 1,
      amount_due: Number(slot.price_per_person),
      status: 'joined',
    });
    joined += 1;
    await db.insert('transactions', {
      user_id: user.id,
      business_id: fieldVenue.id,
      slot_id: slot.id,
      kind: 'field_payment',
      amount: Number(slot.price_per_person),
      currency: config.rules.currency,
      method: 'cash',
      status: 'pending',
      note: '1 player',
    });
  }
  const confirmed = joined >= Number(slot.required_players);
  await db.run(
    'UPDATE field_slots SET joined_players = ?, status = ?, confirmed_at = ? WHERE id = ?',
    [joined, confirmed ? 'confirmed' : 'open', confirmed ? nowIso() : null, slot.id],
  );
  return confirmed;
}

// One session nearly full (11 of 14) so the quota rule is visible in the UI.
if (createdSlots[0]) {
  await fillSlot(createdSlots[0], [clients.khaled, clients.yousef, ...extraPlayers.slice(0, 9)]);
}
// One session already confirmed at exactly 14.
if (createdSlots[1]) {
  await fillSlot(createdSlots[1], [clients.khaled, clients.yousef, ...extraPlayers]);
}

// A past, completed session so its players can leave a rating.
const pastSlot = await db.insert('field_slots', {
  field_id: pitchA.id,
  starts_at: addDays(nowIso(), -3),
  ends_at: addDays(nowIso(), -3),
  duration_min: 90,
  price_per_person: 4.5,
  required_players: 14,
  joined_players: 14,
  status: 'completed',
  confirmed_at: addDays(nowIso(), -4),
  completed_at: addDays(nowIso(), -3),
});
for (const user of [clients.khaled, clients.yousef, ...extraPlayers]) {
  await db.insert('field_participants', {
    slot_id: pastSlot.id,
    user_id: user.id,
    players_count: 1,
    amount_due: 4.5,
    status: 'joined',
  });
}
await db.insert('reviews', {
  user_id: clients.yousef.id,
  business_id: fieldVenue.id,
  slot_id: pastSlot.id,
  field_id: pitchA.id,
  rating: 5,
  comment: 'أرضية ممتازة والإضاءة قوية. التنظيم كان مرتبًا والمباراة بدأت في وقتها.',
});

// ---------------------------------------------------------------------------
// Section 2 — Men's barber shop (male only)
// ---------------------------------------------------------------------------
console.log('[seed] barber shop');
const barber = await createBusiness({
  section: 'barber',
  owner_id: owners.barber.id,
  name_ar: 'صالون محمود للرجال',
  name_en: 'Mahmoud Men’s Barber',
  description_ar: 'حلاقة رجالية وعناية بالبشرة واللحية، مع باقة خاصة للعريس. ثلاثة كراسي وحلاقون مختصون.',
  description_en: 'Men’s cuts, beard and skin care, plus a dedicated groom’s package. Three chairs with specialist barbers.',
  phone: '0782222222',
  gender_policy: 'male',
  ...PLACES.jubeiha,
  opens_at: '10:00',
  closes_at: '23:00',
  slot_minutes: 30,
  cover_url: 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=1200&q=80',
});

const barberStaff = {
  mahmoud: await db.insert('staff', {
    business_id: barber.id,
    name: 'محمود',
    role_title: 'حلاق أول',
    bio: 'خبرة 12 سنة في الحلاقة الكلاسيكية وقص الذقن.',
    gender: 'male',
    is_active: true,
  }),
  mazen: await db.insert('staff', {
    business_id: barber.id,
    name: 'مازن',
    role_title: 'حلاق',
    bio: 'متخصص في الدرجات الحديثة والفايد.',
    gender: 'male',
    is_active: true,
  }),
  sami: await db.insert('staff', {
    business_id: barber.id,
    name: 'سامي',
    role_title: 'حلاق وعناية بالبشرة',
    gender: 'male',
    is_active: true,
  }),
};

const barberChairs = [];
let chairIndex = 1;
for (const [, member] of Object.entries(barberStaff)) {
  barberChairs.push(
    await db.insert('chairs', {
      business_id: barber.id,
      label: `كرسي ${chairIndex}`,
      position: chairIndex,
      staff_id: member.id,
      is_active: true,
    }),
  );
  chairIndex += 1;
}

const barberServices = {
  haircut: await db.insert('services', {
    business_id: barber.id,
    kind: 'service',
    name_ar: 'قص شعر',
    name_en: 'Haircut',
    price: 7,
    duration_min: 30,
    booking_type: 'regular',
    is_active: true,
  }),
  beard: await db.insert('services', {
    business_id: barber.id,
    kind: 'service',
    name_ar: 'تحديد ذقن',
    name_en: 'Beard trim',
    price: 4,
    duration_min: 20,
    booking_type: 'regular',
    is_active: true,
  }),
  groom: await db.insert('services', {
    business_id: barber.id,
    kind: 'package',
    name_ar: 'باقة العريس',
    name_en: 'Groom’s package',
    description: 'قص وتصفيف، حلاقة كاملة، تنظيف بشرة، وماسك مرطب — تستغرق ساعتين.',
    price: 55,
    discount_percent: 10,
    duration_min: 120,
    booking_type: 'groom',
    is_active: true,
  }),
  cream: await db.insert('services', {
    business_id: barber.id,
    kind: 'product',
    name_ar: 'كريم بشرة',
    name_en: 'Face cream',
    price: 6.5,
    stock_qty: 24,
    duration_min: 5,
    is_active: true,
  }),
  oil: await db.insert('services', {
    business_id: barber.id,
    kind: 'product',
    name_ar: 'زيت شعر',
    name_en: 'Hair oil',
    price: 5,
    discount_percent: 15,
    stock_qty: 30,
    duration_min: 5,
    is_active: true,
  }),
};

// ---------------------------------------------------------------------------
// Section 3 — Women's beauty salon (female only)
// ---------------------------------------------------------------------------
console.log('[seed] beauty salon');
const salon = await createBusiness({
  section: 'salon',
  owner_id: owners.salon.id,
  name_ar: 'صالون ريم للتجميل',
  name_en: 'Reem Beauty Salon',
  description_ar: 'قص وصبغ وتصفيف، مكياج مناسبات، وخدمات أظافر لليدين والقدمين بألوان مختارة.',
  description_en: 'Cutting, colouring and styling, occasion make-up, and nail services for hands and feet with a curated colour range.',
  phone: '0773333333',
  gender_policy: 'female',
  ...PLACES.sweifieh,
  opens_at: '10:00',
  closes_at: '21:00',
  slot_minutes: 30,
  cover_url: 'https://images.unsplash.com/photo-1560066984-138dadb4c035?w=1200&q=80',
});

const salonStaff = {
  reem: await db.insert('staff', {
    business_id: salon.id,
    name: 'ريم',
    role_title: 'كوافيرة ومديرة الصالون',
    bio: 'متخصصة في الصبغات والتسريحات.',
    gender: 'female',
    is_active: true,
  }),
  dana: await db.insert('staff', {
    business_id: salon.id,
    name: 'دانا',
    role_title: 'خبيرة مكياج',
    bio: 'مكياج عرائس ومناسبات.',
    gender: 'female',
    is_active: true,
  }),
  hala: await db.insert('staff', {
    business_id: salon.id,
    name: 'هالة',
    role_title: 'فنية أظافر',
    bio: 'مناكير وبديكير وتركيب أظافر.',
    gender: 'female',
    is_active: true,
  }),
};

for (let i = 1; i <= 4; i += 1) {
  await db.insert('chairs', {
    business_id: salon.id,
    label: `كرسي ${i}`,
    position: i,
    staff_id: [salonStaff.reem.id, salonStaff.dana.id, salonStaff.hala.id, null][i - 1] ?? null,
    is_active: true,
  });
}

const salonServices = {
  cut: await db.insert('services', {
    business_id: salon.id,
    kind: 'service',
    name_ar: 'قص شعر',
    name_en: 'Haircut',
    price: 12,
    duration_min: 45,
    is_active: true,
  }),
  colour: await db.insert('services', {
    business_id: salon.id,
    kind: 'service',
    name_ar: 'صبغة شعر',
    name_en: 'Hair colour',
    price: 35,
    duration_min: 120,
    is_active: true,
  }),
  makeup: await db.insert('services', {
    business_id: salon.id,
    kind: 'service',
    name_ar: 'مكياج مناسبات',
    name_en: 'Occasion make-up',
    price: 40,
    duration_min: 60,
    is_active: true,
  }),
  nailsHands: await db.insert('services', {
    business_id: salon.id,
    kind: 'service',
    name_ar: 'مناكير — أظافر اليدين',
    name_en: 'Manicure — hands',
    price: 10,
    duration_min: 40,
    nail_scope: 'hands',
    is_active: true,
  }),
  nailsFeet: await db.insert('services', {
    business_id: salon.id,
    kind: 'service',
    name_ar: 'بديكير — أظافر القدمين',
    name_en: 'Pedicure — feet',
    price: 12,
    duration_min: 45,
    nail_scope: 'feet',
    is_active: true,
  }),
  nailsBoth: await db.insert('services', {
    business_id: salon.id,
    kind: 'service',
    name_ar: 'مناكير وبديكير — اليدين والقدمين',
    name_en: 'Manicure & pedicure — both',
    price: 20,
    discount_percent: 10,
    duration_min: 80,
    nail_scope: 'both',
    is_active: true,
  }),
  serum: await db.insert('services', {
    business_id: salon.id,
    kind: 'product',
    name_ar: 'سيروم شعر',
    name_en: 'Hair serum',
    price: 9,
    stock_qty: 18,
    duration_min: 5,
    is_active: true,
  }),
};

const polishes = [
  ['أحمر كلاسيكي', 'Classic red', '#C0172B'],
  ['وردي فاتح', 'Soft pink', '#F2A6BD'],
  ['نود', 'Nude', '#D8B49C'],
  ['أسود', 'Black', '#14161C'],
  ['أبيض لؤلؤي', 'Pearl white', '#F4F1EA'],
  ['كحلي', 'Navy', '#1E2A52'],
  ['زيتي', 'Olive', '#6B7A45'],
  ['بنفسجي', 'Violet', '#7A4BC4'],
  ['ذهبي لامع', 'Gold shimmer', '#C9A227'],
  ['عنابي', 'Burgundy', '#5C1A2B'],
];
const nailColors = [];
for (const [ar, en, hex] of polishes) {
  nailColors.push(
    await db.insert('nail_colors', {
      business_id: salon.id,
      name_ar: ar,
      name_en: en,
      hex_code: hex,
      is_active: true,
    }),
  );
}

// ---------------------------------------------------------------------------
// Section 4 — Dental clinic
// ---------------------------------------------------------------------------
console.log('[seed] dental clinic');
const clinic = await createBusiness({
  section: 'dental',
  owner_id: owners.dental.id,
  name_ar: 'عيادة الزعبي لطب الأسنان',
  name_en: 'Al-Zoubi Dental Clinic',
  description_ar: 'عيادة أسنان في إربد تقدم الخلع والحشوات والتنظيف والفينير والفحص، بأسعار ثابتة معلنة.',
  description_en: 'A dental clinic in Irbid offering extractions, fillings, cleaning, veneers and check-ups at published fixed prices.',
  phone: '0794444444',
  ...PLACES.irbid,
  opens_at: '09:00',
  closes_at: '18:00',
  slot_minutes: 30,
  cover_url: 'https://images.unsplash.com/photo-1588776814546-1ffcf47267a5?w=1200&q=80',
});

const dentists = {
  ahmad: await db.insert('staff', {
    business_id: clinic.id,
    name: 'د. أحمد الزعبي',
    role_title: 'طبيب أسنان عام',
    bio: 'اختصاص ترميم وحشوات تجميلية.',
    gender: 'male',
    is_active: true,
  }),
  lana: await db.insert('staff', {
    business_id: clinic.id,
    name: 'د. لانا السعد',
    role_title: 'تجميل أسنان',
    bio: 'فينير وتبييض.',
    gender: 'female',
    is_active: true,
  }),
};

const treatments = [
  ['خلع', 'Extraction', 'extraction', 20, 30],
  ['تركيب حشوة', 'Filling / restoration', 'filling', 25, 45],
  ['تنظيف أسنان', 'Teeth cleaning', 'cleaning', 30, 40],
  ['فينير', 'Veneer', 'veneer', 180, 90],
  ['فحص أسنان فقط', 'Check-up only', 'checkup', 10, 20],
];
const treatmentRows = {};
for (const [ar, en, code, price, duration] of treatments) {
  treatmentRows[code] = await db.insert('services', {
    business_id: clinic.id,
    kind: 'treatment',
    name_ar: ar,
    name_en: en,
    treatment_code: code,
    price,
    duration_min: duration,
    is_active: true,
  });
}

// ---------------------------------------------------------------------------
// Section 5 — Gyms
// ---------------------------------------------------------------------------
console.log('[seed] gyms');
async function createGym({ owner, nameAr, nameEn, place, pointsPerEntry, cover }) {
  const gym = await createBusiness({
    section: 'gym',
    owner_id: owner.id,
    name_ar: nameAr,
    name_en: nameEn,
    description_ar: 'نادٍ رياضي مجهز بأجهزة حديثة وقاعة أوزان حرة وتدريب شخصي، مع خيار الاشتراك الشهري أو الدخول بالنقاط.',
    description_en: 'A gym with modern equipment, a free-weights hall and personal training, with a choice of monthly subscription or point-based entry.',
    phone: owner.phone,
    ...place,
    opens_at: '06:00',
    closes_at: '23:59',
    slot_minutes: 60,
    cover_url: cover,
  });
  await db.insert('gym_settings', {
    business_id: gym.id,
    points_per_entry: pointsPerEntry,
    expiry_months: config.rules.pointsExpiryMonths,
    allows_points: true,
    allows_monthly: true,
    intro_ar:
      'اختر ما يناسبك: اشتراك شهري بزيارات غير محدودة، أو رصيد نقاط يُخصم منه عند كل زيارة. النقاط صالحة لستة أشهر، وإذا شحنت قبل انتهائها يُضاف رصيدك القديم إلى الجديد.',
    intro_en:
      'Pick what suits you: a monthly subscription with unlimited visits, or a point balance deducted on each visit. Points last six months, and topping up before they lapse carries your old balance into the new one.',
  });
  return gym;
}

const gymAmman = await createGym({
  owner: owners.gym,
  nameAr: 'نادي الأسد للياقة',
  nameEn: 'Lion Fitness Amman',
  place: PLACES.amman,
  pointsPerEntry: 2,
  cover: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=1200&q=80',
});
const gymIrbid = await createGym({
  owner: owners.gym2,
  nameAr: 'نادي القوة — إربد',
  nameEn: 'Power Gym Irbid',
  place: PLACES.irbid,
  pointsPerEntry: 1,
  cover: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=1200&q=80',
});
const gymZarqa = await createGym({
  owner: owners.gym,
  nameAr: 'نادي النخبة — الزرقاء',
  nameEn: 'Elite Gym Zarqa',
  place: PLACES.zarqa,
  pointsPerEntry: 2,
  cover: 'https://images.unsplash.com/photo-1540497077202-7c8a3999a953?w=1200&q=80',
});

const trainers = {};
for (const [gym, name, title] of [
  [gymAmman, 'كابتن زيد', 'مدرب شخصي'],
  [gymAmman, 'كابتن رامي', 'مدرب قوة'],
  [gymIrbid, 'كابتن هنادي', 'مدربة لياقة'],
  [gymZarqa, 'كابتن فادي', 'مدرب شخصي'],
]) {
  const row = await db.insert('staff', {
    business_id: gym.id,
    name,
    role_title: title,
    gender: name.includes('هنادي') ? 'female' : 'male',
    is_active: true,
  });
  trainers[name] = row;
}

for (const gym of [gymAmman, gymIrbid, gymZarqa]) {
  await db.insert('gym_plans', {
    business_id: gym.id,
    name_ar: 'اشتراك شهري',
    name_en: 'Monthly membership',
    kind: 'monthly',
    price: gym.id === gymAmman.id ? 35 : 25,
    duration_days: 30,
    description: 'زيارات غير محدودة لمدة 30 يومًا.',
    is_active: true,
  });
  await db.insert('gym_plans', {
    business_id: gym.id,
    name_ar: 'اشتراك 3 أشهر',
    name_en: 'Three-month membership',
    kind: 'monthly',
    price: gym.id === gymAmman.id ? 90 : 65,
    duration_days: 90,
    description: 'زيارات غير محدودة لمدة 90 يومًا بسعر مخفّض.',
    is_active: true,
  });
}
await db.insert('gym_plans', {
  business_id: gymAmman.id,
  name_ar: 'تدريب شخصي — 8 حصص',
  name_en: 'Personal training — 8 sessions',
  kind: 'private_training',
  price: 120,
  duration_days: 45,
  sessions_included: 8,
  trainer_id: trainers['كابتن زيد'].id,
  description: 'ثماني حصص تدريب شخصي مع الكابتن زيد، تشمل خطة تدريب وتغذية.',
  is_active: true,
});
await db.insert('gym_plans', {
  business_id: gymIrbid.id,
  name_ar: 'تدريب شخصي — 4 حصص',
  name_en: 'Personal training — 4 sessions',
  kind: 'private_training',
  price: 55,
  duration_days: 30,
  sessions_included: 4,
  trainer_id: trainers['كابتن هنادي'].id,
  is_active: true,
});

const packages = {};
for (const gym of [gymAmman, gymIrbid, gymZarqa]) {
  const scale = gym.id === gymAmman.id ? 1 : 0.8;
  packages[gym.id] = [
    await db.insert('point_packages', {
      business_id: gym.id,
      name_ar: 'رصيد 10 نقاط',
      name_en: '10 points',
      points: 10,
      bonus_points: 0,
      price: Math.round(12 * scale * 100) / 100,
      is_active: true,
    }),
    await db.insert('point_packages', {
      business_id: gym.id,
      name_ar: 'رصيد 25 نقطة',
      name_en: '25 points',
      points: 25,
      bonus_points: 3,
      price: Math.round(28 * scale * 100) / 100,
      is_active: true,
    }),
    await db.insert('point_packages', {
      business_id: gym.id,
      name_ar: 'رصيد 60 نقطة',
      name_en: '60 points',
      points: 60,
      bonus_points: 10,
      price: Math.round(60 * scale * 100) / 100,
      is_active: true,
    }),
  ];
}

// A wallet with history: an older purchase that rolled over into a newer one.
console.log('[seed] point wallets');
const oldPurchaseAt = addMonths(nowIso(), -2);
const oldLot = await db.insert('point_lots', {
  user_id: clients.khaled.id,
  business_id: gymAmman.id,
  package_id: packages[gymAmman.id][0].id,
  points_purchased: 10,
  points_rolled_in: 0,
  points_remaining: 0,
  price_paid: 12,
  purchased_at: oldPurchaseAt,
  expires_at: addMonths(oldPurchaseAt, config.rules.pointsExpiryMonths),
  status: 'rolled_over',
});
const newPurchaseAt = addDays(nowIso(), -10);
const newLot = await db.insert('point_lots', {
  user_id: clients.khaled.id,
  business_id: gymAmman.id,
  package_id: packages[gymAmman.id][1].id,
  points_purchased: 28,
  points_rolled_in: 4,
  points_remaining: 26,
  price_paid: 28,
  purchased_at: newPurchaseAt,
  expires_at: addMonths(newPurchaseAt, config.rules.pointsExpiryMonths),
  status: 'active',
});
await db.run('UPDATE point_lots SET rolled_into_lot_id = ? WHERE id = ?', [newLot.id, oldLot.id]);

let balance = 0;
const ledger = [
  [oldLot.id, 'purchase', 10, 'رصيد 10 نقاط'],
  [oldLot.id, 'entry', -3, 'دخول النادي'],
  [oldLot.id, 'entry', -3, 'دخول النادي'],
  [oldLot.id, 'rollover_out', -4, `Rolled into lot #${newLot.id}`],
  [newLot.id, 'rollover_in', 4, 'Carried over from 1 earlier purchase'],
  [newLot.id, 'purchase', 25, 'رصيد 25 نقطة'],
  [newLot.id, 'bonus', 3, 'Bonus points'],
  [newLot.id, 'entry', -2, 'دخول النادي'],
  [newLot.id, 'entry', -2, 'دخول النادي'],
  [newLot.id, 'entry', -2, 'دخول النادي'],
];
for (const [lotId, kind, points, note] of ledger) {
  balance = kind === 'rollover_out' ? 0 : balance + points;
  if (kind === 'rollover_in') balance = points;
  await db.insert('point_transactions', {
    user_id: clients.khaled.id,
    business_id: gymAmman.id,
    lot_id: lotId,
    kind,
    points,
    balance_after: Math.max(0, balance),
    note,
  });
}
await db.insert('transactions', {
  user_id: clients.khaled.id,
  business_id: gymAmman.id,
  lot_id: newLot.id,
  kind: 'points_purchase',
  amount: 28,
  currency: config.rules.currency,
  method: 'card',
  status: 'paid',
  note: '28 points',
});

// A balance at the Irbid gym that expires soon, so the warning state is visible.
const expiringAt = addMonths(addDays(nowIso(), -155), config.rules.pointsExpiryMonths);
await db.insert('point_lots', {
  user_id: clients.salma.id,
  business_id: gymIrbid.id,
  package_id: packages[gymIrbid.id][0].id,
  points_purchased: 10,
  points_remaining: 6,
  price_paid: 9.6,
  purchased_at: addDays(nowIso(), -155),
  expires_at: expiringAt,
  status: 'active',
});
await db.insert('point_transactions', {
  user_id: clients.salma.id,
  business_id: gymIrbid.id,
  kind: 'purchase',
  points: 10,
  balance_after: 10,
  note: 'رصيد 10 نقاط',
});

// An active monthly subscription.
const subStart = dateOnly(addDays(nowIso(), -8));
const monthlyPlan = await db.get(
  "SELECT * FROM gym_plans WHERE business_id = ? AND kind = 'monthly' ORDER BY price LIMIT 1",
  [gymAmman.id],
);
const sub = await db.insert('subscriptions', {
  user_id: clients.yousef.id,
  business_id: gymAmman.id,
  plan_id: monthlyPlan.id,
  starts_on: subStart,
  ends_on: dateOnly(addDays(`${subStart}T00:00:00.000Z`, 29)),
  amount_paid: Number(monthlyPlan.price),
  status: 'active',
});
await db.insert('transactions', {
  user_id: clients.yousef.id,
  business_id: gymAmman.id,
  subscription_id: sub.id,
  kind: 'subscription_payment',
  amount: Number(monthlyPlan.price),
  currency: config.rules.currency,
  method: 'card',
  status: 'paid',
  note: monthlyPlan.name_ar,
});

// ---------------------------------------------------------------------------
// Bookings — upcoming, and completed ones that can now be rated
// ---------------------------------------------------------------------------
console.log('[seed] bookings and reviews');

async function seedBooking({
  business,
  client,
  staff,
  chair,
  startsAt,
  durationMin,
  items,
  status = 'confirmed',
  bookingType,
  nailScope,
  treatmentCode,
  colours,
  paymentMethod = 'cash',
}) {
  const total = items.reduce(
    (sum, [service, qty = 1]) =>
      sum + Math.round(Number(service.price) * (1 - Number(service.discount_percent || 0) / 100) * qty * 100) / 100,
    0,
  );
  const booking = await db.insert('bookings', {
    reference: randomReference(),
    business_id: business.id,
    client_id: client.id,
    section: business.section,
    staff_id: staff?.id ?? null,
    chair_id: chair?.id ?? null,
    starts_at: startsAt,
    ends_at: new Date(new Date(startsAt).getTime() + durationMin * 60000).toISOString(),
    booking_type: bookingType ?? null,
    nail_scope: nailScope ?? null,
    treatment_code: treatmentCode ?? null,
    status,
    total_amount: Math.round(total * 100) / 100,
    payment_method: paymentMethod,
    points_spent: 0,
    completed_at: status === 'completed' ? startsAt : null,
  });
  for (const [service, qty = 1] of items) {
    const unit = Math.round(Number(service.price) * (1 - Number(service.discount_percent || 0) / 100) * 100) / 100;
    await db.insert('booking_items', {
      booking_id: booking.id,
      service_id: service.id,
      label: service.name_ar,
      unit_price: unit,
      qty,
      line_total: Math.round(unit * qty * 100) / 100,
    });
  }
  for (const [colour, placement] of colours || []) {
    await db.insert('booking_nail_colors', {
      booking_id: booking.id,
      nail_color_id: colour.id,
      placement,
    });
  }
  await db.insert('transactions', {
    user_id: client.id,
    business_id: business.id,
    booking_id: booking.id,
    kind: 'booking_payment',
    amount: Math.round(total * 100) / 100,
    currency: config.rules.currency,
    method: paymentMethod,
    status: status === 'completed' ? 'paid' : 'pending',
    note: booking.reference,
  });
  return booking;
}

const tomorrow = dateOnly(addDays(nowIso(), 1));
const yesterday = dateOnly(addDays(nowIso(), -2));

// Barber — upcoming regular cut, and a completed groom's package to rate.
await seedBooking({
  business: barber,
  client: clients.khaled,
  staff: barberStaff.mazen,
  chair: barberChairs[1],
  startsAt: `${tomorrow}T17:00:00.000Z`,
  durationMin: 30,
  items: [[barberServices.haircut]],
  bookingType: 'regular',
});
const completedGroom = await seedBooking({
  business: barber,
  client: clients.yousef,
  staff: barberStaff.mahmoud,
  chair: barberChairs[0],
  startsAt: `${yesterday}T15:00:00.000Z`,
  durationMin: 120,
  items: [[barberServices.groom]],
  bookingType: 'groom',
  status: 'completed',
});
await db.insert('reviews', {
  user_id: clients.yousef.id,
  business_id: barber.id,
  booking_id: completedGroom.id,
  staff_id: barberStaff.mahmoud.id,
  rating: 5,
  staff_rating: 5,
  comment: 'باقة العريس كانت ممتازة والاهتمام بالتفاصيل واضح. محمود دقيق جدًا في عمله.',
});

// Salon — upcoming nails on both hands and feet with chosen colours, plus a
// completed colour appointment awaiting a rating.
await seedBooking({
  business: salon,
  client: clients.nour,
  staff: salonStaff.hala,
  startsAt: `${tomorrow}T12:00:00.000Z`,
  durationMin: 80,
  items: [[salonServices.nailsBoth]],
  nailScope: 'both',
  colours: [
    [nailColors[0], 'hands'],
    [nailColors[9], 'feet'],
  ],
});
const completedColour = await seedBooking({
  business: salon,
  client: clients.salma,
  staff: salonStaff.reem,
  startsAt: `${yesterday}T11:00:00.000Z`,
  durationMin: 120,
  items: [[salonServices.colour]],
  status: 'completed',
});
await db.insert('reviews', {
  user_id: clients.salma.id,
  business_id: salon.id,
  booking_id: completedColour.id,
  staff_id: salonStaff.reem.id,
  rating: 4,
  staff_rating: 5,
  comment: 'النتيجة جميلة جدًا والصبغة ثابتة. الانتظار كان أطول من المتوقع قليلًا.',
});

// Dental — an upcoming filling and a completed cleaning.
await seedBooking({
  business: clinic,
  client: clients.yousef,
  staff: dentists.ahmad,
  startsAt: `${tomorrow}T10:00:00.000Z`,
  durationMin: 45,
  items: [[treatmentRows.filling]],
  treatmentCode: 'filling',
});
const completedCleaning = await seedBooking({
  business: clinic,
  client: clients.khaled,
  staff: dentists.ahmad,
  startsAt: `${yesterday}T09:30:00.000Z`,
  durationMin: 40,
  items: [[treatmentRows.cleaning]],
  treatmentCode: 'cleaning',
  status: 'completed',
});
await db.insert('reviews', {
  user_id: clients.khaled.id,
  business_id: clinic.id,
  booking_id: completedCleaning.id,
  staff_id: dentists.ahmad.id,
  rating: 5,
  staff_rating: 5,
  comment: 'تنظيف مريح بدون أي ألم، والعيادة نظيفة ومرتبة.',
});

// Refresh the cached rating aggregates the seeded reviews affect.
const { refreshAggregates } = await import('../services/ratings.js');
for (const business of [fieldVenue, barber, salon, clinic]) {
  const staffRows = await db.all('SELECT id FROM staff WHERE business_id = ?', [business.id]);
  await refreshAggregates(db, { businessId: business.id });
  for (const row of staffRows) {
    await refreshAggregates(db, { businessId: business.id, staffId: Number(row.id) });
  }
}
await refreshAggregates(db, { businessId: fieldVenue.id, fieldId: pitchA.id });

// Working hours: closed on Friday across the board.
for (const business of [barber, salon, clinic]) {
  await db.insert('business_hours', {
    business_id: business.id,
    weekday: 5,
    is_closed: true,
  });
}

await db.insert('audit_log', {
  actor_id: admin.id,
  action: 'seed',
  entity: 'platform',
  entity_id: null,
  meta: JSON.stringify({ note: 'Initial seed dataset' }),
});

const counts = {};
for (const table of [
  'users',
  'businesses',
  'fields',
  'field_slots',
  'field_participants',
  'services',
  'staff',
  'chairs',
  'nail_colors',
  'bookings',
  'reviews',
  'point_lots',
  'point_packages',
  'gym_plans',
  'subscriptions',
  'transactions',
]) {
  counts[table] = Number(await db.value(`SELECT COUNT(*) AS c FROM ${table}`));
}

console.log('\n[seed] done');
console.table(counts);
console.log(`
  Sign in with:
    admin    ${config.seed.adminEmail} / ${config.seed.adminPassword}
    owners   fields@ · barber@ · salon@ · clinic@ · gym@ · gym2@youandme.jo / ${config.seed.defaultPassword}
    clients  khaled@ · yousef@example.com (male)   nour@ · salma@example.com (female)  / ${config.seed.defaultPassword}

  salma@example.com is in Irbid — useful for trying the nearby-gym distances.
`);

await closeDb();
