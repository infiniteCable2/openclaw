/** Session-local acoustic reservations, not agent work or run authority. */
export function createMeetingInputOnset<T>() {
  const pending = new Map<string, { value: T; done: Promise<void>; resolve: () => void }>();
  let closed = false;
  return {
    hasPending: () => pending.size > 0,
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
      pending.set(id, { value, done, resolve: release });
    },
    settle(id: string | undefined): T | undefined {
      const entry = id === undefined ? undefined : pending.get(id);
      if (!entry || id === undefined) {
        return undefined;
      }
      pending.delete(id);
      entry.resolve();
      return entry.value;
    },
    async wait() {
      while (true) {
        if (closed || pending.size === 0) {
          return;
        }
        await Promise.all([...pending.values()].map((entry) => entry.done));
      }
    },
    close() {
      closed = true;
      for (const entry of pending.values()) {
        entry.resolve();
      }
      pending.clear();
    },
  };
}
