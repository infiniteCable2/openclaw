import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { TalkOperatorRunSource } from "./client-agent-runtime.js";
import type { TalkClientRunAuthority } from "./client-run-authority.js";

/** Controlled retained-source boundary; native run admission and terminal settlement stay real. */
export function createTestTalkRunAuthority(
  capture: TalkOperatorRunSource,
  assertCurrent: () => void = () => {},
): TalkClientRunAuthority {
  let released = false;
  const assertOpen = () => {
    if (released) {
      throw new Error("Talk caller source has closed");
    }
    assertCurrent();
  };
  return {
    operatorAuthority: undefined,
    assertCurrent: assertOpen,
    accept: assertOpen,
    async retainRun() {
      assertOpen();
      const captured = await capture({ assertCurrent });
      const assertSourceCurrent = composeSessionSourceAssertion([
        assertCurrent,
        captured?.authority.assertCurrent,
      ]);
      try {
        assertSourceCurrent();
        return {
          authority: captured?.authority,
          assertSourceCurrent,
          armCancellation() {},
          retireCancellation() {},
          release: () => captured?.release(),
        };
      } catch (error) {
        captured?.release();
        throw error;
      }
    },
    release() {
      released = true;
    },
  };
}
