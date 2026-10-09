/**
 * The customer's own area.
 *
 * Anything completed and not yet rated is surfaced at the top, because that is
 * the only moment rating is possible — the server refuses a rating before the
 * business has marked the service done.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, withQuery } from '../api.js';
import { useI18n, useErrorMessage } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { Link } from '../router.jsx';
import {
  Button,
  Empty,
  ErrorNote,
  Loading,
  Modal,
  Money,
  Stat,
  StatusChip,
  StarPicker,
  Tabs,
  Textarea,
  useToast,
} from '../ui/primitives.jsx';
import { Page, PageHead, Footer } from '../ui/Layout.jsx';
import { accent, hueOf } from '../ui/sections.js';

/** The rating dialog: one score for the place, optionally one for the person. */
function ReviewDialog({ target, onClose, onDone }) {
  const { t } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [rating, setRating] = useState(0);
  const [staffRating, setStaffRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/reviews', {
        ...(target.kind === 'booking' ? { bookingId: target.id } : { slotId: target.id }),
        rating,
        ...(staffRating ? { staffRating } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      toast.success(t('review.thanks'));
      onDone();
      onClose();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={target.kind === 'booking' ? t('review.rate') : t('review.rateField')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!rating} onClick={submit}>
            {t('review.submit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-paper-dim">{target.label}</p>
        <StarPicker
          value={rating}
          onChange={setRating}
          label={target.kind === 'booking' ? t('review.rate') : t('review.rateField')}
        />
        {target.staffName ? (
          <StarPicker
            value={staffRating}
            onChange={setStaffRating}
            label={`${t('review.rateStaff')} — ${target.staffName}`}
          />
        ) : null}
        <div className="field">
          <label htmlFor="review-comment">{t('review.comment')}</label>
          <Textarea
            id="review-comment"
            value={comment}
            maxLength={1000}
            onChange={(event) => setComment(event.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

function BookingRow({ booking, onCancel, onReview, busy }) {
  const { t, pick, formatDate, formatTime } = useI18n();
  const cancellable = booking.status === 'confirmed' || booking.status === 'pending';
  return (
    <article className="row flex-col items-stretch gap-3 sm:flex-row sm:items-center" style={accent(booking.section)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-bold">{pick(booking.businessName)}</span>
          <StatusChip status={booking.status} />
        </div>
        <p className="num text-2xs text-paper-dim">
          {formatDate(booking.startsAt, { weekday: 'short' })} {formatTime(booking.startsAt)}
          {booking.staffName ? (
            <span className="font-sans">
              {' '}
              · {t('booking.withStaff')} {booking.staffName}
            </span>
          ) : null}
          {booking.chairLabel ? <span className="font-sans"> · {booking.chairLabel}</span> : null}
        </p>
        <p className="num text-2xs text-paper-faint">{booking.reference}</p>
      </div>
      <Money amount={booking.totalAmount} className="shrink-0 text-sm font-bold" />
      <div className="flex shrink-0 gap-2">
        {booking.canReview ? (
          <Button variant="primary" size="sm" onClick={() => onReview(booking)}>
            {t('review.rate')}
          </Button>
        ) : null}
        {cancellable ? (
          <Button variant="danger" size="sm" busy={busy === booking.id} onClick={() => onCancel(booking)}>
            {t('booking.cancelBooking')}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export default function ClientDashboard() {
  const { t, pick, formatDate, formatTime } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [tab, setTab] = useState('overview');
  const [state, setState] = useState({ loading: true, dashboard: null, error: null });
  const [bookings, setBookings] = useState([]);
  const [reviewTarget, setReviewTarget] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true }));
    Promise.all([
      api.get('/me/dashboard'),
      api.get(withQuery('/bookings/mine', { limit: 50 })).catch(() => ({ items: [] })),
    ])
      .then(([dashboard, mine]) => {
        setState({ loading: false, dashboard, error: null });
        setBookings(mine.items ?? []);
      })
      .catch((error) => setState({ loading: false, dashboard: null, error }));
  }, []);

  useEffect(load, [load]);

  const cancel = async (booking) => {
    setBusy(booking.id);
    try {
      await api.post(`/bookings/${booking.id}/cancel`, {});
      toast.success(t('booking.cancelled'));
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
  if (state.error || !state.dashboard) {
    return (
      <Page>
        <ErrorNote message={messageFor(state.error)} onRetry={load} />
      </Page>
    );
  }

  const data = state.dashboard;
  const awaiting = [
    ...data.awaitingReview.bookings.map((booking) => ({
      kind: 'booking',
      id: booking.id,
      label: `${pick(booking.businessName) || ''} — ${formatDate(booking.startsAt)}`,
      staffName: booking.staffName,
    })),
    ...data.awaitingReview.sessions.map((session) => ({
      kind: 'slot',
      id: session.id,
      label: `${session.fieldName || ''} — ${formatDate(session.startsAt)}`,
      staffName: null,
    })),
  ];

  const upcoming = bookings.filter((b) => b.status === 'confirmed' || b.status === 'pending');
  const past = bookings.filter((b) => b.status !== 'confirmed' && b.status !== 'pending');

  return (
    <>
      <Page>
        <PageHead title={t('nav.dashboard')} description={user.fullName} />

        <div className="mb-5">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { key: 'overview', label: t('owner.overview') },
              { key: 'upcoming', label: t('booking.upcoming'), count: upcoming.length },
              { key: 'past', label: t('booking.past'), count: past.length },
            ]}
          />
        </div>

        {/* Anything rateable comes first: the window is open only now. */}
        {awaiting.length > 0 ? (
          <section className="mb-6">
            <h2 className="mb-3 text-base">{t('review.awaiting')}</h2>
            <div className="flex flex-col gap-2.5">
              {awaiting.map((target) => (
                <div
                  key={`${target.kind}-${target.id}`}
                  className="row justify-between"
                  style={{ '--accent': 'var(--color-brass)' }}
                >
                  <span className="truncate text-xs">{target.label}</span>
                  <Button variant="primary" size="sm" onClick={() => setReviewTarget(target)}>
                    {t('review.rate')}
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {tab === 'overview' ? (
          <div className="flex flex-col gap-8">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t('booking.upcoming')} value={data.upcomingBookings.length} />
              <Stat label={t('section.sports_field')} value={data.upcomingSessions.length} />
              <Stat
                label={t('gym.balance')}
                value={data.gymWallets.reduce((sum, wallet) => sum + wallet.balance, 0)}
                note={t('gym.points')}
              />
              <Stat label={t('owner.revenue')} value={data.totals.paid.toFixed(2)} note={t('common.currency')} />
            </div>

            {data.upcomingSessions.length > 0 ? (
              <section>
                <h2 className="mb-3 text-base">{t('section.sports_field')}</h2>
                <div className="flex flex-col gap-2.5">
                  {data.upcomingSessions.map((session) => (
                    <Link
                      key={session.id}
                      to={`/fields/sessions/${session.id}`}
                      className="row justify-between"
                      style={accent('sports_field')}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-xs font-bold">{session.fieldName}</span>
                        <span className="num text-2xs text-paper-dim">
                          {formatDate(session.startsAt, { weekday: 'short' })} {formatTime(session.startsAt)}
                        </span>
                      </span>
                      <span className="num text-2xs text-paper-dim">
                        {session.joinedPlayers}/{session.requiredPlayers}
                      </span>
                      <StatusChip status={session.status} />
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}

            {data.gymWallets.length > 0 ? (
              <section>
                <h2 className="mb-3 text-base">{t('gym.wallet')}</h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {data.gymWallets.map((wallet) => (
                    <Link
                      key={wallet.businessId}
                      to={`/gyms/${wallet.businessId}`}
                      className="panel flex flex-col gap-2 p-4"
                      style={accent('gym')}
                    >
                      <span className="truncate text-xs font-bold">{pick(wallet.businessName)}</span>
                      <span className="num text-2xl font-bold" style={{ color: hueOf('gym') }}>
                        {wallet.balance}
                      </span>
                      <span className="num text-2xs text-paper-dim">
                        {wallet.entriesAvailable} {t('gym.entriesLeft')}
                      </span>
                      {wallet.expiresAt ? (
                        <span className="num text-2xs text-paper-faint">
                          {t('gym.expiresOn')} {formatDate(wallet.expiresAt, { year: 'numeric' })}
                        </span>
                      ) : null}
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}

            {data.subscriptions.length > 0 ? (
              <section>
                <h2 className="mb-3 text-base">{t('gym.monthly')}</h2>
                <div className="flex flex-col gap-2.5">
                  {data.subscriptions.map((subscription) => (
                    <div key={subscription.id} className="row justify-between" style={accent('gym')}>
                      <span className="truncate text-xs font-bold">{subscription.businessName}</span>
                      <span className="num text-2xs text-paper-dim">
                        {t('gym.subscriptionUntil')} {formatDate(subscription.endsOn, { year: 'numeric' })}
                      </span>
                      <StatusChip status={subscription.status} />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {tab === 'upcoming' ? (
          upcoming.length === 0 ? (
            <Empty
              title={t('booking.none')}
              action={
                <Link to="/" className="btn btn-primary">
                  {t('home.cta.browse')}
                </Link>
              }
            />
          ) : (
            <div className="flex flex-col gap-2.5">
              {upcoming.map((booking) => (
                <BookingRow
                  key={booking.id}
                  booking={booking}
                  busy={busy}
                  onCancel={cancel}
                  onReview={(b) =>
                    setReviewTarget({
                      kind: 'booking',
                      id: b.id,
                      label: pick(b.businessName),
                      staffName: b.staffName,
                    })
                  }
                />
              ))}
            </div>
          )
        ) : null}

        {tab === 'past' ? (
          past.length === 0 ? (
            <Empty title={t('booking.none')} />
          ) : (
            <div className="flex flex-col gap-2.5">
              {past.map((booking) => (
                <BookingRow
                  key={booking.id}
                  booking={booking}
                  busy={busy}
                  onCancel={cancel}
                  onReview={(b) =>
                    setReviewTarget({
                      kind: 'booking',
                      id: b.id,
                      label: pick(b.businessName),
                      staffName: b.staffName,
                    })
                  }
                />
              ))}
            </div>
          )
        ) : null}
      </Page>

      {reviewTarget ? (
        <ReviewDialog target={reviewTarget} onClose={() => setReviewTarget(null)} onDone={load} />
      ) : null}
      <Footer />
    </>
  );
}
