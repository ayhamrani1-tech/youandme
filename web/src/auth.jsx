/**
 * Session state.
 *
 * On boot, a stored refresh token is exchanged for a live session so a reload
 * keeps the person signed in. `gate` answers "may this person see this?" in one
 * place, mirroring the server's own rules rather than reimplementing them.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, clearTokens, getRefreshToken, onSessionLost, setTokens } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [businesses, setBusinesses] = useState([]);
  const [ready, setReady] = useState(false);

  const loadSession = useCallback(async () => {
    try {
      const data = await api.get('/auth/me');
      setUser(data.user);
      setBusinesses(data.businesses || []);
      return data.user;
    } catch {
      setUser(null);
      setBusinesses([]);
      return null;
    }
  }, []);

  // Restore a session from the stored refresh token.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getRefreshToken()) {
        setReady(true);
        return;
      }
      try {
        const refreshed = await api.post('/auth/refresh', { refreshToken: getRefreshToken() });
        setTokens({ accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken });
        if (!cancelled) {
          setUser(refreshed.user);
          await loadSession();
        }
      } catch {
        clearTokens();
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSession]);

  // The API client tells us when a refresh finally fails.
  useEffect(
    () =>
      onSessionLost(() => {
        setUser(null);
        setBusinesses([]);
      }),
    [],
  );

  const signIn = useCallback(
    async (email, password) => {
      const data = await api.post('/auth/login', { email, password });
      setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      setUser(data.user);
      await loadSession();
      return data.user;
    },
    [loadSession],
  );

  const signUp = useCallback(
    async (payload) => {
      const data = await api.post('/auth/register', payload);
      setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      setUser(data.user);
      await loadSession();
      return data.user;
    },
    [loadSession],
  );

  const signOut = useCallback(async () => {
    const refreshToken = getRefreshToken();
    try {
      await api.post('/auth/logout', { refreshToken });
    } catch {
      /* signing out locally is enough */
    }
    clearTokens();
    setUser(null);
    setBusinesses([]);
  }, []);

  const value = useMemo(() => {
    const role = user?.role ?? null;
    return {
      user,
      businesses,
      ready,
      role,
      isAdmin: role === 'admin',
      isOwner: role === 'owner' || role === 'admin',
      isClient: role === 'client',
      signIn,
      signUp,
      signOut,
      refresh: loadSession,
      setUser,
      /**
       * Whether this person may enter a section. Mirrors the server: the men's
       * barber shop is male-only and the women's salon female-only, with admins
       * exempt.
       */
      gate(section) {
        if (section !== 'barber' && section !== 'salon') return { allowed: true };
        if (!user) return { allowed: false, reason: 'sign_in_required' };
        if (user.role === 'admin') return { allowed: true };
        const required = section === 'barber' ? 'male' : 'female';
        if (user.gender === required) return { allowed: true };
        return {
          allowed: false,
          reason: section === 'barber' ? 'male_only_section' : 'female_only_section',
        };
      },
    };
  }, [user, businesses, ready, signIn, signUp, signOut, loadSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
