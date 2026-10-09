/**
 * Application assembly: middleware order, route mounting, error reporting.
 */
import { App, Router } from './lib/router.js';
import { config } from './config.js';
import {
  securityHeaders,
  cors,
  rateLimit,
  requestId,
  requestLogger,
  locale,
  staticFiles,
} from './middleware/common.js';
import { notFound } from './lib/errors.js';
import { getDb } from './db/index.js';

import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import businessRoutes from './routes/businesses.js';
import fieldRoutes from './routes/fields.js';
import gymRoutes from './routes/gyms.js';
import bookingRoutes from './routes/bookings.js';
import reviewRoutes from './routes/reviews.js';
import adminRoutes from './routes/admin.js';

export function createApp() {
  const app = new App({
    onError(err, req, status) {
      if (status >= 500) {
        console.error(`[error] ${req.method} ${req.pathname}`, err);
      } else if (process.env.LOG_CLIENT_ERRORS === 'true') {
        console.warn(`[${status}] ${req.method} ${req.pathname} — ${err.code}: ${err.message}`);
      }
    },
  });

  app.use(requestId);
  app.use(securityHeaders);
  app.use(cors);
  app.use(locale);
  app.use(requestLogger);

  const api = new Router();
  api.use(rateLimit());

  api.get('/health', async () => {
    const db = getDb();
    const started = Date.now();
    await db.value('SELECT 1 AS ok');
    return {
      status: 'ok',
      driver: db.driver,
      dbLatencyMs: Date.now() - started,
      env: config.env,
      version: '1.0.0',
      time: new Date().toISOString(),
    };
  });

  /** Machine-readable description of the platform's own rules. */
  api.get('/config', async () => ({
    currency: config.rules.currency,
    sections: ['sports_field', 'barber', 'salon', 'dental', 'gym'],
    rules: {
      fieldRequiredPlayers: config.rules.fieldRequiredPlayers,
      fieldSlotMinutes: config.rules.fieldSlotMinutes,
      pointsExpiryMonths: config.rules.pointsExpiryMonths,
      descriptionWordLimit: config.rules.descriptionWordLimit,
      cancellationWindowHours: config.rules.cancellationWindowHours,
    },
    genderRestrictions: { barber: 'male', salon: 'female' },
  }));

  api.use('/auth', authRoutes);
  api.use('/me', meRoutes);
  api.use('/businesses', businessRoutes);
  api.use('/fields', fieldRoutes);
  api.use('/gyms', gymRoutes);
  api.use('/bookings', bookingRoutes);
  api.use('/reviews', reviewRoutes);
  api.use('/admin', adminRoutes);

  app.use('/api', api);

  if (config.serveWebDist) {
    app.use(staticFiles(config.webDist));
  }

  app.notFoundHandler = (req, res) => {
    if (req.pathname.startsWith('/api/')) {
      throw notFound('route_not_found', `No route for ${req.method} ${req.pathname}`);
    }
    res.json(
      {
        error: {
          code: 'web_not_built',
          message: 'The web client has not been built yet. Run `npm run build` first.',
        },
      },
      404,
    );
  };

  return app;
}
