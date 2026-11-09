/** Output facts stay with one operation through steering and backend replacement. */
export function createReplyOperationOutput(isCurrent: () => boolean) {
  let speechOutputOwner: object | undefined;
  let speechOutputOwnerBound = false;
  let acceptedSteeredInboundAudio = false;
  let sourceReplyDelivered = false;
  const sourceReplyListeners = new Set<() => void>();
  return {
    get speechOutputOwner() {
      return speechOutputOwner;
    },
    bindSpeechOutputOwner: (nextOwner: object | undefined) => {
      if (!isCurrent() || (speechOutputOwnerBound && speechOutputOwner !== nextOwner)) {
        throw new Error("Reply operation speech output owner is unavailable or changed");
      }
      speechOutputOwner = nextOwner;
      speechOutputOwnerBound = true;
    },
    get acceptedSteeredInboundAudio() {
      return acceptedSteeredInboundAudio;
    },
    get sourceReplyDelivered() {
      return sourceReplyDelivered;
    },
    markSteeredInputAccepted: ({ inboundAudio }: { inboundAudio: boolean }) => {
      acceptedSteeredInboundAudio ||= inboundAudio;
      sourceReplyDelivered = false;
    },
    markSourceReplyDelivered: () => {
      if (!sourceReplyDelivered) {
        sourceReplyDelivered = true;
        sourceReplyListeners.forEach((listener) => listener());
      }
    },
    onSourceReplyDelivered: (listener: () => void) => {
      sourceReplyListeners.add(listener);
      return () => sourceReplyListeners.delete(listener);
    },
  };
}
