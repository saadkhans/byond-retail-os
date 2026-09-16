import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ShopperApiError, endVisit, enterStore, fetchBasket, leaveStore } from './api';
import { BasketScreen } from './screens/BasketScreen';
import { EntryScreen } from './screens/EntryScreen';
import { ExitScreen } from './screens/ExitScreen';
import { PaymentScreen } from './screens/PaymentScreen';
import {
  ENTRY_PROBLEM_COPY,
  initialState,
  nextState,
  outcomeIsRetryable,
  type FailureShape,
} from './shopper-flow';

/** How often the basket catches up while the shopper is in the store. */
const REFRESH_MS = 5000;

function asFailure(error: unknown): FailureShape {
  if (error instanceof ShopperApiError) {
    return { status: error.status, message: error.message };
  }
  return { status: -1, message: 'Unexpected error' };
}

/**
 * The shopper app.
 *
 * Four screens over one reducer. The component decides nothing about what
 * the shopper is told — `shopper-flow.ts` does, and it is pure, so every
 * state below is reachable from a test without a browser.
 */
export function App() {
  const [state, dispatch] = useReducer(nextState, initialState);

  // A request in flight must not be able to resurrect a screen the shopper
  // has already left.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const enter = useCallback(async (token: string) => {
    dispatch({ type: 'ENTER_SUBMITTED' });
    try {
      const view = await enterStore(token);
      dispatch({ type: 'ENTER_SUCCEEDED', view });
    } catch (error) {
      dispatch({ type: 'ENTER_FAILED', failure: asFailure(error) });
    }
  }, []);

  const leave = useCallback(async () => {
    dispatch({ type: 'EXIT_SUBMITTED' });
    try {
      const view = await leaveStore();
      dispatch({ type: 'EXIT_RESOLVED', view });
    } catch (error) {
      dispatch({ type: 'EXIT_FAILED', failure: asFailure(error) });
    }
  }, []);

  const finish = useCallback(() => {
    endVisit();
    dispatch({ type: 'RESTART' });
  }, []);

  // Catch the basket up while the shopper is still shopping. Stops the
  // moment they head for the door: after that the exit is the source of
  // truth, and a stray refresh would only fight it.
  const polling = state.phase === 'IN_STORE';
  useEffect(() => {
    if (!polling) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const view = await fetchBasket();
        if (!cancelled && live.current) {
          dispatch({ type: 'BASKET_REFRESHED', view });
        }
      } catch (error) {
        if (!cancelled && live.current) {
          dispatch({ type: 'BASKET_REFRESH_FAILED', failure: asFailure(error) });
        }
      }
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [polling]);

  switch (state.phase) {
    case 'ENTRY':
      return (
        <EntryScreen
          busy={state.busy}
          problem={state.problem}
          onEnter={enter}
        />
      );

    case 'IN_STORE':
      return (
        <BasketScreen view={state.view} stale={state.stale} onLeave={leave} />
      );

    case 'LEAVING':
      return <ExitScreen view={state.view} inFlight onRetry={leave} />;

    case 'OUTCOME':
      return outcomeIsRetryable(state.outcome) ? (
        <ExitScreen view={state.view} inFlight={false} onRetry={leave} />
      ) : (
        <PaymentScreen
          view={state.view}
          outcome={state.outcome}
          onFinish={finish}
        />
      );

    case 'ENDED':
      return (
        <main className="screen">
          <header className="screen-head">
            <h1>{ENTRY_PROBLEM_COPY[state.problem].title}</h1>
            <p className="lede">Your visit has ended.</p>
          </header>
          <div className="notice" role="status">
            <p>{ENTRY_PROBLEM_COPY[state.problem].detail}</p>
          </div>
          <button type="button" className="primary" onClick={finish}>
            Start again
          </button>
        </main>
      );
  }
}
