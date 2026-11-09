/**
 * Runtime SDK subpath for config snapshot and config cache access.
 */
export { cloneRuntimeConfigSnapshot } from "../config/resolution-facts.js";
export { createRuntimeConfigSnapshotMatcher } from "../config/runtime-config-snapshot-match.js";
export {
  clearRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  getRuntimeConfigSnapshot,
  readRuntimeConfig,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
export {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  getRuntimeConfigSourceSnapshot,
} from "../config/io.js";
export { getRuntimeConfig } from "./runtime-config-legacy.js";
export type { OpenClawConfig } from "../config/types.js";
