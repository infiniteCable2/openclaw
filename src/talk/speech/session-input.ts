import type { SpeechAudioTransport } from "./transport.js";

/** Capture startup remains owned until teardown has joined any pending acquisition. */
export function createSpeechSessionInput(transport: SpeechAudioTransport) {
  let starting: Promise<void> | undefined;
  return {
    async start(onAudio: (audio: Buffer) => void, assertCurrent: () => void) {
      assertCurrent();
      const acquisition = Promise.resolve().then(() => {
        assertCurrent();
        return transport.startInput(onAudio);
      });
      starting = acquisition;
      try {
        await acquisition;
        assertCurrent();
      } finally {
        if (starting === acquisition) {
          starting = undefined;
        }
      }
    },
    async stop() {
      const acquisition = starting;
      // Stop may unblock startup, but a late acquisition must also be stopped
      // before the caller can dispose capture or report the session closed.
      await transport.stop();
      if (acquisition) {
        await acquisition.catch(() => undefined);
        await transport.stop();
      }
    },
  };
}
