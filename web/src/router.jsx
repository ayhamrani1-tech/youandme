/**
 * A small history router.
 *
 * Patterns use `:param` segments; the first match wins. Enough for this app and
 * about sixty lines, which is cheaper than a dependency.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const RouterContext = createContext(null);

function match(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

export function RouterProvider({ children }) {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }));

  useEffect(() => {
    const onPop = () =>
      setLocation({ pathname: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to, { replace = false, scroll = true } = {}) => {
    const url = new URL(to, window.location.origin);
    if (replace) window.history.replaceState({}, '', url);
    else window.history.pushState({}, '', url);
    setLocation({ pathname: url.pathname, search: url.search });
    if (scroll) window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const value = useMemo(
    () => ({
      ...location,
      query: Object.fromEntries(new URLSearchParams(location.search)),
      navigate,
    }),
    [location, navigate],
  );

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const context = useContext(RouterContext);
  if (!context) throw new Error('useRouter must be used inside RouterProvider');
  return context;
}

/** Render the first route whose pattern matches. */
export function Routes({ routes, fallback }) {
  const { pathname } = useRouter();
  for (const [pattern, render] of routes) {
    const params = match(pattern, pathname);
    if (params) return render(params);
  }
  return fallback;
}

export function Link({ to, children, className, activeClassName, exact = false, ...rest }) {
  const { navigate, pathname } = useRouter();
  const isActive = exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
  return (
    <a
      href={to}
      className={[className, isActive && activeClassName].filter(Boolean).join(' ')}
      aria-current={isActive ? 'page' : undefined}
      onClick={(event) => {
        // Let the browser handle modified clicks and external targets.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
