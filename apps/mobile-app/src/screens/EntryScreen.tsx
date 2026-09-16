import { useState } from 'react';
import { ENTRY_PROBLEM_COPY, type EntryProblem } from '../shopper-flow';

/**
 * Screen 1 — entry.
 *
 * One field: the code from the door. It is a credential, so the input is
 * masked, never autocompleted, never spell-checked and never offered to a
 * password manager that would keep it after the visit.
 */
export function EntryScreen({
  busy,
  problem,
  onEnter,
}: {
  busy: boolean;
  problem: EntryProblem | null;
  onEnter: (token: string) => void;
}) {
  const [token, setToken] = useState('');
  const trimmed = token.trim();
  const ready = trimmed.length >= 16 && !busy;

  return (
    <main className="screen">
      <header className="screen-head">
        <h1>Come on in</h1>
        <p className="lede">
          Enter the code shown at the door to start your visit.
        </p>
      </header>

      {problem ? (
        <div className="notice notice-problem" role="alert">
          <strong>{ENTRY_PROBLEM_COPY[problem].title}</strong>
          <p>{ENTRY_PROBLEM_COPY[problem].detail}</p>
        </div>
      ) : null}

      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            onEnter(trimmed);
          }
        }}
      >
        <label className="field">
          <span>Entry code *</span>
          <input
            type="password"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            name="entry-code"
            value={token}
            disabled={busy}
            onChange={(event) => setToken(event.target.value)}
            aria-describedby="entry-code-help"
          />
        </label>
        <p id="entry-code-help" className="help">
          Codes last a couple of minutes and work once. If yours stops working,
          ask for another.
        </p>
        <button type="submit" className="primary" disabled={!ready}>
          {busy ? 'Letting you in…' : 'Start my visit'}
        </button>
      </form>

      <p className="fine-print">
        We never ask for card details in this app. Payment is handled by the
        store.
      </p>
    </main>
  );
}
