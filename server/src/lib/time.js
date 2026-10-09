/**
 * Time, scheduling and geography helpers.
 *
 * All timestamps crossing the database boundary are ISO-8601 UTC strings, which
 * sort correctly as text (SQLite) and cast cleanly to TIMESTAMPTZ (Postgres).
 */

export const nowIso = () => new Date().toISOString();

export const toIso = (value) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export function addMinutes(value, minutes) {
  return new Date(new Date(value).getTime() + minutes * 60_000).toISOString();
}

export function addDays(value, days) {
  return new Date(new Date(value).getTime() + days * 86_400_000).toISOString();
}

/**
 * Add calendar months, clamping the day when the target month is shorter
 * (31 Aug + 6 months = 28/29 Feb). Used for the 6-month points expiry.
 */
export function addMonths(value, months) {
  const date = new Date(value);
  const day = date.getUTCDate();
  const target = new Date(date.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target.toISOString();
}

export const dateOnly = (value = new Date()) => toIso(value).slice(0, 10);

/** 0 = Sunday … 6 = Saturday, matching `business_hours.weekday`. */
export const weekdayOf = (value) => new Date(value).getUTCDay();

export function minutesOfDay(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

export function formatHHMM(totalMinutes) {
  const minutes = ((totalMinutes % 1440) + 1440) % 1440;
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/** The HH:MM time-of-day of an instant, in UTC. */
export function timeOfDayOf(value) {
  const date = new Date(value);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

/** Combine a YYYY-MM-DD date and an HH:MM time into an ISO instant. */
export function combineDateTime(date, time) {
  return new Date(`${date}T${time}:00.000Z`).toISOString();
}

/**
 * Every start time on `date` between opening and closing, spaced by
 * `stepMinutes`, that leaves room for a `durationMinutes` appointment.
 */
export function generateSlots({ date, opensAt, closesAt, stepMinutes, durationMinutes }) {
  const open = minutesOfDay(opensAt);
  const close = minutesOfDay(closesAt);
  const step = Math.max(5, stepMinutes || 30);
  const duration = Math.max(5, durationMinutes || step);
  const slots = [];
  for (let start = open; start + duration <= close; start += step) {
    slots.push({
      time: formatHHMM(start),
      startsAt: combineDateTime(date, formatHHMM(start)),
      endsAt: combineDateTime(date, formatHHMM(start + duration)),
    });
  }
  return slots;
}

/** Do [aStart, aEnd) and [bStart, bEnd) overlap? */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

export const isPast = (value) => new Date(value).getTime() < Date.now();

export const hoursUntil = (value) => (new Date(value).getTime() - Date.now()) / 3_600_000;

/**
 * Great-circle distance in kilometres (haversine).
 * Used to list gyms nearest to a client — e.g. someone in Irbid seeing how far
 * an Amman gym is.
 */
export function distanceKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined || Number.isNaN(Number(v)))) {
    return null;
  }
  const R = 6371;
  const toRad = (deg) => (Number(deg) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 100) / 100;
}
