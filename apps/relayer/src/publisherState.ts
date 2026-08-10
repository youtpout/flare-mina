/**
 * What the publisher is doing right now, for the UI.
 *
 * Everything waiting on a publication shares one fate, so this is global rather
 * than per row: a burn sitting at "seen" is not waiting on anything of its own,
 * it is waiting on the next publication cycle.
 *
 * It exists because "awaiting publication" was shown for fifteen minutes
 * whatever happened underneath — including four consecutive rejections, which
 * looked exactly like waiting. A status that cannot express failure is not a
 * status.
 */

export type PublisherPhase =
  | 'idle'
  | 'requesting'
  | 'waiting-round'
  | 'proving'
  | 'publishing'
  | 'included'
  | 'failed';

export type PublisherState = {
  phase: PublisherPhase;
  /** When this phase began, ISO. */
  since: string;
  /** FDC voting round, once one has been requested. */
  round?: number;
  /** Why the last cycle failed. Kept through later phases so it stays visible. */
  error?: string;
  /** Consecutive failed cycles; back to zero on the first success. */
  failures: number;
};

let state: PublisherState = { phase: 'idle', since: new Date().toISOString(), failures: 0 };

export function publisherState(): PublisherState {
  return state;
}

export function setPublisherPhase(phase: PublisherPhase, extra?: Partial<PublisherState>): void {
  state = {
    ...state,
    ...extra,
    phase,
    since: new Date().toISOString(),
    // A new cycle clears the previous reason; a failure sets its own.
    error: phase === 'failed' ? (extra?.error ?? state.error) : undefined,
    failures: phase === 'failed' ? state.failures + 1 : phase === 'included' ? 0 : state.failures,
  };
}
