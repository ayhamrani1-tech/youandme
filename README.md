# you&me

A booking platform for five kinds of business in Jordan: sports fields, men's
barber shops, women's beauty salons, dental clinics and gyms. Arabic-first with
a one-click switch to English, three roles (admin, owner, customer), and a
PostgreSQL database.

```
youandme/
├── server/          API — Node 22, no runtime framework
│   ├── src/
│   │   ├── db/      schema, dual-dialect adapters, migrations, seed
│   │   ├── lib/     router, security, validation, time & geo, serializers
│   │   ├── middleware/   auth and RBAC, security headers, CORS, rate limit
│   │   ├── routes/  auth · me · businesses · fields · gyms · bookings · reviews · admin
│   │   └── services/     points, bookings, field sessions, ratings, availability
│   └── tests/       126 tests, run against SQLite and PostgreSQL
├── web/             Client — React 19 + Tailwind v4, bundled with esbuild
│   └── src/pages/   landing, auth, five sections, dashboards, consoles
└── docs/            design notes, API reference
```

## Running it

Requires **Node 22.5 or newer** (the SQLite fallback uses the built-in
`node:sqlite`).

```bash
npm install
npm run db:reset     # create the schema and load the seed data
npm run dev          # API on :4000, web on :5173
```

Open <http://localhost:5173>. The web dev server proxies `/api` to the API, so
there is nothing else to configure.

For a single-process production run:

```bash
npm run build        # bundles the client into web/dist
npm start            # API serves the API and the built client on :4000
```

### Database

SQLite is the default so the project runs with no setup. Point it at PostgreSQL
by setting two variables:

```bash
DB_DRIVER=postgres
DATABASE_URL=postgres://user:password@localhost:5432/youandme
```

```bash
docker compose up -d db     # a local Postgres, if you want one
npm run db:reset
```

The schema lives in `server/src/db/schema.sql` as a single dialect-neutral file;
`dialect.js` renders it for whichever engine is configured, so the two can never
drift apart. The Postgres adapter uses the standard `pg` package when it is
installed and otherwise falls back to a small built-in wire-protocol driver, so
the project still runs against PostgreSQL in environments where dependencies
cannot be installed.

### Sign-in details after seeding

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@youandme.jo` | `Admin@12345` |
| Owner — sports fields | `fields@youandme.jo` | `Passw0rd!` |
| Owner — barber | `barber@youandme.jo` | `Passw0rd!` |
| Owner — salon | `salon@youandme.jo` | `Passw0rd!` |
| Owner — dental clinic | `clinic@youandme.jo` | `Passw0rd!` |
| Owner — gyms | `gym@youandme.jo` · `gym2@youandme.jo` | `Passw0rd!` |
| Customer (male) | `khaled@example.com` · `yousef@example.com` | `Passw0rd!` |
| Customer (female) | `nour@example.com` · `salma@example.com` | `Passw0rd!` |

`salma@example.com` is in Irbid, which makes the distances on the nearby-gyms
screen worth looking at. `khaled@example.com` has a gym balance with a rollover
already in its history.

## How the five sections work

**Sports fields.** An owner publishes sessions on a pitch — a time, a length and
a price *per person*. Customers join individually, and the match confirms
automatically the moment the quota is reached (14 players by default; the owner
can change it per pitch or per session). A customer can bring a group, and a
group booking is refused if it would exceed the places left. Joining is
serialised — Postgres takes a row lock, SQLite relies on its write lock — so two
people cannot both take the last place.

**Men's barber shop.** Male customers only, enforced in the API and reflected in
the UI: the section is filtered out of listings for other customers and the
detail route refuses outright. Owners set the number of chairs and who sits at
each, so a customer books "chair 2 with Mazen" and the barber comes with the
chair. Bookings are a regular haircut or the groom's package.

**Women's beauty salon.** Female customers only, on the same mechanism. Owners
list services and products, define stations and staff, and keep a nail polish
palette. A nail booking records hands, feet or both, with the exact colour
chosen for each — and a colour cannot be assigned to a placement the chosen
service does not cover.

**Dental clinic.** Owners publish a fixed price for each procedure — extraction,
filling, cleaning, veneer, check-up — and a customer picks one when booking. The
price always comes from the clinic's own row, never from the request.

**Gyms.** Listed with a location, found by distance (haversine, computed in the
application so the query stays portable). A customer either subscribes monthly
or buys points from that gym's store.

## The point rules

Two rules from the specification shape the whole design:

1. Purchased points expire **six months** after the purchase date.
2. Buying again *before* that period ends rolls the existing balance into the
   new purchase, and the combined balance takes the new expiry date.

Both are modelled with point **lots** — one row per purchase, each with its own
expiry. A new purchase closes every surviving lot (`rolled_over`), carries their
remaining points into the new lot, and the whole combined balance shares the new
expiry. Lots that reach their expiry untouched are swept to `expired` and their
points written off. Expiry is applied lazily, whenever a balance is read or
changed, so nothing depends on a scheduled job being alive; an admin can also
force the sweep.

Every movement is appended to `point_transactions` with a running balance, so a
balance can always be re-derived and a customer can see where it came from.

## Security

- Passwords are hashed with **scrypt** (N=16384, r=8, p=1) and per-password
  salts, in self-describing hashes so the parameters can be raised later without
  invalidating anyone.
- **JWT** access tokens are short-lived; refresh tokens are long-lived, stored
  only as SHA-256 digests, and rotated on every use, so a stolen refresh token
  stops working as soon as the real client refreshes.
- Route-level middleware enforces the roles: `requireAuth`, `requireRole`,
  `requireOwnership` (the owner of *this* business, or an admin),
  `requireGender` for the two restricted sections.
- Rate limiting, a strict Content-Security-Policy, security headers, and a body
  size cap are on by default. Signature and password comparisons are
  constant-time.
- Money is always computed from the owner's own price rows. Nothing a client
  sends is trusted as a price.

Set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` in production — the server
refuses to start with generated values when `NODE_ENV=production`.

## Tests

```bash
npm test              # 126 tests against SQLite
npm run test:pg -w @youandme/server   # the same suite against PostgreSQL
```

The suite covers what the specification is specific about: the 14-player quota
(including a concurrency test — eight players racing for five places admits
exactly five), the six-month expiry and the rollover arithmetic, the gender
gates, the rule that a service can only be rated after it has been completed,
role isolation between owners and between customers, and the geo ordering.

`test:pg` gives each test file its own throwaway database, so the Postgres code
path — placeholder rewriting, row locking, type coercion — is genuinely
exercised rather than assumed.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default except the JWT
secrets in production.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4000` | |
| `DB_DRIVER` | `sqlite` | or `postgres` |
| `DATABASE_URL` | — | required when `DB_DRIVER=postgres` |
| `SQLITE_FILE` | `server/data/youandme.db` | |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | generated in development | **required in production** |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `30m` / `30d` | |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:4000` | |
| `FIELD_REQUIRED_PLAYERS` | `14` | the default match quota |
| `FIELD_SLOT_MINUTES` | `90` | the default session length |
| `POINTS_EXPIRY_MONTHS` | `6` | |
| `DESCRIPTION_WORD_LIMIT` | `200` | the cap on a field description |
| `CANCELLATION_WINDOW_HOURS` | `3` | how late a customer may cancel |

## Notes on the build

The API has no runtime framework: routing, middleware, password hashing, JWTs
and the Postgres driver are all built on Node's standard library, with `zod` for
validation. The client is React 19 and Tailwind v4, bundled by esbuild through
`web/build.mjs`, which also compiles the stylesheet through Tailwind's own
programmatic API — so the whole front end builds with two dev dependencies and
no bundler config.

`docs/design-notes.md` records the visual decisions and why they were made;
`docs/api.md` is the endpoint reference.
