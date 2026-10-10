/** Session-local acoustic reservations, not agent work or run authority. */
export function createSpeechInputOnset<T>() {
  const pending = new Map<
    string,
    { value: T; done: Promise<void>; release: () => void; claimed: boolean; expired: boolean }
  >();
  let closed = false;
  // Covers long utterances plus decoding, but a broken provider cannot retain
  // the native run or its audio indefinitely. Duplicate events do not renew it.
  const maxPendingMs = 120_000;
  const waitForChange = (matches: (value: T) => boolean, signal?: AbortSignal) => {
    const entries = [...pending.values()].filter((entry) => !entry.expired && matches(entry.value));
    if (closed || signal?.aborted || entries.length === 0) {
      return undefined;
    }
    let onAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // Wake on one admission so the native loop can drain that input before
    // waiting for another candidate. Waiting for all can deadlock FIFO adoption.
    return Promise.race([...entries.map((entry) => entry.done), aborted]).finally(() => {
      signal?.removeEventListener("abort", onAbort);
    });
  };
  return {
    hasPending: () => [...pending.values()].some((entry) => !entry.expired),
    waitForChange,
    begin(id: string, value: T) {
      if (closed || pending.has(id)) {
        return;
      }
      // Providers must settle each candidate. Refuse a broken lifecycle rather
      // than silently evicting a caller's still-pending speech association.
      if (pending.size >= 32) {
        throw new Error("Too many unsettled speech onsets");
      }
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entry = {
        value,
        done,
        claimed: false,
        expired: false,
        release: () => {
          if (pending.get(id) !== entry) {
            return;
          }
          pending.delete(id);
          clearTimeout(timer);
          release();
        },
      };
      const timer = setTimeout(() => {
        // Expiry releases waiting, not input identity. A late transcript must
        // still refer to its old owner, never whichever run is active now.
        entry.expired = true;
        release();
      }, maxPendingMs);
      timer.unref?.();
      pending.set(id, entry);
    },
    /** Transfer settlement from the decoder to native queue admission. */
    claim(id: string | undefined) {
      const entry = id === undefined ? undefined : pending.get(id);
      if (!entry || entry.claimed) {
        return undefined;
      }
      entry.claimed = true;
      return { value: entry.value, release: entry.release };
    },
    settle(id: string | undefined): T | undefined {
      const entry = id === undefined ? undefined : pending.get(id);
      if (!entry || entry.claimed) {
        return undefined;
      }
      entry.release();
      return entry.value;
    },
    async wait() {
      while (true) {
        const change = waitForChange(() => true);
        if (!change) {
          return;
        }
        await change;
      }
    },
    close() {
      closed = true;
      for (const entry of pending.values()) {
        entry.release();
      }
      pending.clear();
    },
  };
}
