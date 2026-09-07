import { FormEvent, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';

export function LoginPage() {
  const { loginWithPassword, loginWithToken } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [mode, setMode] = useState<'password' | 'token'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'password') {
        await loginWithPassword(email, password);
      } else {
        await loginWithToken(token);
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>
          <span className="brand-mark" aria-hidden="true">
            BY
          </span>
          BYOND Admin
        </h1>
        <p className="muted" style={{ margin: 0 }}>
          Sign in to the retail operations console.
        </p>
        {error ? <div className="error">{error}</div> : null}
        {mode === 'password' ? (
          <>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </>
        ) : (
          <input
            type="password"
            placeholder="Paste an access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'password' ? 'token' : 'password');
            setError(null);
          }}
        >
          {mode === 'password'
            ? 'Use an access token instead'
            : 'Use email + password instead'}
        </button>
      </form>
    </div>
  );
}
