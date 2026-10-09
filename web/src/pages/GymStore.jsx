/**
 * One gym: its point store, its memberships, and the customer's own wallet.
 *
 * The wallet leads with the two facts that decide what a customer should do
 * next — how many visits the balance is worth, and when it lapses — and warns
 * when the expiry is close, since topping up before it carries the balance over.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n, useErrorMessage } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { Link, useRouter } from '../router.jsx';
import {
  Button,
  Empty,
  ErrorNote,
  Loading,
  Money,
  Stars,
  useToast,
} from '../ui/primitives.jsx';
import { Page, Footer } from '../ui/Layout.jsx';
import { accent, hueOf } from '../ui/sections.js';

const daysUntil = (iso) => (iso ? Math.ceil((new Date(iso) - Date.now()) / 86400000) : null);

function Wallet({ wallet, onEntry, busy }) {
  const { t, formatDate } = useI18n();
  if (!wallet) return null;
  const days = daysUntil(wallet.expiresAt);
  const expiringSoon = days !== null && days <= 30;

  return (
    <section className="panel flex flex-col gap-4 p-5" style={accent('gym')}>
      <h2 className="text-base">{t('gym.wallet')}</h2>

      {wallet.subscription ? (
        <div className="rounded-chip border border-good/35 bg-good/10 px-3 py-2.5 text-2xs">
          {t('gym.subscriptionUntil')}{' '}
          <span className="num font-bold">{formatDate(wallet.subscription.endsOn, { year: 'numeric' })}</span>
        </div>
      ) : null}

      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-2xs text-paper-faint">{t('gym.balance')}</p>
          <p className="num text-3xl font-bold" style={{ color: hueOf('gym') }}>
            {wallet.balance}
          </p>
          <p className="text-2xs text-paper-dim">{t('gym.points')}</p>
        </div>
        <div className="text-end">
          <p className="num text-xl font-bold">{wallet.entriesAvailable}</p>
          <p className="text-2xs text-paper-dim">{t('gym.entriesLeft')}</p>
          <p className="num mt-1 text-2xs text-paper-faint">
            {wallet.pointsPerEntry} {t('gym.pointsPerEntry')}
          </p>
        </div>
      </div>

      {wallet.expiresAt ? (
        <p
          className={`rounded-chip border px-3 py-2 text-2xs ${
            expiringSoon ? 'border-warn/40 bg-warn/10 text-paper' : 'border-ink-line text-paper-dim'
          }`}
        >
          {expiringSoon ? `${t('gym.expiringSoon')} — ` : ''}
          {t('gym.expiresOn')}{' '}
          <span className="num font-bold">{formatDate(wallet.expiresAt, { year: 'numeric' })}</span>
        </p>
      ) : (
        <p className="text-2xs text-paper-dim">{t('gym.noBalance')}</p>
      )}

      <Button
        variant="accent"
        busy={busy}
        disabled={wallet.balance < wallet.pointsPerEntry && !wallet.subscription}
        onClick={onEntry}
      >
        {t('gym.recordEntry')}
      </Button>

      {wallet.history?.length ? (
        <div className="border-t border-ink-line pt-3">
          <h3 className="mb-2 text-2xs font-bold text-paper-dim">{t('gym.ledger')}</h3>
          <ul className="flex flex-col gap-1.5">
            {wallet.history.slice(0, 8).map((entry) => (
              <li key={entry.id} className="flex items-baseline justify-between gap-2 text-2xs">
                <span className="truncate text-paper-dim">{t(`ledger.${entry.kind}`)}</span>
                <span className="flex shrink-0 items-baseline gap-2">
                  <span className={`num font-bold ${entry.points >= 0 ? 'text-good' : 'text-paper'}`}>
                    {entry.points > 0 ? '+' : ''}
                    {entry.points}
                  </span>
                  <span className="num text-paper-faint">{entry.balanceAfter}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export default function GymStore({ businessId }) {
  const { t, pick, formatDate } = useI18n();
  const { user } = useAuth();
  const { navigate } = useRouter();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true }));
    api
      .get(`/gyms/${businessId}/store`)
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  }, [businessId]);

  useEffect(load, [load]);

  const requireSignIn = () => {
    navigate(`/signin?next=/gyms/${businessId}`);
  };

  const buy = async (pack) => {
    if (!user) return requireSignIn();
    setBusy(`pack-${pack.id}`);
    try {
      const result = await api.post(`/gyms/${businessId}/points/purchase`, { packageId: pack.id });
      toast.success(
        result.rolledOverPoints > 0
          ? `${t('gym.bought')} — ${result.rolledOverPoints} ${t('gym.rolledOver')}`
          : t('gym.bought'),
      );
      load();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(null);
    }
  };

  const subscribe = async (plan) => {
    if (!user) return requireSignIn();
    setBusy(`plan-${plan.id}`);
    try {
      await api.post(`/gyms/${businessId}/subscribe`, { planId: plan.id });
      toast.success(t('gym.subscribed'));
      load();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(null);
    }
  };

  const recordEntry = async () => {
    if (!user) return requireSignIn();
    setBusy('entry');
    try {
      const result = await api.post(`/gyms/${businessId}/entry`, {});
      toast.success(
        result.method === 'subscription' ? t('gym.coveredBySubscription') : t('gym.entryRecorded'),
      );
      load();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(null);
    }
  };

  if (state.loading) {
    return (
      <Page>
        <Loading rows={5} />
      </Page>
    );
  }
  if (state.error || !state.data) {
    return (
      <Page>
        <ErrorNote message={messageFor(state.error)} onRetry={load} />
      </Page>
    );
  }

  const { gym, settings, pointPackages, plans, wallet } = state.data;
  const memberships = plans.filter((plan) => plan.kind === 'monthly');
  const training = plans.filter((plan) => plan.kind === 'private_training');

  return (
    <>
      <main className="shell py-8" style={accent('gym')}>
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-ink-line pb-5">
          <div className="flex flex-col gap-2">
            <span
              aria-hidden="true"
              className="h-1 w-12 rounded-full"
              style={{ background: hueOf('gym') }}
            />
            <h1 className="text-2xl">{pick(gym.name)}</h1>
            <div className="flex flex-wrap items-center gap-3">
              {gym.rating.count > 0 ? <Stars value={gym.rating.avg} count={gym.rating.count} size={16} /> : null}
              <span className="num chip">
                {gym.opensAt}–{gym.closesAt}
              </span>
              {gym.city ? <span className="chip">{gym.city}</span> : null}
              <span className="num chip chip-accent">
                {settings.pointsPerEntry} {t('gym.pointsPerEntry')}
              </span>
            </div>
          </div>
          <Link to="/gyms/how-it-works" className="btn btn-ghost btn-sm">
            {t('gym.howItWorks')}
          </Link>
        </header>

        {pick(gym.description) ? (
          <p className="mb-6 text-xs leading-relaxed text-paper-dim">{pick(gym.description)}</p>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="flex flex-col gap-8">
            {/* Point store */}
            <section>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="text-lg">{t('gym.store')}</h2>
                <Link
                  to="/gyms/how-it-works"
                  className="text-2xs text-paper-dim underline decoration-ink-line underline-offset-4"
                >
                  {t('home.howPoints')}
                </Link>
              </div>
              {pointPackages.length === 0 ? (
                <Empty title={t('common.empty')} />
              ) : (
                <div className="grid gap-3 sm:grid-cols-3">
                  {pointPackages.map((pack) => (
                    <article key={pack.id} className="panel flex flex-col gap-3 p-5">
                      <div>
                        <p className="num text-2xl font-bold" style={{ color: hueOf('gym') }}>
                          {pack.totalPoints}
                        </p>
                        <p className="text-2xs text-paper-dim">{t('gym.points')}</p>
                      </div>
                      {pack.bonusPoints > 0 ? (
                        <span className="num chip chip-good self-start">
                          +{pack.bonusPoints} {t('gym.bonus')}
                        </span>
                      ) : null}
                      <div className="mt-auto flex items-end justify-between gap-2 pt-2">
                        <div>
                          <Money amount={pack.price} className="text-sm font-bold" />
                          <p className="num text-2xs text-paper-faint">
                            {pack.pricePerPoint.toFixed(2)} / {t('gym.pricePerPoint')}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="accent"
                        size="sm"
                        busy={busy === `pack-${pack.id}`}
                        onClick={() => buy(pack)}
                      >
                        {t('gym.buy')}
                      </Button>
                    </article>
                  ))}
                </div>
              )}
            </section>

            {/* Memberships */}
            {memberships.length > 0 ? (
              <section>
                <h2 className="mb-3 text-lg">{t('gym.monthly')}</h2>
                <div className="flex flex-col gap-2.5">
                  {memberships.map((plan) => (
                    <article key={plan.id} className="row" style={accent('gym')}>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-bold">{pick(plan.name)}</span>
                        <span className="num text-2xs text-paper-faint">
                          {plan.durationDays} {t('common.days')}
                        </span>
                        {plan.description ? (
                          <span className="truncate text-2xs text-paper-dim">{plan.description}</span>
                        ) : null}
                      </div>
                      <Money amount={plan.price} className="shrink-0 text-sm font-bold" />
                      <Button
                        variant="accent"
                        size="sm"
                        busy={busy === `plan-${plan.id}`}
                        onClick={() => subscribe(plan)}
                      >
                        {t('gym.subscribe')}
                      </Button>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {/* Private training */}
            {training.length > 0 ? (
              <section>
                <h2 className="mb-3 text-lg">{t('gym.privateTraining')}</h2>
                <div className="flex flex-col gap-2.5">
                  {training.map((plan) => (
                    <article key={plan.id} className="row" style={accent('gym')}>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-bold">{pick(plan.name)}</span>
                        <span className="text-2xs text-paper-faint">
                          {plan.trainerName ? `${t('booking.withStaff')} ${plan.trainerName}` : ''}
                          {plan.sessionsIncluded ? (
                            <span className="num"> · {plan.sessionsIncluded} {t('gym.sessions')}</span>
                          ) : null}
                        </span>
                        {plan.description ? (
                          <span className="truncate text-2xs text-paper-dim">{plan.description}</span>
                        ) : null}
                      </div>
                      <Money amount={plan.price} className="shrink-0 text-sm font-bold" />
                      <Button
                        variant="accent"
                        size="sm"
                        busy={busy === `plan-${plan.id}`}
                        onClick={() => subscribe(plan)}
                      >
                        {t('gym.subscribe')}
                      </Button>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <aside className="flex flex-col gap-5">
            {user ? (
              <Wallet wallet={wallet} onEntry={recordEntry} busy={busy === 'entry'} />
            ) : (
              <Empty
                title={t('gym.wallet')}
                body={t('error.sign_in_required')}
                action={
                  <Button variant="primary" onClick={requireSignIn}>
                    {t('auth.submitSignIn')}
                  </Button>
                }
              />
            )}
            {settings.intro?.ar || settings.intro?.en ? (
              <section className="panel p-5">
                <h2 className="mb-2 text-base">{t('gym.beforeYouStart')}</h2>
                <p className="text-2xs leading-relaxed text-paper-dim">{pick(settings.intro)}</p>
              </section>
            ) : null}
          </aside>
        </div>
      </main>
      <Footer />
    </>
  );
}
