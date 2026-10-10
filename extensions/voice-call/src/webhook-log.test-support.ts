import { expect } from "vitest";

export function createCapturingLogger() {
  const messages: string[] = [];
  const capture = (message: string) => messages.push(message);
  return {
    messages,
    logger: { info: capture, warn: capture, error: capture },
  };
}

export function expectPrivateLogMetadata(params: {
  messages: readonly string[];
  identifiers: readonly string[];
  privateText: readonly string[];
}) {
  const output = params.messages.join(" ");
  expect(output).toContain("[voice-call]");
  expect(output).toContain("chars=");
  for (const identifier of params.identifiers) {
    expect(output).toContain(identifier);
  }
  for (const privateText of params.privateText) {
    expect(output).not.toContain(privateText);
  }
}
