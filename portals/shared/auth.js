import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshAccessToken, logoutSession, logoutAllSessions } from './api.js';

// Normalize a login/register/google response into a stored session.
export function sessionFromAuth(data) {
  return {
    user: data.user,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || null,
    expiresAt: Date.now() + (data.expiresInSeconds ? data.expiresInSeconds * 1000 : 15 * 60 * 1000)
  };
}

// Session is persisted per-portal so that two portals open in the same browser
// do not overwrite each other's login. The storage key includes the portal role.
export function useSession(portalRole) {
  const storageKey = `medrec.session.${portalRole}`;
  const [session, setSession] = useState(null);
  const sessionRef = useRef(session);
  const refreshingRef = useRef(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        setSession(JSON.parse(raw));
      }
    } catch {
      // ignore malformed storage
    }
  }, [storageKey]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const saveSession = useCallback((next) => {
    setSession(next);
    try {
      if (next) {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } else {
        window.localStorage.removeItem(storageKey);
      }
    } catch {
      // storage may be unavailable (private mode); session still lives in memory
    }
  }, [storageKey]);

  const signOut = useCallback(async () => {
    const current = sessionRef.current;
    if (current?.accessToken && current?.refreshToken) {
      try {
        await logoutSession(current.accessToken, current.refreshToken);
      } catch {
        // network or server error; discard client credentials regardless
      }
    }
    saveSession(null);
  }, [saveSession]);

  const signOutEverywhere = useCallback(async () => {
    const current = sessionRef.current;
    if (current?.accessToken) {
      try {
        await logoutAllSessions(current.accessToken);
      } catch {
        // discard local credentials even if request failed
      }
    }
    saveSession(null);
  }, [saveSession]);

  // Auto-refresh the access token one minute before it expires so portals do
  // not drop the user mid-session (access tokens live for 15 minutes).
  useEffect(() => {
    if (!session || refreshingRef.current) return undefined;
    const { refreshToken, expiresAt } = session;
    if (!refreshToken || !expiresAt) return undefined;

    const msLeft = expiresAt - Date.now();
    if (msLeft <= 0) return undefined;

    const timer = setTimeout(async () => {
      refreshingRef.current = true;
      try {
        const result = await refreshAccessToken(refreshToken);
        if (result?.accessToken && sessionRef.current?.refreshToken === refreshToken) {
          saveSession({
            ...sessionRef.current,
            accessToken: result.accessToken,
            // Rotation: the backend retires the presented refresh token, so the
            // replacement must be persisted or the next refresh gets a 401.
            refreshToken: result.refreshToken || refreshToken,
            expiresAt: Date.now() + (result.expiresInSeconds ? result.expiresInSeconds * 1000 : 15 * 60 * 1000)
          });
        }
      } catch {
        // refresh failed; the next 401 forces a normal sign-out path
      } finally {
        refreshingRef.current = false;
      }
    }, Math.max(msLeft - 60 * 1000, 5000));

    return () => clearTimeout(timer);
  }, [session, saveSession]);

  return { session, saveSession, signOut, signOutEverywhere };
}

// Returns true when the signed-in user matches the role a portal is locked to.
export function roleAllowed(userRole, allowedRoles) {
  if (!userRole) return false;
  return allowedRoles.map((role) => role.toLowerCase()).includes(String(userRole).toLowerCase());
}