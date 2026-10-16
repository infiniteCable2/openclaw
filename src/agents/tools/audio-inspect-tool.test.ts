import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createSandboxFsBridgeFromResolver } from "../test-helpers/host-sandbox-fs-bridge.js";
import { createAudioInspectTool } from "./audio-inspect-tool.js";

const fixture = vi.hoisted(() => ({
  buffer: Buffer.from("RIFFxxxxWAVE"),
  load: vi.fn(),
  probe: vi.fn(),
  analyze: vi.fn(),
  extract: vi.fn(),
  transcribe: vi.fn(),
  budget: vi.fn(),
  capture: vi.fn(),
  release: vi.fn(),
}));
// mock-isolation: Inject current-run authority without starting a Gateway or reading operator state.
vi.mock("../../gateway/operator-invocation-authority.js", () => ({
  captureAmbientGatewayOperatorAuthority: fixture.capture,
}));
// mock-isolation: Observe the real shared sandbox/root resolver without touching user media or a network.
vi.mock("../../media/web-media.js", () => ({ loadWebMedia: fixture.load }));
// mock-isolation: Keep plugin discovery outside this tool fixture; native path/sandbox policy still executes.
vi.mock("../../media/channel-inbound-roots.js", () => ({
  resolveChannelInboundAttachmentRootsForChannel: () => ["/fixture/inbound"],
}));
// mock-isolation: Bounded codec/temp lifetimes are tested at the media owner, not repeated through the tool.
vi.mock("../../media/audio-inspection.js", () => ({
  MAX_AUDIO_INSPECTION_SOURCE_BYTES: 100 * 1024 * 1024,
  probeAudioBuffer: fixture.probe,
  analyzeAudioBuffer: fixture.analyze,
  withExtractedAudioFile: fixture.extract,
}));
// mock-isolation: No provider/GPU/auth/network calls in the adapter fixture; native runtime cancellation has its own tests.
vi.mock("../../media-understanding/runtime.js", () => ({
  transcribeAudioFile: fixture.transcribe,
  resolveAudioInputBudget: fixture.budget,
}));
const workspace = path.resolve("/fixture/workspace");
let work: AsyncWorkScope;
function tool(options: Parameters<typeof createAudioInspectTool>[0] = {}) {
  const result = createAudioInspectTool({ workspaceDir: workspace, ...options });
  if (!result) {
    throw new Error("Expected enabled audio inspection");
  }
  return {
    ...result,
    execute: (...args: Parameters<typeof result.execute>) =>
      work.run(() => result.execute(...args)),
  };
}

describe("audio_inspect native adapter", () => {
  beforeEach(() => {
    work = new AsyncWorkScope();
    vi.clearAllMocks();
    fixture.capture.mockResolvedValue({ release: fixture.release });
    fixture.load.mockResolvedValue({
      buffer: fixture.buffer,
      kind: "audio",
      contentType: "audio/wav",
    });
    fixture.probe.mockResolvedValue({
      durationSeconds: 3,
      hasVideo: false,
      audioStreams: [{ index: 0 }],
    });
    fixture.analyze.mockResolvedValue({ measurement: "original-decoded-signal", rmsDbfs: -20 });
    fixture.budget.mockResolvedValue({ enabled: true, maxBytes: 10 * 1024 * 1024 });
    fixture.transcribe.mockResolvedValue({
      text: "Fixture transcript",
      provider: "fixture-stt",
      model: "fixture-model",
    });
    fixture.extract.mockImplementation(
      async (
        params: { signal?: AbortSignal },
        run: (audio: {
          path: string;
          mime: "audio/wav";
          signal?: AbortSignal;
          startSeconds: number;
          endSeconds: number;
          stream: { index: number };
        }) => Promise<unknown>,
      ) =>
        run({
          path: "/fixture/private/speech.wav",
          mime: "audio/wav",
          signal: params.signal,
          startSeconds: 1,
          endSeconds: 3,
          stream: { index: 2 },
        }),
    );
  });
  afterEach(async () => await work.drain());

  it("offers metadata without vision or a transcription provider and reads under native roots", async () => {
    const result = await tool().execute("info", { path: "sound.wav" });
    expect(result.details).toMatchObject({
      durationSeconds: 3,
      sourceData: true,
      media: { outbound: false },
    });
    expect(fixture.load).toHaveBeenCalledWith(
      path.join(workspace, "sound.wav"),
      expect.objectContaining({
        maxBytes: 100 * 1024 * 1024,
        localRoots: expect.arrayContaining([workspace]),
      }),
    );
    expect(fixture.transcribe).not.toHaveBeenCalled();
    expect(fixture.budget).not.toHaveBeenCalled();
    await work.drain();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("keeps native audio disabled/scope denial authoritative", () => {
    expect(
      createAudioInspectTool({ config: { tools: { media: { audio: { enabled: false } } } } }),
    ).toBeNull();
    expect(
      createAudioInspectTool({
        config: { tools: { media: { audio: { scope: { default: "deny" } } } } },
      }),
    ).toBeNull();
  });

  it("measures the selected original interval without STT or automatic speech enhancement", async () => {
    const result = await tool().execute("measure", {
      action: "analyze",
      path: "clip.mp4",
      streamIndex: 2,
      startSeconds: 1,
      endSeconds: 3,
      silenceThresholdDbfs: -45,
      silenceDurationSeconds: 0.5,
    });
    expect(fixture.analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: fixture.buffer,
        streamIndex: 2,
        startSeconds: 1,
        endSeconds: 3,
        silenceThresholdDbfs: -45,
        silenceDurationSeconds: 0.5,
      }),
    );
    expect(result.details).toMatchObject({ measurement: "original-decoded-signal", rmsDbfs: -20 });
    expect(fixture.transcribe).not.toHaveBeenCalled();
  });

  it("extracts a video's chosen audio stream and forwards current native STT context without a reply-mode switch", async () => {
    fixture.load.mockResolvedValue({
      buffer: fixture.buffer,
      kind: "video",
      contentType: "video/mp4",
    });
    const controller = new AbortController();
    const result = await tool({
      agentId: "example-agent",
      agentDir: "/fixture/agent",
      agentChannel: "matrix",
      agentSessionKey: "fixture:session",
      currentChatType: "direct",
    }).execute(
      "transcribe",
      {
        action: "transcribe",
        path: "media://inbound/clip.mp4",
        streamIndex: 2,
        startSeconds: 1,
        endSeconds: 3,
        language: "de",
        prompt: "Example vocabulary",
        timeoutSeconds: 60,
      },
      controller.signal,
    );
    expect(fixture.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputBytes: 10 * 1024 * 1024,
        streamIndex: 2,
        startSeconds: 1,
        endSeconds: 3,
        signal: controller.signal,
      }),
      expect.any(Function),
    );
    expect(fixture.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "/fixture/private/speech.wav",
        mime: "audio/wav",
        agentId: "example-agent",
        agentDir: "/fixture/agent",
        workspaceDir: workspace,
        scopeContext: { channel: "matrix", sessionKey: "fixture:session", chatType: "direct" },
        language: "de",
        prompt: "Example vocabulary",
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
    );
    expect(result.details).toMatchObject({
      transcript: "Fixture transcript",
      provider: "fixture-stt",
      streamIndex: 2,
      startSeconds: 1,
      endSeconds: 3,
      media: { outbound: false },
    });
    expect(result.content.every((part) => part.type === "text")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/fixture/private/speech.wav");
    expect(JSON.stringify(result)).not.toContain(fixture.buffer.toString("base64"));
  });

  it("reports absent and bounded transcripts explicitly without inventing speech/confidence", async () => {
    fixture.transcribe.mockResolvedValueOnce({
      text: undefined,
      decision: { outcome: "scope-deny" },
    });
    expect(
      (await tool().execute("none", { action: "transcribe", path: "sound.wav" })).details,
    ).toMatchObject({
      transcript: "",
      outcome: "scope-deny",
    });
    fixture.transcribe.mockResolvedValueOnce({ text: "x".repeat(110) });
    expect(
      (
        await tool().execute("bounded", {
          action: "transcribe",
          path: "sound.wav",
          maxTranscriptChars: 100,
        })
      ).details,
    ).toMatchObject({
      transcript: "x".repeat(100),
      transcriptTruncated: true,
      transcriptCharacters: 110,
    });
  });

  it.each(["https://example.test/audio.wav", "data:audio/wav;base64,AAAA", "custom:clip"])(
    "rejects nonlocal reference %s without loading media",
    async (input) => {
      await expect(tool().execute("bad", { path: input })).rejects.toThrow("local path");
      expect(fixture.load).not.toHaveBeenCalled();
    },
  );

  it("keeps workspace-only sandbox reads on the existing bridge", async () => {
    const bridge = createSandboxFsBridgeFromResolver((filePath) => ({
      containerPath: path.resolve(workspace, filePath),
      relativePath: "sound.wav",
    }));
    await tool({
      fsPolicy: { workspaceOnly: true },
      sandbox: { root: workspace, bridge },
      agentChannel: "matrix",
    }).execute("sandbox", { path: "sound.wav" });
    expect(fixture.load).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sandboxValidated: true,
        readFile: expect.any(Function),
      }),
    );
    expect(fixture.load.mock.calls[0]?.[1]).not.toHaveProperty("inboundRoots");
  });

  it("does not start STT after a disabled input budget or revoked asynchronous file read", async () => {
    fixture.budget.mockResolvedValueOnce({ enabled: false });
    await expect(
      tool().execute("disabled", { action: "transcribe", path: "sound.wav" }),
    ).rejects.toThrow("disabled");
    expect(fixture.extract).not.toHaveBeenCalled();
    let current = true;
    fixture.load.mockImplementationOnce(async () => {
      current = false;
      return { buffer: fixture.buffer, kind: "audio" };
    });
    await expect(
      tool({
        assertInvocationCurrent: () => {
          if (!current) {
            throw new Error("run closed");
          }
        },
      }).execute("closed", { action: "transcribe", path: "sound.wav" }),
    ).rejects.toThrow("run closed");
    expect(fixture.transcribe).not.toHaveBeenCalled();
  });

  it("awaits cancelled transcription and suppresses its late result before releasing authority", async () => {
    const entered = createDeferred();
    const finished = createDeferred<{ text: string }>();
    fixture.transcribe.mockImplementationOnce(() => {
      entered.resolve();
      return finished.promise;
    });
    const controller = new AbortController();
    const pending = tool().execute(
      "cancel",
      { action: "transcribe", path: "sound.wav" },
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow("cancelled source");
    await entered.promise;
    controller.abort(new Error("cancelled source"));
    expect(fixture.release).not.toHaveBeenCalled();
    finished.resolve({ text: "must not publish" });
    await rejected;
    await work.drain();
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
