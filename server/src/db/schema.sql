-- ============================================================================
-- you&me — relational schema (single source of truth for both dialects)
--
-- Written in a dialect-neutral subset. `dialect.js` substitutes the {{...}}
-- placeholders so PostgreSQL and SQLite are generated from this one file and
-- cannot drift apart.
--
--   {{PK}}    identity primary key
--   {{FK}}    integer type used by foreign key columns
--   {{TS}}    timestamp type
--   {{NOW}}   current timestamp expression
--   {{BOOL}}  boolean type           {{TRUE}} / {{FALSE}}  boolean literals
--   {{MONEY}} fixed-point money type
--   {{JSON}}  JSON document type
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              {{PK}},
  full_name       TEXT        NOT NULL,
  email           TEXT        NOT NULL UNIQUE,
  phone           TEXT,
  password_hash   TEXT        NOT NULL,
  role            TEXT        NOT NULL DEFAULT 'client'
                  CHECK (role IN ('admin', 'owner', 'client')),
  -- Gender gates access to the men's barber shop and women's beauty salon.
  gender          TEXT        NOT NULL
                  CHECK (gender IN ('male', 'female')),
  birth_date      DATE,
  locale          TEXT        NOT NULL DEFAULT 'ar'
                  CHECK (locale IN ('ar', 'en')),
  governorate     TEXT,
  city            TEXT,
  address         TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  is_active       {{BOOL}}    NOT NULL DEFAULT {{TRUE}},
  last_login_at   {{TS}},
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}},
  updated_at      {{TS}}      NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_gender ON users (gender);

-- Refresh tokens are stored hashed so a database leak cannot mint sessions.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              {{PK}},
  user_id         {{FK}}      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash      TEXT        NOT NULL UNIQUE,
  user_agent      TEXT,
  expires_at      {{TS}}      NOT NULL,
  revoked_at      {{TS}},
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Businesses (one row per listed business in any of the five sections)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS businesses (
  id              {{PK}},
  section         TEXT        NOT NULL
                  CHECK (section IN ('sports_field', 'barber', 'salon', 'dental', 'gym')),
  owner_id        {{FK}}      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name_ar         TEXT        NOT NULL,
  name_en         TEXT,
  description_ar  TEXT,
  description_en  TEXT,
  phone           TEXT,
  governorate     TEXT,
  city            TEXT,
  address         TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  map_url         TEXT,
  cover_url       TEXT,
  -- 'male' for barber shops, 'female' for beauty salons, 'any' elsewhere.
  gender_policy   TEXT        NOT NULL DEFAULT 'any'
                  CHECK (gender_policy IN ('any', 'male', 'female')),
  opens_at        TEXT        NOT NULL DEFAULT '09:00',
  closes_at       TEXT        NOT NULL DEFAULT '21:00',
  slot_minutes    INTEGER     NOT NULL DEFAULT 30 CHECK (slot_minutes > 0),
  is_active       {{BOOL}}    NOT NULL DEFAULT {{TRUE}},
  rating_avg      {{MONEY}}   NOT NULL DEFAULT 0,
  rating_count    INTEGER     NOT NULL DEFAULT 0,
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}},
  updated_at      {{TS}}      NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_businesses_section ON businesses (section);
CREATE INDEX IF NOT EXISTS idx_businesses_owner ON businesses (owner_id);
CREATE INDEX IF NOT EXISTS idx_businesses_geo ON businesses (lat, lng);

-- Per-weekday opening hours; a missing row falls back to the business default.
CREATE TABLE IF NOT EXISTS business_hours (
  id              {{PK}},
  business_id     {{FK}}      NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  weekday         INTEGER     NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  is_closed       {{BOOL}}    NOT NULL DEFAULT {{FALSE}},
  opens_at        TEXT,
  closes_at       TEXT,
  UNIQUE (business_id, weekday)
);

-- Barbers, hairdressers, makeup artists, dentists, personal trainers.
CREATE TABLE IF NOT EXISTS staff (
  id              {{PK}},
  business_id     {{FK}}      NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  role_title      TEXT,
  bio             TEXT,
  photo_url       TEXT,
  gender          TEXT        CHECK (gender IN ('male', 'female')),
  is_active       {{BOOL}}    NOT NULL DEFAULT {{TRUE}},
  rating_avg      {{MONEY}}   NOT NULL DEFAULT 0,
  rating_count    INTEGER     NOT NULL DEFAULT 0,
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_staff_business ON staff (business_id);

-- Barber chairs / salon stations. A chair may be tied to one staff member.
CREATE TABLE IF NOT EXISTS chairs (
  id              {{PK}},
  business_id     {{FK}}      NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  label           TEXT        NOT NULL,
  position        INTEGER     NOT NULL DEFAULT 1,
  staff_id        {{FK}}      REFERENCES staff (id) ON DELETE SET NULL,
  is_active       {{BOOL}}    NOT NULL DEFAULT {{TRUE}},
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}},
  UNIQUE (business_id, label)
);

-- Bookable services, retail products, dental treatments, barber packages.
CREATE TABLE IF NOT EXISTS services (
  id                {{PK}},
  business_id       {{FK}}    NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  kind              TEXT      NOT NULL DEFAULT 'service'
                    CHECK (kind IN ('service', 'product', 'treatment', 'package', 'training')),
  name_ar           TEXT      NOT NULL,
  name_en           TEXT,
  description       TEXT,
  price             {{MONEY}} NOT NULL DEFAULT 0 CHECK (price >= 0),
  discount_percent  INTEGER   NOT NULL DEFAULT 0
                    CHECK (discount_percent BETWEEN 0 AND 100),
  duration_min      INTEGER   NOT NULL DEFAULT 30 CHECK (duration_min > 0),
  -- Dental: which fixed-price treatment this row represents.
  treatment_code    TEXT      CHECK (treatment_code IN
                      ('extraction', 'filling', 'cleaning', 'veneer', 'checkup')),
  -- Barber: regular haircut vs groom's package (عريس).
  booking_type      TEXT      CHECK (booking_type IN ('regular', 'groom')),
  -- Salon: whether this service involves nail work, and where.
  nail_scope        TEXT      CHECK (nail_scope IN ('hands', 'feet', 'both')),
  stock_qty         INTEGER,
  is_active         {{BOOL}}  NOT NULL DEFAULT {{TRUE}},
  created_at        {{TS}}    NOT NULL DEFAULT {{NOW}},
  updated_at        {{TS}}    NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_services_business ON services (business_id, kind);

-- Salon nail polish palette, defined per salon by its owner.
CREATE TABLE IF NOT EXISTS nail_colors (
  id              {{PK}},
  business_id     {{FK}}      NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  name_ar         TEXT        NOT NULL,
  name_en         TEXT,
  hex_code        TEXT        NOT NULL,
  is_active       {{BOOL}}    NOT NULL DEFAULT {{TRUE}},
  UNIQUE (business_id, hex_code)
);

-- ---------------------------------------------------------------------------
-- Section 1 — Sports fields
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fields (
  id                {{PK}},
  business_id       {{FK}}    NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  name              TEXT      NOT NULL,
  surface           TEXT      CHECK (surface IN ('grass', 'artificial', 'indoor', 'sand')),
  size_label        TEXT,
  -- Owner-defined price charged per participating person.
  price_per_person  {{MONEY}} NOT NULL DEFAULT 0 CHECK (price_per_person >= 0),
  -- A match confirms once this quota of players is reached (default 14).
  required_players  INTEGER   NOT NULL DEFAULT 14 CHECK (required_players > 1),
  -- Free-text description, capped at 200 words by the API layer.
  description       TEXT,
  is_active         {{BOOL}}  NOT NULL DEFAULT {{TRUE}},
  rating_avg        {{MONEY}} NOT NULL DEFAULT 0,
  rating_count      INTEGER   NOT NULL DEFAULT 0,
  created_at        {{TS}}    NOT NULL DEFAULT {{NOW}},
  updated_at        {{TS}}    NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_fields_business ON fields (business_id);

-- One bookable session on a field (e.g. a 1.5-hour slot).
CREATE TABLE IF NOT EXISTS field_slots (
  id                {{PK}},
  field_id          {{FK}}    NOT NULL REFERENCES fields (id) ON DELETE CASCADE,
  starts_at         {{TS}}    NOT NULL,
  ends_at           {{TS}}    NOT NULL,
  duration_min      INTEGER   NOT NULL DEFAULT 90 CHECK (duration_min > 0),
  price_per_person  {{MONEY}} NOT NULL DEFAULT 0 CHECK (price_per_person >= 0),
  required_players  INTEGER   NOT NULL DEFAULT 14 CHECK (required_players > 1),
  joined_players    INTEGER   NOT NULL DEFAULT 0 CHECK (joined_players >= 0),
  status            TEXT      NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'confirmed', 'completed', 'cancelled')),
  confirmed_at      {{TS}},
  completed_at      {{TS}},
  created_at        {{TS}}    NOT NULL DEFAULT {{NOW}},
  UNIQUE (field_id, starts_at)
);
CREATE INDEX IF NOT EXISTS idx_slots_field_time ON field_slots (field_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_slots_status ON field_slots (status);

CREATE TABLE IF NOT EXISTS field_participants (
  id              {{PK}},
  slot_id         {{FK}}      NOT NULL REFERENCES field_slots (id) ON DELETE CASCADE,
  user_id         {{FK}}      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  players_count   INTEGER     NOT NULL DEFAULT 1 CHECK (players_count > 0),
  amount_due      {{MONEY}}   NOT NULL DEFAULT 0,
  status          TEXT        NOT NULL DEFAULT 'joined'
                  CHECK (status IN ('joined', 'cancelled')),
  joined_at       {{TS}}      NOT NULL DEFAULT {{NOW}},
  cancelled_at    {{TS}},
  UNIQUE (slot_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_user ON field_participants (user_id);

-- ---------------------------------------------------------------------------
-- Bookings (barber, salon, dental, gym sessions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id              {{PK}},
  reference       TEXT        NOT NULL UNIQUE,
  business_id     {{FK}}      NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  client_id       {{FK}}      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  section         TEXT        NOT NULL
                  CHECK (section IN ('sports_field', 'barber', 'salon', 'dental', 'gym')),
  staff_id        {{FK}}      REFERENCES staff (id) ON DELETE SET NULL,
  chair_id        {{FK}}      REFERENCES chairs (id) ON DELETE SET NULL,
  slot_id         {{FK}}      REFERENCES field_slots (id) ON DELETE SET NULL,
  starts_at       {{TS}}      NOT NULL,
  ends_at         {{TS}}      NOT NULL,
  -- Barber: regular haircut vs groom's package.
  booking_type    TEXT        CHECK (booking_type IN ('regular', 'groom')),
  -- Salon nails: hands, feet, or both.
  nail_scope      TEXT        CHECK (nail_scope IN ('hands', 'feet', 'both')),
  -- Dental: the selected procedure.
  treatment_code  TEXT        CHECK (treatment_code IN
                    ('extraction', 'filling', 'cleaning', 'veneer', 'checkup')),
  status          TEXT        NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled', 'no_show')),
  total_amount    {{MONEY}}   NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  payment_method  TEXT        NOT NULL DEFAULT 'cash'
                  CHECK (payment_method IN ('cash', 'card', 'points', 'subscription')),
  points_spent    INTEGER     NOT NULL DEFAULT 0 CHECK (points_spent >= 0),
  notes           TEXT,
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}},
  updated_at      {{TS}}      NOT NULL DEFAULT {{NOW}},
  completed_at    {{TS}},
  cancelled_at    {{TS}}
);
CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings (client_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_business ON bookings (business_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_staff_time ON bookings (staff_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_chair_time ON bookings (chair_id, starts_at);

CREATE TABLE IF NOT EXISTS booking_items (
  id              {{PK}},
  booking_id      {{FK}}      NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  service_id      {{FK}}      REFERENCES services (id) ON DELETE SET NULL,
  label           TEXT        NOT NULL,
  unit_price      {{MONEY}}   NOT NULL DEFAULT 0,
  qty             INTEGER     NOT NULL DEFAULT 1 CHECK (qty > 0),
  line_total      {{MONEY}}   NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items (booking_id);

-- Exact polish colours chosen for a nail booking, per placement.
CREATE TABLE IF NOT EXISTS booking_nail_colors (
  id              {{PK}},
  booking_id      {{FK}}      NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  nail_color_id   {{FK}}      NOT NULL REFERENCES nail_colors (id) ON DELETE CASCADE,
  placement       TEXT        NOT NULL CHECK (placement IN ('hands', 'feet')),
  UNIQUE (booking_id, nail_color_id, placement)
);

-- ---------------------------------------------------------------------------
-- Section 5 — Gyms: subscriptions, point store, expiring point lots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gym_settings (
  business_id       {{FK}}    PRIMARY KEY REFERENCES businesses (id) ON DELETE CASCADE,
  -- Points deducted per gym entry, defined by the gym owner.
  points_per_entry  INTEGER   NOT NULL DEFAULT 1 CHECK (points_per_entry > 0),
  -- Purchased points expire this many months after purchase (platform default 6).
  expiry_months     INTEGER   NOT NULL DEFAULT 6 CHECK (expiry_months > 0),
  allows_points     {{BOOL}}  NOT NULL DEFAULT {{TRUE}},
  allows_monthly    {{BOOL}}  NOT NULL DEFAULT {{TRUE}},
  intro_ar          TEXT,
  intro_en          TEXT
);

CREATE TABLE IF NOT EXISTS gym_plans (
  id                {{PK}},
  business_id       {{FK}}    NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  name_ar           TEXT      NOT NULL,
  name_en           TEXT,
  kind              TEXT      NOT NULL DEFAULT 'monthly'
                    CHECK (kind IN ('monthly', 'private_training')),
  price             {{MONEY}} NOT NULL DEFAULT 0 CHECK (price >= 0),
  duration_days     INTEGER   NOT NULL DEFAULT 30 CHECK (duration_days > 0),
  sessions_included INTEGER,
  trainer_id        {{FK}}    REFERENCES staff (id) ON DELETE SET NULL,
  description       TEXT,
  is_active         {{BOOL}}  NOT NULL DEFAULT {{TRUE}},
  created_at        {{TS}}    NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_gym_plans_business ON gym_plans (business_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id              {{PK}},
  user_id         {{FK}}      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  business_id     {{FK}}      NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  plan_id         {{FK}}      REFERENCES gym_plans (id) ON DELETE SET NULL,
  starts_on       DATE        NOT NULL,
  ends_on         DATE        NOT NULL,
  amount_paid     {{MONEY}}   NOT NULL DEFAULT 0,
  sessions_left   INTEGER,
  status          TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'expired', 'cancelled')),
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions (user_id, status);

-- Point bundles a gym owner sells in that gym's store.
CREATE TABLE IF NOT EXISTS point_packages (
  id              {{PK}},
  business_id     {{FK}}      NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  name_ar         TEXT        NOT NULL,
  name_en         TEXT,
  points          INTEGER     NOT NULL CHECK (points > 0),
  bonus_points    INTEGER     NOT NULL DEFAULT 0 CHECK (bonus_points >= 0),
  price           {{MONEY}}   NOT NULL CHECK (price >= 0),
  is_active       {{BOOL}}    NOT NULL DEFAULT {{TRUE}},
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_point_packages_business ON point_packages (business_id);

-- Each purchase creates a lot with its own expiry date. When a client buys
-- again before an existing lot expires, the remaining points of that lot roll
-- over into the new lot (status 'rolled_over') and share the new expiry.
CREATE TABLE IF NOT EXISTS point_lots (
  id                  {{PK}},
  user_id             {{FK}}  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  business_id         {{FK}}  NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  package_id          {{FK}}  REFERENCES point_packages (id) ON DELETE SET NULL,
  points_purchased    INTEGER NOT NULL CHECK (points_purchased >= 0),
  points_rolled_in    INTEGER NOT NULL DEFAULT 0 CHECK (points_rolled_in >= 0),
  points_remaining    INTEGER NOT NULL CHECK (points_remaining >= 0),
  price_paid          {{MONEY}} NOT NULL DEFAULT 0,
  purchased_at        {{TS}}  NOT NULL DEFAULT {{NOW}},
  expires_at          {{TS}}  NOT NULL,
  rolled_into_lot_id  {{FK}}  REFERENCES point_lots (id) ON DELETE SET NULL,
  status              TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'expired', 'consumed', 'rolled_over')),
  created_at          {{TS}}  NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_lots_user_business ON point_lots (user_id, business_id, status);
CREATE INDEX IF NOT EXISTS idx_lots_expiry ON point_lots (expires_at, status);

-- Append-only ledger: every point movement, with the running balance.
CREATE TABLE IF NOT EXISTS point_transactions (
  id              {{PK}},
  user_id         {{FK}}      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  business_id     {{FK}}      NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  lot_id          {{FK}}      REFERENCES point_lots (id) ON DELETE SET NULL,
  booking_id      {{FK}}      REFERENCES bookings (id) ON DELETE SET NULL,
  kind            TEXT        NOT NULL
                  CHECK (kind IN ('purchase', 'bonus', 'entry', 'rollover_in',
                                  'rollover_out', 'expiry', 'adjustment', 'refund')),
  points          INTEGER     NOT NULL,
  balance_after   INTEGER     NOT NULL,
  note            TEXT,
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_point_tx_user ON point_transactions (user_id, business_id, created_at);

-- ---------------------------------------------------------------------------
-- Money ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id              {{PK}},
  user_id         {{FK}}      REFERENCES users (id) ON DELETE SET NULL,
  business_id     {{FK}}      REFERENCES businesses (id) ON DELETE SET NULL,
  booking_id      {{FK}}      REFERENCES bookings (id) ON DELETE SET NULL,
  subscription_id {{FK}}      REFERENCES subscriptions (id) ON DELETE SET NULL,
  lot_id          {{FK}}      REFERENCES point_lots (id) ON DELETE SET NULL,
  slot_id         {{FK}}      REFERENCES field_slots (id) ON DELETE SET NULL,
  kind            TEXT        NOT NULL
                  CHECK (kind IN ('booking_payment', 'field_payment', 'points_purchase',
                                  'subscription_payment', 'refund')),
  amount          {{MONEY}}   NOT NULL,
  currency        TEXT        NOT NULL DEFAULT 'JOD',
  method          TEXT        NOT NULL DEFAULT 'cash'
                  CHECK (method IN ('cash', 'card', 'points', 'subscription')),
  status          TEXT        NOT NULL DEFAULT 'paid'
                  CHECK (status IN ('pending', 'paid', 'refunded', 'failed')),
  note            TEXT,
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_tx_business ON transactions (business_id, created_at);

-- ---------------------------------------------------------------------------
-- Reviews — only ever written against something already completed
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id              {{PK}},
  user_id         {{FK}}      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  business_id     {{FK}}      NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  booking_id      {{FK}}      REFERENCES bookings (id) ON DELETE CASCADE,
  slot_id         {{FK}}      REFERENCES field_slots (id) ON DELETE CASCADE,
  field_id        {{FK}}      REFERENCES fields (id) ON DELETE CASCADE,
  staff_id        {{FK}}      REFERENCES staff (id) ON DELETE SET NULL,
  rating          INTEGER     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  staff_rating    INTEGER     CHECK (staff_rating BETWEEN 1 AND 5),
  comment         TEXT,
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}},
  -- A review always points at a completed booking or a completed field slot.
  CHECK (booking_id IS NOT NULL OR slot_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_booking ON reviews (booking_id)
  WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_slot_user ON reviews (slot_id, user_id)
  WHERE slot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_business ON reviews (business_id);
CREATE INDEX IF NOT EXISTS idx_reviews_staff ON reviews (staff_id);

-- ---------------------------------------------------------------------------
-- Admin audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id              {{PK}},
  actor_id        {{FK}}      REFERENCES users (id) ON DELETE SET NULL,
  action          TEXT        NOT NULL,
  entity          TEXT        NOT NULL,
  entity_id       TEXT,
  meta            {{JSON}},
  ip              TEXT,
  created_at      {{TS}}      NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
