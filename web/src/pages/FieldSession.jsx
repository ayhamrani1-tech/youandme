/**
 * One field session, or one pitch.
 *
 * The session view is built around the quota: who has joined, how many more are
 * needed, and what each person pays. A customer can bring a group, and the
 * running total updates as they do.
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
  Field,
  Input,
  Loading,
  Money,
  QuotaMeter,
  Stars,
  StatusChip,
  useToast,
} from '../ui/primitives.jsx';
import { Page, Footer } from '../ui/Layout.jsx';
import { accent, hueOf } from '../ui/sections.js';

/** A pitch, with the sessions published on it. */
function FieldView({ fieldId }) {
  const { t, pick, formatDate, formatTime } = useI18n();
  const messageFor = useErrorMessage();
  const [state, setState] = useState({ loading: true, field: null, error: null });

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true }));
    api
      .get(`/fields/${fieldId}`)
      .then((field) => setState({ loading: false, field, error: null }))
      .catch((error) => setState({ loading: false, field: null, error }));
  }, [fieldId]);

  useEffect(load, [load]);

  if (state.loading) {
    return (
      <Page>
        <Loading rows={4} />
      </Page>
    );
  }
  if (state.error || !state.field) {
    return (
      <Page>
        <ErrorNote message={messageFor(state.error)} onRetry={load} />
      </Page>
    );
  }

  const field = state.field;
  return (
    <main className="shell py-8" style={accent('sports_field')}>
      <header className="mb-6 flex flex-col gap-3 border-b border-ink-line pb-5">
        <span
          aria-hidden="true"
          className="h-1 w-12 rounded-full"
          style={{ background: hueOf('sports_field') }}
        />
        <h1 className="text-2xl">{field.name}</h1>
        <div className="flex flex-wrap items-center gap-3">
          {field.rating.count > 0 ? <Stars value={field.rating.avg} count={field.rating.count} size={16} /> : null}
          {field.surface ? <span className="chip">{field.surface}</span> : null}
          {field.sizeLabel ? <span className="chip num">{field.sizeLabel}</span> : null}
          <span className="chip chip-accent num">
            {field.requiredPlayers} {t('quota.players')}
          </span>
          <span className="chip num">
            <Money amount={field.pricePerPerson} /> — {t('quota.perPerson')}
          </span>
        </div>
        {field.description ? (
          <p className="text-xs leading-relaxed text-paper-dim">{field.description}</p>
        ) : null}
        <p className="text-2xs text-paper-faint">
          {pick(field.business?.name)}
          {field.business?.city ? ` — ${field.business.city}` : ''}
        </p>
      </header>

      <h2 className="mb-3 text-lg">{t('owner.openSessions')}</h2>
      {field.slots.length === 0 ? (
        <Empty title={t('home.noSessions')} />
      ) : (
        <div className="flex flex-col gap-2.5">
          {field.slots.map((slot) => (
            <Link key={slot.id} to={`/fields/sessions/${slot.id}`} className="row justify-between">
              <span className="num text-xs">
                {formatDate(slot.startsAt, { weekday: 'short' })} {formatTime(slot.startsAt)}
              </span>
              <span className="w-40">
                <QuotaMeter joined={slot.joinedPlayers} required={slot.requiredPlayers} showLabel={false} />
              </span>
              <Money amount={slot.pricePerPerson} className="text-xs font-bold" />
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}

/** One session: the quota, who is in it, and the join action. */
function SessionView({ slotId }) {
  const { t, pick, formatDate, formatTime } = useI18n();
  const { user } = useAuth();
  const { navigate } = useRouter();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [state, setState] = useState({ loading: true, slot: null, error: null });
  const [players, setPlayers] = useState(1);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true }));
    api
      .get(`/fields/slots/${slotId}`)
      .then((slot) => setState({ loading: false, slot, error: null }))
      .catch((error) => setState({ loading: false, slot: null, error }));
  }, [slotId]);

  useEffect(load, [load]);

  const join = async () => {
    if (!user) {
      navigate(`/signin?next=/fields/sessions/${slotId}`);
      return;
    }
    setBusy(true);
    try {
      const result = await api.post(`/fields/slots/${slotId}/join`, { playersCount: players });
      toast.success(result.message);
      load();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    setBusy(true);
    try {
      await api.delete(`/fields/slots/${slotId}/join`);
      toast.success(t('booking.cancelled'));
      load();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) {
    return (
      <Page>
        <Loading rows={4} />
      </Page>
    );
  }
  if (state.error || !state.slot) {
    return (
      <Page>
        <ErrorNote message={messageFor(state.error)} onRetry={load} />
      </Page>
    );
  }

  const slot = state.slot;
  const full = slot.playersNeeded === 0;
  const maxPlayers = Math.max(1, slot.playersNeeded);

  return (
    <main className="shell py-8" style={accent('sports_field')}>
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section className="panel flex flex-col gap-5 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <span
                aria-hidden="true"
                className="mb-1 h-1 w-10 rounded-full"
                style={{ background: hueOf('sports_field') }}
              />
              <h1 className="text-xl">{slot.fieldName}</h1>
              <p className="num text-xs text-paper-dim">
                {formatDate(slot.startsAt, { weekday: 'long', year: 'numeric' })}{' '}
                {formatTime(slot.startsAt)}–{formatTime(slot.endsAt)}
                <span className="font-sans"> · {slot.durationMin} {t('common.minutes')}</span>
              </p>
              <p className="text-2xs text-paper-faint">
                {pick(slot.business?.name)}
                {slot.business?.city ? ` — ${slot.business.city}` : ''}
              </p>
            </div>
            <StatusChip status={slot.status} />
          </div>

          {/* The quota, given the weight it deserves. */}
          <div className="rounded-panel border border-ink-line p-5">
            <QuotaMeter joined={slot.joinedPlayers} required={slot.requiredPlayers} />
          </div>

          {slot.description ? (
            <p className="text-xs leading-relaxed text-paper-dim">{slot.description}</p>
          ) : null}

          <div className="flex flex-wrap items-end gap-4 border-t border-ink-line pt-4">
            {!slot.hasJoined && !full ? (
              <Field label={t('quota.yourPlayers')}>
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    max={maxPlayers}
                    value={players}
                    className="w-24"
                    onChange={(event) =>
                      setPlayers(Math.min(maxPlayers, Math.max(1, Number(event.target.value) || 1)))
                    }
                  />
                )}
              </Field>
            ) : null}
            <div>
              <p className="text-2xs text-paper-faint">{t('common.total')}</p>
              <Money
                amount={slot.pricePerPerson * (slot.hasJoined ? 1 : players)}
                className="text-xl font-bold"
              />
            </div>
            <div className="ms-auto flex gap-2">
              {slot.hasJoined ? (
                <Button variant="danger" busy={busy} onClick={leave}>
                  {t('quota.leave')}
                </Button>
              ) : (
                <Button variant="accent" size="lg" busy={busy} disabled={full} onClick={join}>
                  {full ? t('quota.full') : t('quota.join')}
                </Button>
              )}
            </div>
          </div>
        </section>

        <aside className="panel flex flex-col gap-3 p-5">
          <h2 className="text-base">
            {t('quota.participants')}{' '}
            <span className="num text-paper-faint">{slot.participants?.length ?? 0}</span>
          </h2>
          {(slot.participants ?? []).length === 0 ? (
            <p className="text-2xs text-paper-dim">{t('common.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {slot.participants.map((participant) => (
                <li key={participant.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">{participant.userName}</span>
                  {participant.playersCount > 1 ? (
                    <span className="num chip">+{participant.playersCount - 1}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {slot.business?.mapUrl ? (
            <a
              href={slot.business.mapUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost btn-sm mt-2"
            >
              {t('owner.openInMaps')}
            </a>
          ) : null}
        </aside>
      </div>
    </main>
  );
}

export default function FieldSession({ slotId, fieldId }) {
  return (
    <>
      {slotId ? <SessionView slotId={slotId} /> : <FieldView fieldId={fieldId} />}
      <Footer />
    </>
  );
}
