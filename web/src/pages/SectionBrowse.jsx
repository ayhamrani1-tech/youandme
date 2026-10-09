/**
 * Browse one appointment section (barber, salon, dental).
 *
 * The gender gate is enforced before any request is made, so a customer who
 * cannot enter a section is told why instead of watching an empty list load.
 */
import { useEffect, useState } from 'react';
import { api, withQuery } from '../api.js';
import { useI18n, useErrorMessage } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { Link, useRouter } from '../router.jsx';
import { Button, Empty, ErrorNote, Field, Input, Loading, Pagination, Select, Stars } from '../ui/primitives.jsx';
import { Page, PageHead, Footer } from '../ui/Layout.jsx';
import { GOVERNORATES, SECTION_PATHS, accent } from '../ui/sections.js';

function BusinessRow({ business, section }) {
  const { t, pick } = useI18n();
  const openNow = business.opensAt && business.closesAt;
  return (
    <Link to={`${SECTION_PATHS[section]}/${business.id}`} className="row" style={accent(section)}>
      {business.coverUrl ? (
        <img
          src={business.coverUrl}
          alt=""
          loading="lazy"
          className="hidden size-16 shrink-0 rounded-chip object-cover sm:block"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-bold">{pick(business.name)}</span>
          {business.rating.count > 0 ? <Stars value={business.rating.avg} count={business.rating.count} /> : null}
        </div>
        <p className="line-clamp-2 text-2xs text-paper-dim">{pick(business.description)}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-paper-faint">
          {business.city ? <span>{business.city}</span> : null}
          {openNow ? (
            <span className="num">
              {business.opensAt}–{business.closesAt}
            </span>
          ) : null}
          {business.distanceKm !== null && business.distanceKm !== undefined ? (
            <span className="num">
              {business.distanceKm} {t('common.km')}
            </span>
          ) : null}
        </div>
      </div>
      <span className="btn btn-ghost btn-sm shrink-0">{t('booking.book')}</span>
    </Link>
  );
}

export default function SectionBrowse({ section }) {
  const { t, locale } = useI18n();
  const { gate, user } = useAuth();
  const { navigate } = useRouter();
  const messageFor = useErrorMessage();
  const [filters, setFilters] = useState({ q: '', governorate: '', sort: 'rating' });
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, data: null, error: null });

  const access = gate(section);

  useEffect(() => {
    if (!access.allowed) {
      setState({ loading: false, data: null, error: null });
      return undefined;
    }
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    api
      .get(withQuery('/businesses', { section, page, limit: 10, ...filters }))
      .then((data) => {
        if (!cancelled) setState({ loading: false, data, error: null });
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, data: null, error });
      });
    return () => {
      cancelled = true;
    };
  }, [section, page, filters, access.allowed]);

  // Blocked sections explain the rule and offer the way forward.
  if (!access.allowed) {
    return (
      <>
        <Page>
          <PageHead title={t(`section.${section}`)} description={t(`section.${section}.blurb`)} />
          <Empty
            title={t(`error.${access.reason}`)}
            body={access.reason === 'sign_in_required' ? undefined : t('auth.genderHint')}
            action={
              user ? (
                <Button onClick={() => navigate('/')}>{t('notFound.home')}</Button>
              ) : (
                <Button variant="primary" onClick={() => navigate('/signin?next=' + SECTION_PATHS[section])}>
                  {t('auth.submitSignIn')}
                </Button>
              )
            }
          />
        </Page>
        <Footer />
      </>
    );
  }

  const items = state.data?.items ?? [];

  return (
    <>
      <Page>
        <PageHead
          title={t(`section.${section}`)}
          description={t(`section.${section}.blurb`)}
          accentStyle={accent(section)}
        />

        <form
          className="mb-5 grid gap-3 sm:grid-cols-[1fr_auto_auto]"
          onSubmit={(event) => event.preventDefault()}
        >
          <Field label={t('common.search')}>
            {(props) => (
              <Input
                {...props}
                type="search"
                value={filters.q}
                placeholder={t('common.search')}
                onChange={(event) => {
                  setPage(1);
                  setFilters({ ...filters, q: event.target.value });
                }}
              />
            )}
          </Field>
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
          <Field label={t('common.filter')}>
            {(props) => (
              <Select
                {...props}
                value={filters.sort}
                onChange={(event) => setFilters({ ...filters, sort: event.target.value })}
              >
                <option value="rating">{t('common.rating')}</option>
                <option value="name">{t('common.name')}</option>
                <option value="newest">{t('common.date')}</option>
              </Select>
            )}
          </Field>
        </form>

        {state.loading ? (
          <Loading rows={4} />
        ) : state.error ? (
          <ErrorNote message={messageFor(state.error)} onRetry={() => setFilters({ ...filters })} />
        ) : items.length === 0 ? (
          <Empty title={t('common.empty')} body={t('common.search')} />
        ) : (
          <div className="flex flex-col gap-2.5">
            {items.map((business) => (
              <BusinessRow key={business.id} business={business} section={section} />
            ))}
          </div>
        )}

        <Pagination page={state.data?.page ?? 1} pages={state.data?.pages ?? 1} onChange={setPage} />
      </Page>
      <Footer />
    </>
  );
}
