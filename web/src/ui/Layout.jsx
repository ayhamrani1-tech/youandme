/**
 * Application shell: the top bar, the footer, and the two-column console frame
 * used by the owner and admin consoles.
 */
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { Link, useRouter } from '../router.jsx';
import { Button } from './primitives.jsx';
import { SECTION_HUES } from './sections.js';

function Wordmark() {
  const { t } = useI18n();
  return (
    <Link to="/" className="flex items-center gap-2.5" aria-label="you&me">
      <svg width="30" height="30" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="24" cy="26" r="9" fill="none" stroke="var(--color-brass)" strokeWidth="5" />
        <circle cx="40" cy="38" r="9" fill="none" stroke="var(--color-paper)" strokeWidth="5" />
      </svg>
      <span className="flex flex-col leading-none">
        <span className="font-display text-base font-bold tracking-tight">you&amp;me</span>
        <span className="text-2xs text-paper-faint">{t('brand.tagline')}</span>
      </span>
    </Link>
  );
}

const CLIENT_LINKS = [
  ['/fields', 'nav.fields', 'sports_field'],
  ['/barber', 'nav.barber', 'barber'],
  ['/salon', 'nav.salon', 'salon'],
  ['/dental', 'nav.dental', 'dental'],
  ['/gyms', 'nav.gyms', 'gym'],
];

export function TopBar() {
  const { t, toggle, locale } = useI18n();
  const { user, isAdmin, isOwner, signOut } = useAuth();
  const { navigate, pathname } = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [pathname]);

  const links = (
    <>
      {CLIENT_LINKS.map(([to, key, section]) => (
        <Link key={to} to={to} className="nav-link flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-3.5 w-0.5 rounded-full"
            style={{ background: SECTION_HUES[section] }}
          />
          {t(key)}
        </Link>
      ))}
    </>
  );

  return (
    <header className="sticky top-0 z-50 border-b border-ink-line bg-ink/92 backdrop-blur-sm">
      <div className="shell flex items-center justify-between gap-4 py-3">
        <div className="flex items-center gap-6">
          <Wordmark />
          <nav className="hidden items-center gap-0.5 lg:flex" aria-label={t('nav.explore')}>
            {links}
          </nav>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggle}
            className="nav-link font-display"
            aria-label={t('nav.languageLabel')}
            lang={locale === 'ar' ? 'en' : 'ar'}
          >
            {t('nav.language')}
          </button>

          {user ? (
            <>
              {isAdmin ? (
                <Link to="/admin" className="nav-link hidden sm:block">
                  {t('nav.admin')}
                </Link>
              ) : null}
              {isOwner ? (
                <Link to="/manage" className="nav-link hidden sm:block">
                  {t('nav.manage')}
                </Link>
              ) : null}
              <Link to="/dashboard" className="nav-link hidden sm:block">
                {t('nav.dashboard')}
              </Link>
              <div className="hidden items-center gap-2 ps-2 sm:flex">
                <span className="max-w-32 truncate text-2xs text-paper-dim">{user.fullName}</span>
                <Button size="sm" onClick={() => signOut().then(() => navigate('/'))}>
                  {t('nav.signOut')}
                </Button>
              </div>
            </>
          ) : (
            <div className="hidden items-center gap-2 sm:flex">
              <Link to="/signin" className="nav-link">
                {t('nav.signIn')}
              </Link>
              <Button variant="primary" size="sm" onClick={() => navigate('/signup')}>
                {t('nav.signUp')}
              </Button>
            </div>
          )}

          <button
            type="button"
            className="nav-link lg:hidden"
            aria-expanded={menuOpen}
            aria-label={t('nav.menu')}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>
      </div>

      {menuOpen ? (
        <div className="border-t border-ink-line bg-ink-raise lg:hidden">
          <nav className="shell flex flex-col gap-0.5 py-3" aria-label={t('nav.explore')}>
            {links}
            <div className="my-2 h-px bg-ink-line" />
            {user ? (
              <>
                <Link to="/dashboard" className="nav-link">
                  {t('nav.dashboard')}
                </Link>
                {isOwner ? (
                  <Link to="/manage" className="nav-link">
                    {t('nav.manage')}
                  </Link>
                ) : null}
                {isAdmin ? (
                  <Link to="/admin" className="nav-link">
                    {t('nav.admin')}
                  </Link>
                ) : null}
                <button
                  type="button"
                  className="nav-link text-start"
                  onClick={() => signOut().then(() => navigate('/'))}
                >
                  {t('nav.signOut')}
                </button>
              </>
            ) : (
              <>
                <Link to="/signin" className="nav-link">
                  {t('nav.signIn')}
                </Link>
                <Link to="/signup" className="nav-link">
                  {t('nav.signUp')}
                </Link>
              </>
            )}
          </nav>
        </div>
      ) : null}
    </header>
  );
}

export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="mt-20 border-t border-ink-line py-8">
      <div className="shell flex flex-wrap items-center justify-between gap-4 text-2xs text-paper-faint">
        <span>you&amp;me — {t('home.subtitle')}</span>
        <nav className="flex flex-wrap gap-4" aria-label={t('nav.explore')}>
          {CLIENT_LINKS.map(([to, key]) => (
            <Link key={to} to={to} className="transition-colors hover:text-paper">
              {t(key)}
            </Link>
          ))}
          <Link to="/gyms/how-it-works" className="transition-colors hover:text-paper">
            {t('gym.howItWorks')}
          </Link>
        </nav>
      </div>
    </footer>
  );
}

export function Page({ children, className = '' }) {
  return <main className={`shell py-8 ${className}`}>{children}</main>;
}

/** Heading block for a page: title, optional description, optional actions. */
export function PageHead({ title, description, actions, accentStyle }) {
  return (
    <div
      className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-ink-line pb-5"
      style={accentStyle}
    >
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl">{title}</h1>
        {description ? <p className="text-xs text-paper-dim">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Console frame: a left rail of sections and a content column. Used by both the
 * owner and admin consoles, which have the same shape and different content.
 */
export function Console({ title, subtitle, rail, children, aside }) {
  const [railOpen, setRailOpen] = useState(false);
  const { t } = useI18n();
  return (
    <main className="shell py-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-2xs text-paper-faint">{subtitle}</p>
          <h1 className="text-xl">{title}</h1>
        </div>
        <div className="flex gap-2">
          {aside}
          <Button size="sm" className="md:hidden" onClick={() => setRailOpen((open) => !open)}>
            {t('nav.menu')}
          </Button>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
        <aside className={`${railOpen ? 'block' : 'hidden'} md:block`}>
          <nav className="panel flex flex-col gap-0.5 p-2 md:sticky md:top-20">{rail}</nav>
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </main>
  );
}
