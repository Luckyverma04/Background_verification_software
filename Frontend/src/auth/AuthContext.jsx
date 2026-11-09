import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getMe, getToken, login as apiLogin, setToken, setUnauthorizedHandler } from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // undefined = still checking the stored token, null = logged out
  const [user, setUser] = useState(() => (getToken() ? undefined : null));

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    if (!getToken()) return undefined;
    let alive = true;
    getMe()
      .then((u) => { if (alive) setUser(u); })
      .catch(() => { if (alive) { setToken(""); setUser(null); } });
    return () => { alive = false; };
  }, []);

  const login = useCallback(async (email, password) => {
    const { token, user: u } = await apiLogin(email, password);
    setToken(token);
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(() => {
    setToken("");
    setUser(null);
  }, []);

  // after a password change the server issues a new token
  const replaceSession = useCallback(({ token, user: u }) => {
    setToken(token);
    setUser(u);
  }, []);

  const value = useMemo(() => ({ user, login, logout, replaceSession }), [user, login, logout, replaceSession]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
