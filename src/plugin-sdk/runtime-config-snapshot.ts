/**
 * Runtime SDK subpath for config snapshot and config cache access.
 */
export { cloneRuntimeConfigSnapshot } from "../config/resolution-facts.js";
export {
  clearRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  getRuntimeConfigSnapshot,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
export {
  clearConfigCache,
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
} from "../config/io.js";
export type { OpenClawConfig } from "../config/types.js";
