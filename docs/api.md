# API reference

Base path `/api`. Requests and responses are JSON. Authenticated requests carry
`Authorization: Bearer <accessToken>`.

Errors always have the same shape, with a stable `code` the client translates
itself rather than displaying server text:

```json
{ "error": { "code": "slot_full", "message": "This match is already full." } }
```

Validation failures (422) add `details`, one entry per field:

```json
{ "error": { "code": "validation_failed", "message": "Some fields are invalid.",
  "details": [{ "path": "gender", "code": "invalid_enum_value", "message": "..." }] } }
```

Listing endpoints take `?page=&limit=` and return
`{ items, page, limit, total, pages }`.

---

## Platform

| | |
| --- | --- |
| `GET /health` | status, driver, database latency |
| `GET /config` | the platform's own rules: quota, slot length, expiry months, word limit, gender restrictions |

## Authentication — `/auth`

| | |
| --- | --- |
| `POST /register` | `{ fullName, email, password, gender, role?, phone?, locale?, governorate?, city?, lat?, lng? }` → `{ accessToken, refreshToken, expiresIn, user }`. `gender` is required; `role` accepts `client` or `owner` only. |
| `POST /login` | `{ email, password }` → the same session payload |
| `POST /refresh` | `{ refreshToken }` → a new session; the presented token is retired |
| `POST /logout` | `{ refreshToken }` |
| `POST /logout-all` | revokes every refresh token for the account |
| `GET /me` | the signed-in user and the businesses they own |
| `POST /change-password` | `{ currentPassword, newPassword }`; ends all other sessions |

Registration and sign-in are rate limited separately from the rest of the API.

## The signed-in user — `/me`

| | |
| --- | --- |
| `PUT /profile` | name, phone, locale, address, gender. Gender is locked once the account has bookings in a gender-restricted section. |
| `PUT /location` | `{ lat, lng }` — used for nearby-gym search |
| `GET /dashboard` | upcoming bookings and sessions, gym wallets, subscriptions, and anything now awaiting a rating |
| `GET /owner/dashboard` | per-business figures for an owner |
| `GET /owner/transactions` | money received, across the owner's businesses |

## Businesses — `/businesses`

Discovery is open to visitors; gender-restricted businesses are filtered out for
customers who may not book them, and the detail route refuses outright.

| | |
| --- | --- |
| `GET /` | `?section=&governorate=&city=&q=&lat=&lng=&radiusKm=&sort=distance\|rating\|name\|newest`. Every result carries `distanceKm` when a location is known. |
| `GET /sections/summary` | per section: how many businesses, plus the figure that section is actually browsed by (open sessions, chairs, specialists, clinics, gyms) |
| `GET /locations` | governorates and cities that have listings |
| `GET /:businessId` | the full profile: services, staff, chairs, hours, reviews, rating breakdown, and the section's own extras (treatments, nail colours, pitches, gym plans and packages) |
| `GET /:businessId/availability` | `?date=&staffId=&chairId=&durationMin=` → the bookable grid, each slot marked available with a reason when not |

Owner routes — all behind `requireOwnership`, which also admits an admin:

| | |
| --- | --- |
| `POST /` | create a business. Barber and salon get their gender policy automatically; a gym must have a location. |
| `PUT /:businessId` · `PATCH /:businessId/status` · `DELETE /:businessId` | |
| `PUT /:businessId/hours` | the full week in one call |
| `GET POST PUT DELETE /:businessId/staff[/:staffId]` | |
| `GET POST PUT DELETE /:businessId/chairs[/:chairId]` | |
| `PUT /:businessId/chairs/count` | set the number of chairs; refuses to remove one with upcoming bookings |
| `GET POST PUT DELETE /:businessId/services[/:serviceId]` | |
| `GET POST DELETE /:businessId/nail-colors[/:colorId]` | salons only |

## Sports fields — `/fields`

| | |
| --- | --- |
| `GET /` | pitches, with their venue and distance |
| `GET /slots` | `?fieldId=&businessId=&governorate=&date=&status=&onlyJoinable=` — open sessions, soonest first |
| `GET /slots/:slotId` | one session with its players |
| `GET /:fieldId` | one pitch with its upcoming sessions and reviews |
| `POST /slots/:slotId/join` | `{ playersCount?, paymentMethod? }`. Confirms the match when the quota is reached; refuses if fewer places remain than asked for. |
| `DELETE /slots/:slotId/join` | leave; the match reopens if it drops below the quota |

Owner routes:

| | |
| --- | --- |
| `POST /business/:businessId` | add a pitch — price per person, quota, description (200 words) |
| `PUT DELETE /:fieldId` | |
| `POST /:fieldId/slots` | publish one session |
| `POST /:fieldId/slots/bulk` | publish a series: `{ startDate, days, times[], durationMin, weekdays? }` |
| `GET /:fieldId/slots/manage` | every session with its players |
| `POST /slots/:slotId/complete` | **marking a session played is what lets its players rate the pitch** |
| `POST /slots/:slotId/cancel` · `DELETE /slots/:slotId` | |

## Gyms — `/gyms`

| | |
| --- | --- |
| `GET /how-it-works` | the onboarding explainer, in both languages, generated from the rules the server enforces |
| `GET /nearby` | `?lat=&lng=&radiusKm=&minRating=&limit=` — nearest first, with distance and entry cost |
| `GET /:businessId/store` | packages, plans, settings, and the caller's wallet |
| `GET /:businessId/wallet` | balance, expiry, active lots and the full ledger |
| `POST /:businessId/points/purchase` | `{ packageId, paymentMethod? }` → `{ purchasedPoints, rolledOverPoints, balance, expiresAt }` |
| `POST /:businessId/entry` | record a visit — covered by an active subscription, otherwise paid in points |
| `POST /:businessId/subscribe` | `{ planId, startsOn? }`; renewing early extends from the current end date |

Owner routes:

| | |
| --- | --- |
| `PUT /:businessId/settings` | points per entry, expiry months, which payment routes are offered, the intro text |
| `POST PUT DELETE /:businessId/plans[/:planId]` | monthly memberships and private training |
| `POST PUT DELETE /:businessId/packages[/:packageId]` | the point store |
| `GET /:businessId/members` | members with balances, expiry dates and subscriptions |
| `POST /:businessId/members/:userId/points` | grant or remove points |

## Bookings — `/bookings`

For the barber, salon, dental and gym-training sections.

| | |
| --- | --- |
| `POST /` | `{ businessId, startsAt, durationMin?, staffId?, chairId?, items[], bookingType?, nailScope?, nailColorIds[], treatmentCode?, paymentMethod?, notes? }`. Prices come from the owner's rows; a chosen chair implies its barber. |
| `GET /mine` | the caller's own bookings; each carries `canReview` |
| `GET /:bookingId` | visible to the customer, the business owner, or an admin |
| `POST /:bookingId/cancel` | customers are held to the cancellation window; owners and admins are not. Points spent are refunded. |
| `GET /business/:businessId` | the owner's diary, filterable by day, staff member, chair or status |
| `POST /:bookingId/complete` | **marking an appointment done is what lets the customer rate it** |
| `POST /:bookingId/no-show` | |

## Reviews — `/reviews`

A review is only ever accepted against something already completed.

| | |
| --- | --- |
| `POST /` | `{ bookingId \| slotId, rating, staffRating?, comment? }`. Refused with `booking_not_completed` / `session_not_completed` otherwise, and `already_reviewed` on a repeat. |
| `GET /business/:businessId` | with a rating breakdown |
| `GET /staff/:staffId` | the per-specialist ratings customers choose from |
| `GET /field/:fieldId` · `GET /mine` | |
| `PUT DELETE /:reviewId` | the author, or an admin moderating |

## Admin — `/admin`

Every route requires the admin role.

| | |
| --- | --- |
| `GET /overview` | platform figures: users by role, businesses by section, bookings, revenue, points outstanding and expiring |
| `GET POST PUT DELETE /users[/:userId]` | full CRUD. The last active admin cannot be demoted or disabled; an owner with businesses cannot be deleted until they are reassigned. |
| `GET /users/:userId` | one user with their businesses, bookings, reviews, transactions and point lots |
| `GET /businesses` · `PATCH /businesses/:id/status` · `PATCH /businesses/:id/owner` · `DELETE /businesses/:id` | |
| `POST /businesses/bulk-status` | enable or disable by section, by id list, or everything |
| `GET /bookings` · `PATCH /bookings/:id/status` · `DELETE /bookings/:id` | |
| `GET /field-slots` · `POST /field-slots/:id/complete` · `POST /field-slots/:id/cancel` | |
| `GET /reviews` · `DELETE /reviews/:id` | moderation |
| `GET /points/wallets` · `GET /points/wallets/:userId/:businessId` · `POST /points/adjust` | |
| `POST /points/sweep` | force the expiry sweep platform-wide |
| `GET /transactions` | the money ledger, with a total |
| `GET /audit` | who changed what, and when |

---

## Status codes

| | |
| --- | --- |
| `400` | a malformed or impossible request (`slot_in_past`, `treatment_required`) |
| `401` | missing, invalid or expired token; wrong credentials |
| `403` | a role, ownership or gender rule (`male_only_section`, `not_your_business`) |
| `404` | no such record, or one hidden from this caller |
| `409` | a conflict with the world's state (`slot_full`, `chair_unavailable`, `insufficient_points`, `booking_not_completed`) |
| `422` | field validation, with `details` |
| `429` | rate limited; `Retry-After` is set |
