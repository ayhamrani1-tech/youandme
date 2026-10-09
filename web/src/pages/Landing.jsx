/**
 * Landing page.
 *
 * The hero leads with the platform's most characteristic mechanic rather than a
 * stat block: a real match that needs a few more players before it happens. To
 * its side, the five sections as lanes — each one line, with its hue on the
 * leading edge and what is actually available in it right now.
 */
import { useEffect, useState } from 'react';
import { api, withQuery } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { Link, useRouter } from '../router.jsx';
import { Button, QuotaMeter, Money, Loading } from '../ui/primitives.jsx';
import { Footer } from '../ui/Layout.jsx';
import { SECTION_PATHS, SECTIONS, accent, hueOf } from '../ui/sections.js';

function SectionLane({ section, value, unit }) {
  const { t } = useI18n();
  return (
    <Link
      to={SECTION_PATHS[section]}
      className="row group justify-between py-3.5"
      style={accent(section)}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-bold">{t(`section.${section}`)}</span>
        <span className="truncate text-2xs text-paper-faint">{t(`section.${section}.blurb`)}</span>
      </span>
      <span className="flex shrink-0 items-baseline gap-1.5">
        <span className="num text-lg font-bold" style={{ color: hueOf(section) }}>
          {value ?? '—'}
        </span>
        <span className="text-2xs text-paper-dim">{unit}</span>
      </span>
    </Link>
  );
}

/** The hero's focal element: an open match and how close it is to kicking off. */
function FeaturedMatch({ slot, onJoin, joining }) {
  const { t, pick, formatDate, formatTime } = useI18n();
  const { user } = useAuth();
  const { navigate } = useRouter();
  if (!slot) {
    return (
      <div className="panel flex flex-col gap-3 p-5" style={accent('sports_field')}>
        <p className="text-xs text-paper-dim">{t('home.noSessions')}</p>
        <Button variant="accent" size="sm" onClick={() => navigate('/fields')}>
          {t('section.sports_field')}
        </Button>
      </div>
    );
  }
  const full = slot.playersNeeded === 0;
  return (
    <div
      className="panel flex flex-col gap-4 p-5"
      style={{ ...accent('sports_field'), borderInlineStartWidth: 3, borderInlineStartColor: hueOf('sports_field') }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-2xs text-paper-faint">{t('home.tonight')}</p>
          <p className="truncate text-base font-bold">{slot.fieldName || pick(slot.business?.name)}</p>
          <p className="num mt-0.5 text-xs text-paper-dim">
            {formatDate(slot.startsAt, { weekday: 'short' })} {formatTime(slot.startsAt)}
            {slot.city ? <span className="font-sans"> — {slot.city}</span> : null}
          </p>
        </div>
        <div className="shrink-0 text-end">
          <Money amount={slot.pricePerPerson} className="text-base font-bold" />
          <p className="text-2xs text-paper-faint">{t('quota.perPerson')}</p>
        </div>
      </div>

      <QuotaMeter joined={slot.joinedPlayers} required={slot.requiredPlayers} />

      <div className="flex flex-wrap gap-2">
        {user ? (
          <Button
            variant="accent"
            busy={joining}
            disabled={full || slot.hasJoined}
            onClick={() => onJoin(slot)}
          >
            {slot.hasJoined ? t('quota.joined') : full ? t('quota.full') : t('quota.join')}
          </Button>
        ) : (
          <Button variant="accent" onClick={() => navigate('/signup')}>
            {t('quota.join')}
          </Button>
        )}
        <Button onClick={() => navigate(`/fields/sessions/${slot.id}`)}>{t('home.seeSession')}</Button>
      </div>
    </div>
  );
}

export default function Landing() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { navigate } = useRouter();
  const [state, setState] = useState({ loading: true, summary: null, slot: null });
  const [joining, setJoining] = useState(false);

  const load = async () => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const [summary, sessions] = await Promise.all([
        api.get('/businesses/sections/summary'),
        api
          .get(withQuery('/fields/slots', { onlyJoinable: true, limit: 20 }))
          .catch(() => ({ items: [] })),
      ]);
      // Feature the match closest to kicking off — the one a visitor can
      // actually tip over the quota — rather than merely the soonest.
      const open = sessions.items ?? [];
      const featured =
        [...open].sort(
          (a, b) =>
            b.joinedPlayers / b.requiredPlayers - a.joinedPlayers / a.requiredPlayers ||
            new Date(a.startsAt) - new Date(b.startsAt),
        )[0] ?? null;
      setState({ loading: false, summary, slot: featured });
    } catch {
      setState({ loading: false, summary: null, slot: null });
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const join = async (slot) => {
    setJoining(true);
    try {
      await api.post(`/fields/slots/${slot.id}/join`, { playersCount: 1 });
      navigate(`/fields/sessions/${slot.id}`);
    } catch {
      navigate(`/fields/sessions/${slot.id}`);
    } finally {
      setJoining(false);
    }
  };

  const summary = state.summary || {};
  const unitFor = (section) =>
    ({
      open_sessions: t('home.openSessions'),
      chairs: t('home.chairs'),
      specialists: t('home.staff'),
      clinics: t('home.clinics'),
      gyms: t('home.gymsNearby'),
    })[summary[section]?.metric] ?? '';

  return (
    <>
      <main>
        {/* Hero */}
        <section className="shell pt-10 pb-4 md:pt-16">
          <div className="grid items-start gap-8 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="flex flex-col gap-6">
              <h1 className="text-3xl md:text-4xl">{t('home.title')}</h1>
              <p className="text-base text-paper-dim">{t('home.subtitle')}</p>
              {state.loading ? (
                <Loading rows={1} />
              ) : (
                <FeaturedMatch slot={state.slot} onJoin={join} joining={joining} />
              )}
              <div className="flex flex-wrap gap-2.5">
                <Button variant="primary" size="lg" onClick={() => navigate('/fields')}>
                  {t('home.cta.browse')}
                </Button>
                {user ? null : (
                  <Button size="lg" onClick={() => navigate('/signup')}>
                    {t('home.cta.join')}
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {SECTIONS.map((section) => (
                <SectionLane
                  key={section}
                  section={section}
                  value={summary[section]?.value}
                  unit={unitFor(section)}
                />
              ))}
              <Link
                to="/gyms/how-it-works"
                className="mt-1 px-5 text-2xs text-paper-dim underline decoration-ink-line underline-offset-4 transition-colors hover:text-paper"
              >
                {t('home.howPoints')}
              </Link>
            </div>
          </div>
        </section>

        {/*
          Two things here work differently from an ordinary booking site, and
          both cost money if misunderstood. They are explained on the way in
          rather than discovered at checkout.
        */}
        <section className="shell mt-20">
          <h2 className="mb-5 text-lg">{t('home.worthKnowing')}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="panel flex flex-col gap-3 p-6" style={accent('sports_field')}>
              <span
                aria-hidden="true"
                className="h-1 w-10 rounded-full"
                style={{ background: hueOf('sports_field') }}
              />
              <h3 className="text-base">{t('home.quotaTitle')}</h3>
              <p className="text-xs text-paper-dim">{t('home.quotaBody')}</p>
              <Link
                to="/fields"
                className="mt-auto pt-2 text-2xs font-semibold text-paper underline decoration-ink-line underline-offset-4"
              >
                {t('section.sports_field')}
              </Link>
            </div>
            <div className="panel flex flex-col gap-3 p-6" style={accent('gym')}>
              <span
                aria-hidden="true"
                className="h-1 w-10 rounded-full"
                style={{ background: hueOf('gym') }}
              />
              <h3 className="text-base">{t('home.pointsTitle')}</h3>
              <p className="text-xs text-paper-dim">{t('home.pointsBody')}</p>
              <Link
                to="/gyms/how-it-works"
                className="mt-auto pt-2 text-2xs font-semibold text-paper underline decoration-ink-line underline-offset-4"
              >
                {t('gym.howItWorks')}
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
