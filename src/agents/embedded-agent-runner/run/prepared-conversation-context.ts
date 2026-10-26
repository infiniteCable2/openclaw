import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { SAFETY_MARGIN } from "../../compaction-planning.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createFreshLlmBoundaryTokenEstimator,
  estimateMessageTokenPressure,
} from "../../sessions/context-token-pressure.js";
import { convertToLlm, type CustomMessage } from "../../sessions/messages.js";

/** Reserve optional additions without compacting or displacing the foreground request. */
export function createConversationContextCapacity(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  tools?: readonly { name: string; description: string; parameters: unknown }[];
  contextWindow: number;
  reserveTokens: number;
}): (message: CustomMessage) => boolean {
  const estimate = createFreshLlmBoundaryTokenEstimator(params);
  let reservedTokens = estimate({ messages: params.messages, prompt: "" });
  const limit = params.contextWindow - params.reserveTokens;
  return (message) => {
    // Round each marginal addition upward; never round away previously reserved capacity.
    const additionalTokens = Math.ceil(
      convertToLlm([message]).reduce(
        (tokens, projected) => tokens + estimateMessageTokenPressure(projected),
        0,
      ) * SAFETY_MARGIN,
    );
    if (reservedTokens + additionalTokens > limit) {
      return false;
    }
    reservedTokens += additionalTokens;
    return true;
  };
}

function samePacket(left: AgentMessage, right: CustomMessage): boolean {
  if (left === right) {
    return true;
  }
  if (left.role !== "custom" || left.customType !== right.customType) {
    return false;
  }
  const packetId = asOptionalRecord(right.details)?.packetId;
  return typeof packetId === "string" && asOptionalRecord(left.details)?.packetId === packetId;
}

type PacketProjection = {
  message: CustomMessage;
  anchor?: AgentMessage;
};

/**
 * A late durable packet must replay at the same position during provider steering.
 * The core reprojects its pre-dispatch snapshot, not the live session array. Keep
 * only that missing projection; native history takes over on the next iteration.
 */
export function createPreparedConversationContextProjection(session: {
  agent: { state: { messages: AgentMessage[] } };
}) {
  const packets: PacketProjection[] = [];
  let boundary: { sourceAnchor?: AgentMessage; stateAnchor?: AgentMessage } = {};
  return {
    project(messages: AgentMessage[]): AgentMessage[] {
      let projected = messages;
      for (let index = 0; index < packets.length;) {
        const { message, anchor } = packets[index]!;
        if (projected.some((candidate) => samePacket(candidate, message))) {
          // Native loop history now owns this occurrence; release its extra text/reference.
          packets.splice(index, 1);
          continue;
        }
        const anchorIndex = anchor ? projected.indexOf(anchor) : -1;
        // A rewritten/compacted prefix owns its summary. Never resurrect old copies.
        if (anchorIndex < 0) {
          packets.splice(index, 1);
          continue;
        }
        projected = [
          ...projected.slice(0, anchorIndex + 1),
          message,
          ...projected.slice(anchorIndex + 1),
        ];
        index++;
      }
      boundary = {
        sourceAnchor: projected.at(-1),
        stateAnchor: session.agent.state.messages.at(-1),
      };
      return projected;
    },
    capture() {
      return { ...boundary, stateAnchor: session.agent.state.messages.at(-1) };
    },
    install(messages: CustomMessage[], captured: typeof boundary): CustomMessage[] {
      const added: CustomMessage[] = [];
      let sourceAnchor = captured.sourceAnchor;
      let stateAnchor = captured.stateAnchor;
      for (const message of messages) {
        if (session.agent.state.messages.some((candidate) => samePacket(candidate, message))) {
          continue;
        }
        const current = session.agent.state.messages;
        const index = stateAnchor ? current.indexOf(stateAnchor) : -1;
        if (index < 0) {
          // The durable receipt is already safe; a later hydration can include it.
          continue;
        }
        session.agent.state.messages = [
          ...current.slice(0, index + 1),
          message,
          ...current.slice(index + 1),
        ];
        packets.push({ message, anchor: sourceAnchor });
        sourceAnchor = stateAnchor = message;
        added.push(message);
      }
      return added;
    },
  };
}
