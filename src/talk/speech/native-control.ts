import type { RealtimeVoiceAgentControlMode } from "../agent-run-control-shared.js";
import type {
  ConversationInputAdmissionV1,
  ConversationInputScopeV1,
} from "../conversation-input.types.js";
import type { SpeechSessionHandle } from "./types.js";

const nativeControl = Symbol("native-speech-control");
const admittedInput = Symbol("admitted-speech-control-input");

/** Internal host handoff. The opaque original admission, not this property, grants input authority. */
export type AdmittedSpeechControl = {
  admission: ConversationInputAdmissionV1;
  scope: ConversationInputScopeV1;
  text: string;
  mode: RealtimeVoiceAgentControlMode;
  /** Additional request checks never replace the opaque original admission. */
  assertInputCurrent?: () => void;
  signal?: AbortSignal;
};

type NativeControl = (input: AdmittedSpeechControl) => ReturnType<SpeechSessionHandle["steer"]>;
type NativeHandle = SpeechSessionHandle & { [nativeControl]?: NativeControl };
type AdmittedInput = { [admittedInput]?: AdmittedSpeechControl };

export function bindNativeSpeechControl(handle: SpeechSessionHandle, control: NativeControl): void {
  // Programmatic task injection uses the native conversation tools. This media handle
  // does not mint a new user input on behalf of an unauthenticated caller.
  handle.steer = async () => {
    throw new Error("Use the admitted native conversation input to steer this session");
  };
  Object.defineProperty(handle, nativeControl, { value: control });
}

export function controlAdmittedSpeechSession(handle: NativeHandle, input: AdmittedSpeechControl) {
  if (!handle[nativeControl]) {
    throw new Error("Native speech control is unavailable");
  }
  return handle[nativeControl](input);
}

export function bindAdmittedSpeechInput<T extends object>(
  input: T,
  control?: AdmittedSpeechControl,
): T {
  return control ? Object.assign(input, { [admittedInput]: control }) : input;
}

export function readAdmittedSpeechInput(
  input: object & AdmittedInput,
): AdmittedSpeechControl | undefined {
  return input[admittedInput];
}
