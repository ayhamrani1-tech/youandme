/**
 * Sports fields.
 *
 * Fields are not browsed as venues but as *sessions*: a time on a pitch with a
 * price per person and a quota still to fill. The list leads with how close each
 * match is to kicking off, because that is what decides whether it happens.
 */
import { useEffect, useState } from 'react';
import { api, withQuery } from '../api.js';
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
  Pagination,
  QuotaMeter,
  Select,
  Tabs,
  useToast,
} from '../ui/primitives.jsx';
import { Page, PageHead, Footer } from '../ui/Layout.jsx';
import { GOVERNORATES, accent } from '../ui/sections.js';

function SessionRow({ slot, onJoin, joining }) {
  const { t, pick, formatDate, formatTime } = useI18n();
  const { user } = useAuth();
  const { navigate } = useRouter();
  const full = slot.playersNeeded === 0;

  return (
    <article className="row flex-col items-stretch gap-4 sm:flex-row sm:items-center" style={accent('sports_field')}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link to={`/fields/sessions/${slot.id}`} className="truncate text-sm font-bold hover:underline">
          {slot.fieldName}
        </Link>
        <p className="num text-2xs text-paper-dim">
          {formatDate(slot.startsAt, { weekday: 'short' })} {formatTime(slot.startsAt)}–
          {formatTime(slot.endsAt)}
          <span className="font-sans"> · {pick(slot.business?.name)}</span>
        </p>
        {slot.city ? <p className="text-2xs text-paper-faint">{slot.city}</p> : null}
      </div>

      <div className="w-full shrink-0 sm:w-56">
        <QuotaMeter joined={slot.joinedPlayers} required={slot.requiredPlayers} />
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 sm:flex-col sm:items-end sm:justify-center">
        <div className="text-end">
          <Money amount={slot.pricePerPerson} className="text-sm font-bold" />
          <p className="text-2xs text-paper-faint">{t('quota.perPerson')}</p>
        </div>
        {user ? (
          <Button
            variant="accent"
            size="sm"
            busy={joining === slot.id}
            disabled={full || slot.hasJoined}
            onClick={() => onJoin(slot)}
          >
            {slot.hasJoined ? t('quota.joined') : full ? t('quota.full') : t('quota.join')}
          </Button>
        ) : (
          <Button size="sm" onClick={() => navigate('/signin?next=/fields')}>
            {t('quota.join')}
          </Button>
        )}
      </div>
    </article>
  );
}

export default function FieldsBrowse() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [tab, setTab] = useState('joinable');
  const [filters, setFilters] = useState({ governorate: '', date: '' });
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [joining, setJoining] = useState(null);

  const load = () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    api
      .get(
        withQuery('/fields/slots', {
          page,
          limit: 10,
          onlyJoinable: tab === 'joinable' ? true : undefined,
          status: tab === 'confirmed' ? 'confirmed' : undefined,
          ...filters,
        }),
      )
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  };

  useEffect(load, [page, tab, filters.governorate, filters.date, user?.id]);

  const join = async (slot) => {
    setJoining(slot.id);
    try {
      const result = await api.post(`/fields/slots/${slot.id}/join`, { playersCount: 1 });
      toast.success(result.message);
      load();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setJoining(null);
    }
  };

  const items = state.data?.items ?? [];

  return (
    <>
      <Page>
        <PageHead
          title={t('section.sports_field')}
          description={t('section.sports_field.blurb')}
          accentStyle={accent('sports_field')}
        />

        <div className="mb-4">
          <Tabs
            value={tab}
            onChange={(value) => {
              setPage(1);
              setTab(value);
            }}
            tabs={[
              { key: 'joinable', label: t('owner.openSessions') },
              { key: 'confirmed', label: t('owner.confirmedSessions') },
              { key: 'all', label: t('common.all') },
            ]}
          />
        </div>

        <form className="mb-5 grid gap-3 sm:grid-cols-2" onSubmit={(event) => event.preventDefault()}>
          <Field label={t('auth.governorate')}>
            {(props) => (
              <Select
                {...props}
                value={filters.governorate}
                onChange={(event) => {
                  setPage(1);
                  setFilters({ ...filters, governorate: event.target.value });
                }}
              >
                <option value="">{t('common.all')}</option>
                {GOVERNORATES.map((item) => (
                  <option key={item.ar} value={item.ar}>
                    {locale === 'ar' ? item.ar : item.en}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('common.date')}>
            {(props) => (
              <Input
                {...props}
                type="date"
                value={filters.date}
                onChange={(event) => {
                  setPage(1);
                  setFilters({ ...filters, date: event.target.value });
                }}
              />
            )}
          </Field>
        </form>

        {state.loading ? (
          <Loading rows={4} />
        ) : state.error ? (
          <ErrorNote message={messageFor(state.error)} onRetry={load} />
        ) : items.length === 0 ? (
          <Empty title={t('home.noSessions')} body={t('section.sports_field.blurb')} />
        ) : (
          <div className="flex flex-col gap-2.5">
            {items.map((slot) => (
              <SessionRow key={slot.id} slot={slot} onJoin={join} joining={joining} />
            ))}
          </div>
        )}

        <Pagination page={state.data?.page ?? 1} pages={state.data?.pages ?? 1} onChange={setPage} />
      </Page>
      <Footer />
    </>
  );
}
