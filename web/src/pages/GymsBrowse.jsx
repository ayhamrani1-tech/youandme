/**
 * Gyms, found by distance.
 *
 * A customer in Irbid should see the Irbid gyms first and still be told how far
 * the Amman ones are, so distance is shown on every row rather than used only to
 * filter. The location comes from the device or from the saved profile.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, requestLocation, withQuery } from '../api.js';
import { useI18n, useErrorMessage } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { Link, useRouter } from '../router.jsx';
import {
  Button,
  Empty,
  ErrorNote,
  Field,
  Loading,
  Select,
  Stars,
  useToast,
} from '../ui/primitives.jsx';
import { Page, PageHead, Footer } from '../ui/Layout.jsx';
import { accent, hueOf } from '../ui/sections.js';

/**
 * Distance drawn as a bar, not a map tile: with no mapping dependency this is
 * the honest way to show how the gyms compare, and it works offline.
 */
function DistanceBar({ km, max }) {
  const { t } = useI18n();
  const width = max > 0 ? Math.max(3, (km / max) * 100) : 0;
  return (
    <span className="flex w-28 shrink-0 flex-col gap-1">
      <span className="num text-2xs text-paper-dim">
        {km} {t('common.km')}
      </span>
      <span className="h-1 rounded-full bg-ink">
        <span
          className="block h-full rounded-full"
          style={{ width: `${width}%`, background: hueOf('gym') }}
        />
      </span>
    </span>
  );
}

export default function GymsBrowse() {
  const { t, pick } = useI18n();
  const { user, setUser } = useAuth();
  const { navigate } = useRouter();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [coords, setCoords] = useState(
    user?.lat != null && user?.lng != null ? { lat: user.lat, lng: user.lng } : null,
  );
  const [radius, setRadius] = useState('');
  const [state, setState] = useState({ loading: false, data: null, error: null });

  const load = useCallback(
    (origin, radiusKm) => {
      if (!origin) return;
      setState({ loading: true, data: null, error: null });
      api
        .get(withQuery('/gyms/nearby', { ...origin, radiusKm: radiusKm || undefined, limit: 30 }))
        .then((data) => setState({ loading: false, data, error: null }))
        .catch((error) => setState({ loading: false, data: null, error }));
    },
    [],
  );

  useEffect(() => {
    if (coords) load(coords, radius);
  }, [coords, radius, load]);

  const locate = async () => {
    try {
      const position = await requestLocation();
      setCoords(position);
      if (user) {
        const updated = await api.put('/me/location', position);
        setUser(updated);
      }
      toast.success(t('auth.locationSaved'));
    } catch {
      toast.error(t('error.location_required'));
    }
  };

  const items = state.data?.items ?? [];
  const maxDistance = items.reduce((max, gym) => Math.max(max, gym.distanceKm ?? 0), 0);

  return (
    <>
      <Page>
        <PageHead
          title={t('section.gym')}
          description={t('section.gym.blurb')}
          accentStyle={accent('gym')}
          actions={
            <>
              <Button onClick={() => navigate('/gyms/how-it-works')}>{t('gym.howItWorks')}</Button>
              <Button variant="primary" onClick={locate}>
                {t('gym.findNearby')}
              </Button>
            </>
          }
        />

        {!coords ? (
          <Empty
            title={t('gym.needLocation')}
            body={t('auth.locationHint')}
            action={
              <Button variant="primary" onClick={locate}>
                {t('auth.useLocation')}
              </Button>
            }
          />
        ) : (
          <>
            <div className="mb-5 flex flex-wrap items-end gap-4">
              <Field label={t('common.distance')}>
                {(props) => (
                  <Select {...props} value={radius} onChange={(event) => setRadius(event.target.value)}>
                    <option value="">{t('common.all')}</option>
                    <option value="5">5 {t('common.km')}</option>
                    <option value="15">15 {t('common.km')}</option>
                    <option value="50">50 {t('common.km')}</option>
                    <option value="150">150 {t('common.km')}</option>
                  </Select>
                )}
              </Field>
              {state.data ? (
                <p className="num pb-2.5 text-2xs text-paper-faint">
                  {state.data.origin.lat.toFixed(3)}, {state.data.origin.lng.toFixed(3)}
                </p>
              ) : null}
            </div>

            {state.loading ? (
              <Loading rows={4} />
            ) : state.error ? (
              <ErrorNote message={messageFor(state.error)} onRetry={() => load(coords, radius)} />
            ) : items.length === 0 ? (
              <Empty title={t('common.empty')} body={t('gym.needLocation')} />
            ) : (
              <div className="flex flex-col gap-2.5">
                {items.map((gym) => (
                  <Link key={gym.id} to={`/gyms/${gym.id}`} className="row" style={accent('gym')}>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-bold">{pick(gym.name)}</span>
                        {gym.rating.count > 0 ? (
                          <Stars value={gym.rating.avg} count={gym.rating.count} />
                        ) : null}
                      </div>
                      <p className="text-2xs text-paper-faint">
                        {gym.city}
                        {gym.gymSettings ? (
                          <span className="num">
                            {' '}
                            · {gym.gymSettings.pointsPerEntry} {t('gym.pointsPerEntry')}
                          </span>
                        ) : null}
                      </p>
                    </div>
                    <DistanceBar km={gym.distanceKm} max={maxDistance} />
                    <span className="btn btn-ghost btn-sm shrink-0">{t('gym.store')}</span>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </Page>
      <Footer />
    </>
  );
}
