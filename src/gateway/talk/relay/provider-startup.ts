import type { CreateTalkRealtimeRelaySessionParams } from "./state.js";

/** The provider's real asynchronous connection, not its synchronous handle, accepts startup data. */
export function createRelayProviderStartup(
  context: CreateTalkRealtimeRelaySessionParams["startupContext"],
  warn: (message: string) => void,
) {
  let held = context;
  const assertCurrent = () => held?.assertCurrent();
  return {
    assertCurrent,
    async connect(bridge: { connect(): Promise<void> }): Promise<void> {
      try {
        assertCurrent();
        await bridge.connect();
        assertCurrent();
      } finally {
        const original = held;
        held = undefined;
        try {
          await original?.release();
        } catch {
          // Cleanup does not recategorize an accepted connection or retry a provider request.
          warn("Talk provider startup context release failed after connection settlement");
        }
      }
    },
  };
}
