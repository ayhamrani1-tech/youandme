/**
 * API client.
 *
 * Holds the access token in memory and the refresh token in localStorage. On a
 * 401 it refreshes once and replays the original request, so a long session
 * never bounces the person back to the sign-in screen mid-booking.
 */
const BASE = (typeof __API_BASE__ !== 'undefined' && __API_BASE__) || '/api';
const REFRESH_KEY = 'youandme.refresh';

let accessToken = null;
let refreshPromise = null;
const listeners = new Set();

export class ApiError extends Error {
  constructor(status, payload) {
    const body = payload?.error ?? {};
    super(body.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code || (status === 0 ? 'network' : 'generic');
    this.details = body.details;
  }
}

export const getAccessToken = () => accessToken;

export function setTokens({ accessToken: access, refreshToken } = {}) {
  accessToken = access ?? null;
  try {
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
    else if (refreshToken === null) localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function getRefreshToken() {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function clearTokens() {
  accessToken = null;
  try {
    localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Notified when the session ends so the app can drop back to signed-out state. */
export function onSessionLost(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function sessionLost() {
  clearTokens();
  for (const listener of listeners) listener();
}

async function refreshSession() {
  const token = getRefreshToken();
  if (!token) return false;
  refreshPromise ??= (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!response.ok) return false;
      const data = await response.json();
      setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function send(method, path, { body, headers, locale, retry = true } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(locale ? { 'Accept-Language': locale } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: { code: 'network' } });
  }

  if (response.status === 204) return null;

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: { code: 'bad_response', message: text.slice(0, 200) } };
    }
  }

  if (response.status === 401 && retry && getRefreshToken()) {
    if (await refreshSession()) {
      return send(method, path, { body, headers, locale, retry: false });
    }
    sessionLost();
  }

  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

/** Append defined query parameters to a path. */
export function withQuery(path, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export const api = {
  get: (path, options) => send('GET', path, options),
  post: (path, body, options) => send('POST', path, { ...options, body: body ?? {} }),
  put: (path, body, options) => send('PUT', path, { ...options, body: body ?? {} }),
  patch: (path, body, options) => send('PATCH', path, { ...options, body: body ?? {} }),
  delete: (path, options) => send('DELETE', path, options),
};

/** Ask the browser for the device location. */
export function requestLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not available in this browser'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
        }),
      (error) => reject(error),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  });
}
