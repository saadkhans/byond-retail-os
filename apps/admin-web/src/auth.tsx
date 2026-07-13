import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import {
  api,
  clearToken,
  getToken,
  SafeUser,
  setToken as persistToken,
} from './api';

interface AuthState {
  /** Authenticated user, null while logged out, undefined while loading. */
  user: SafeUser | null | undefined;
  loginWithPassword(email: string, password: string): Promise<void>;
  loginWithToken(token: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SafeUser | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      return;
    }
    try {
      setUser(await api<SafeUser>('/auth/me'));
    } catch {
      // Expired/invalid token — drop it rather than looping on 401s.
      clearToken();
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loginWithPassword = useCallback(
    async (email: string, password: string) => {
      const result = await api<{ accessToken: string; user: SafeUser }>(
        '/auth/login',
        { method: 'POST', body: { email, password } },
      );
      persistToken(result.accessToken);
      setUser(result.user ?? (await api<SafeUser>('/auth/me')));
    },
    [],
  );

  const loginWithToken = useCallback(async (token: string) => {
    persistToken(token.trim());
    try {
      setUser(await api<SafeUser>('/auth/me'));
    } catch (error) {
      clearToken();
      setUser(null);
      throw error;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // Best-effort audit; the token is dropped regardless.
    }
    clearToken();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loginWithPassword, loginWithToken, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return value;
}
