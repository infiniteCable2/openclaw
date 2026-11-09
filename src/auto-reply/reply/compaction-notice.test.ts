import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { resolveUserMessages } from "../../shared/user-messages.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import {
  createCompactionHookNoticePayload,
  createCompactionNoticePayload,
  createDirectCompactionNoticeSender,
  isCompactionNoticePending,
  shouldNotifyUserAboutCompaction,
  type CompactionNoticeTurn,
} from "./compaction-notice.js";

const cfg: OpenClawConfig = { agents: { defaults: { compaction: { notifyUser: true } } } };
const userTurn: CompactionNoticeTurn = { followupRun: { run: {} }, isHeartbeat: false };

describe("compaction notice audience", () => {
  it.each<CompactionNoticeTurn>([
    { ...userTurn, isHeartbeat: true },
    { ...userTurn, opts: { internalEventExecution: {} } },
    { ...userTurn, followupRun: { run: { inputProvenance: { kind: "internal_system" } } } },
    { ...userTurn, followupRun: { run: { inputProvenance: { kind: "inter_session" } } } },
    { ...userTurn, followupRun: { run: {}, currentInboundEventKind: "room_event" } },
  ])("does not notify automatic work even with the global setting enabled (%j)", async (turn) => {
    const onBlockReply = vi.fn();
    const onCompactionNotice = vi.fn();
    const send = createDirectCompactionNoticeSender({
      cfg,
      turn,
      opts: { onBlockReply, onCompactionNotice },
    });
    expect(shouldNotifyUserAboutCompaction(cfg, turn)).toBe(false);
    await send("start");
    await send("end");
    await send("context_bounded");
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onCompactionNotice).not.toHaveBeenCalled();
  });

  it("binds every received request's status to its own message and uses the dedicated sink", async () => {
    const onBlockReply = vi.fn();
    const onCompactionNotice = vi.fn();
    for (const currentMessageId of ["request-one", "request-two"]) {
      await createDirectCompactionNoticeSender({
        cfg,
        turn: userTurn,
        currentMessageId,
        opts: { onBlockReply, onCompactionNotice },
      })("queued");
    }
    expect(onCompactionNotice).toHaveBeenCalledTimes(2);
    expect(onCompactionNotice).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replyToId: "request-one",
        isCompactionNotice: true,
      }),
    );
    expect(onCompactionNotice).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replyToId: "request-two",
        isCompactionNotice: true,
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("keeps optional notices off by default and delivery failures nonfatal", async () => {
    const onCompactionNotice = vi.fn(async () => {
      throw new Error("closed sink");
    });
    await createDirectCompactionNoticeSender({
      cfg: {},
      turn: userTurn,
      opts: { onCompactionNotice },
    })("queued");
    expect(onCompactionNotice).not.toHaveBeenCalled();
    await expect(
      createDirectCompactionNoticeSender({
        cfg,
        turn: userTurn,
        opts: { onCompactionNotice },
      })("start"),
    ).resolves.toBeUndefined();
    expect(onCompactionNotice).toHaveBeenCalledOnce();
  });

  it("does not reroute an existing speech presentation without a status hook", async () => {
    const onBlockReply = vi.fn();
    const speechPresentation = {
      speakCommentary: false,
      onError: vi.fn(),
      openRun: () => ({
        onBlockReply: () => {},
        finish: async () => {},
        abort: async () => {},
        close: () => {},
      }),
    };
    await createDirectCompactionNoticeSender({
      cfg,
      turn: { ...userTurn, followupRun: { ...userTurn.followupRun, speechPresentation } },
      opts: { onBlockReply },
    })("start");
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it.each(["completed", "throws"] as const)(
    "does not bypass the original request guard when it %s",
    async (state) => {
      const nakedSourceNotice = vi.fn();
      const requestNotice = vi.fn(async () => {
        if (state === "throws") {
          throw new Error("original request output closed");
        }
        // The native request's completed guard deliberately drops this status.
      });
      await createDirectCompactionNoticeSender({
        cfg,
        turn: {
          ...userTurn,
          followupRun: {
            ...userTurn.followupRun,
            speechPresentation: {
              speakCommentary: false,
              onCompactionNotice: nakedSourceNotice,
              onError: vi.fn(),
              openRun: () => ({
                onBlockReply: () => {},
                finish: async () => {},
                abort: async () => {},
                close: () => {},
              }),
            },
          },
        },
        opts: { onCompactionNotice: requestNotice },
      })("end");
      expect(requestNotice).toHaveBeenCalledOnce();
      expect(nakedSourceNotice).not.toHaveBeenCalled();
    },
  );

  it("observes only a currently open native compaction", () => {
    const operation = createReplyOperation({
      sessionKey: "synthetic-compaction",
      sessionId: "synthetic-session",
      resetTriggered: false,
    });
    let compacting = false;
    try {
      expect(isCompactionNoticePending(undefined)).toBe(false);
      expect(isCompactionNoticePending(operation)).toBe(false);
      operation.setPhase("preflight_compacting");
      expect(isCompactionNoticePending(operation)).toBe(true);
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        cancel: () => {},
        isCompacting: () => compacting,
      });
      expect(isCompactionNoticePending(operation)).toBe(false);
      compacting = true;
      expect(isCompactionNoticePending(operation)).toBe(true);
      operation.complete();
      expect(isCompactionNoticePending(operation)).toBe(false);
    } finally {
      operation.complete();
    }
  });
});

describe("native compaction copy", () => {
  it.each(["start", "queued"] as const)("uses the configured German %s template", (phase) => {
    const payload = createCompactionNoticePayload({ phase, language: "de-DE" });
    expect(payload.text).toBe(resolveUserMessages("de").compactionNotice[phase]);
    expect(getReplyPayloadMetadata(payload)?.nativeCompactionNotice).toBe(true);
  });

  it.each([undefined, "en-US", "fr-FR"])("keeps English fallback for %s", (language) => {
    expect(createCompactionNoticePayload({ phase: "start", language }).text).toBe(
      resolveUserMessages("en").compactionNotice.start,
    );
  });

  it.each([false, true])("localizes degraded summaries (refused=%s)", (summaryRefused) => {
    const payload = createCompactionNoticePayload({
      phase: "degraded",
      summaryRefused,
      language: "de-DE",
    });
    expect(payload.text).toBe(
      resolveUserMessages("de").compactionNotice[summaryRefused ? "summaryRefused" : "degraded"],
    );
    expect(getReplyPayloadMetadata(payload)?.nativeCompactionNotice).toBe(true);
  });

  it("does not mark arbitrary hook/override text as a native translated template", () => {
    const override = createCompactionNoticePayload({ phase: "start", text: "Custom hook" });
    const hook = createCompactionHookNoticePayload({ messages: ["Custom hook"] });
    expect(getReplyPayloadMetadata(override)?.nativeCompactionNotice).toBeUndefined();
    expect(hook && getReplyPayloadMetadata(hook)?.nativeCompactionNotice).toBeUndefined();
  });
});
