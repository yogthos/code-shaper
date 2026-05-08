// Public surface for the RPG layer.

// Importing the adapter index also self-registers the built-in TS adapter
// — keep it first so the registry is populated before any consumer
// imports `loadRepo`.
import "./adapters/index.js";

export * from "./types.js";
export { loadRepo } from "./load.js";
export {
  safeResolve,
  isSafePath,
  PathEscapeError,
} from "./safe-path.js";
export type { LoadOptions } from "./load.js";
export { materializeRPG } from "./materialize.js";
export type { MaterializeReport } from "./materialize.js";
export {
  registerAdapter,
  getAdapterForFile,
  getAdapterByLanguage,
  getRegisteredExtensions,
  clearAdapters,
} from "./adapters/index.js";
export type { LanguageAdapter, ExtractedFile } from "./adapters/index.js";
