import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ChannelMessageActionContext } from "../../channels/plugins/types.public.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { readEmbeddedMessageDeliveryFact } from "../embedded-agent-message-delivery.js";
import { jsonResult } from "./common.js";
import { createMessageTool } from "./message-tool-execution.js";
import {
  registerMessageChannel,
  stubMessageSecrets,
} from "./message-tool-execution.test-support.js";

const chat = "!example-private:example.test";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5m8gAAAABJRU5ErkJggg==",
  "base64",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createSpeechTool({
  sourceReplyOnly = false,
  workspace,
}: {
  sourceReplyOnly?: boolean;
  workspace?: string;
} = {}) {
  const config: OpenClawConfig = {
    channels: { matrix: { enabled: true } },
    ...(workspace ? { agents: { entries: { main: { workspace } } } } : {}),
  };
  const handleAction = vi.fn(async ({ params }: ChannelMessageActionContext) =>
    jsonResult({ ok: true, messageId: "example-confirmed-send", to: params.to }),
  );
  registerMessageChannel({
    ...createChannelTestPluginBase({
      id: "matrix",
      capabilities: { chatTypes: ["direct"], media: true },
      config: { isConfigured: () => true },
    }),
    messaging: { targetResolver: { looksLikeId: (target) => target === chat } },
    actions: { describeMessageTool: () => ({ actions: ["send"] }), handleAction },
  });
  setRuntimeConfigSnapshot(config);
  const runId = "example-voice-run";
  const sessionId = "example-voice-session";
  const deliverSpeech = vi.fn(async () => {});
  const tool = createMessageTool({
    config,
    agentId: "main",
    agentSessionKey: "agent:main:webchat:dm:example-assistant",
    runId,
    sessionId,
    currentChannelProvider: "webchat",
    sourceReplyOnly,
    requireExplicitTarget: true,
    currentSourceReplyTarget: {
      runId,
      sessionId,
      assertCurrent() {},
      speechUtteranceOnly: true,
      deliver: deliverSpeech,
    },
  });
  return { tool, handleAction, deliverSpeech };
}

beforeEach(stubMessageSecrets);
afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

describe("addressed chat from a speech turn", () => {
  it.each([
    { kind: "text", attachImage: false },
    { kind: "image", attachImage: true },
  ])("keeps the spoken reply separate from an addressed $kind send", async ({ attachImage }) => {
    const workspace = tempDirs.make("openclaw-speech-send-");
    const media = attachImage ? path.join(workspace, "frame.png") : undefined;
    if (media) {
      await fs.writeFile(media, png);
    }
    const { tool, handleAction, deliverSpeech } = createSpeechTool({ workspace });
    const sent = await tool.execute("chat", {
      action: "send",
      channel: "matrix",
      target: chat,
      message: "A private test message.",
      ...(media ? { media } : {}),
    });
    expect(handleAction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "matrix",
        params: expect.objectContaining({
          to: chat,
          message: "A private test message.",
          ...(media ? { media } : {}),
        }),
      }),
    );
    expect(deliverSpeech).not.toHaveBeenCalled();
    expect(readEmbeddedMessageDeliveryFact(sent)?.sourceReplyDelivered).not.toBe(true);
    const progress = await tool.execute("progress", {
      action: "send",
      message: "The chat received it.",
      final: false,
      replyPhase: "commentary",
    });
    expect(deliverSpeech).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "The chat received it." }),
      expect.objectContaining({ final: false, phase: "commentary" }),
    );
    expect(readEmbeddedMessageDeliveryFact(progress)?.sourceReplyDelivered).not.toBe(true);
    await tool.execute("speech", { action: "send", message: "It's in the chat." });
    expect(deliverSpeech).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "It's in the chat." }),
      expect.objectContaining({ final: true, phase: "final_answer" }),
    );
    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("requires an actual destination for an attachment and respects a source-only run", async () => {
    const ordinary = createSpeechTool();
    await expect(
      ordinary.tool.execute("implicit-media", {
        action: "send",
        message: "Example",
        media: "frame.png",
      }),
    ).rejects.toThrow("specify the destination channel and exact chat target");
    expect(ordinary.handleAction).not.toHaveBeenCalled();
    expect(ordinary.deliverSpeech).not.toHaveBeenCalled();

    const sourceOnly = createSpeechTool({ sourceReplyOnly: true });
    await expect(
      sourceOnly.tool.execute("explicit-media", {
        action: "send",
        channel: "matrix",
        target: chat,
        media: "frame.png",
      }),
    ).rejects.toThrow("cannot address another destination");
    expect(sourceOnly.handleAction).not.toHaveBeenCalled();
    expect(sourceOnly.deliverSpeech).not.toHaveBeenCalled();
  });
});
