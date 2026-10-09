/**
 * Request validation built on zod, with the domain-specific rules this
 * platform needs (Jordanian phone numbers, HH:MM times, the 200-word field
 * description cap).
 */
import { z } from 'zod';
import { unprocessable } from './errors.js';
import { config } from '../config.js';

/** Validate `data`, throwing a 422 with field-level details on failure. */
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '_',
    code: issue.code,
    message: issue.message,
  }));
  throw unprocessable('validation_failed', 'Some fields are invalid.', details);
}

export const SECTIONS = ['sports_field', 'barber', 'salon', 'dental', 'gym'];
export const ROLES = ['admin', 'owner', 'client'];
export const GENDERS = ['male', 'female'];
export const TREATMENTS = ['extraction', 'filling', 'cleaning', 'veneer', 'checkup'];
export const NAIL_SCOPES = ['hands', 'feet', 'both'];
export const BOOKING_TYPES = ['regular', 'groom'];
export const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
export const PAYMENT_METHODS = ['cash', 'card', 'points', 'subscription'];

/** Jordanian mobile: 10 digits beginning 077, 078 or 079. */
export const jordanPhone = z
  .string()
  .trim()
  .regex(/^07[789]\d{7}$/, 'Phone must be 10 digits starting 077, 078 or 079');

export const timeOfDay = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24-hour)');

export const isoDateTime = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Must be a valid ISO-8601 date-time');

export const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

export const email = z.string().trim().toLowerCase().email('Must be a valid email address');

export const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Password must contain letters and a number');

/** Counts words in Arabic or Latin script. */
export function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export const limitedDescription = z
  .string()
  .trim()
  .max(4000)
  .refine(
    (v) => countWords(v) <= config.rules.descriptionWordLimit,
    `Description must be ${config.rules.descriptionWordLimit} words or fewer`,
  );

export const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex colour such as #C21E56');

export const latitude = z.coerce.number().min(-90).max(90);
export const longitude = z.coerce.number().min(-180).max(180);
export const money = z.coerce.number().min(0).max(1_000_000);
export const positiveInt = z.coerce.number().int().positive();
export const rating = z.coerce.number().int().min(1).max(5);

/** Standard list query: ?page=1&limit=20&q=... */
export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(120).optional(),
  sort: z.string().trim().max(40).optional(),
});

export function pagination(query) {
  const { page, limit } = parse(listQuery, query);
  return { page, limit, offset: (page - 1) * limit };
}

export { z };
