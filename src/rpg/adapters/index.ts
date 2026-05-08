/**
 * Built-in language adapters. Importing this module registers them.
 *
 * Adding a new language:
 *   1. Implement `LanguageAdapter` in `./<lang>.ts`.
 *   2. Add a `registerAdapter(<langAdapter>)` call here.
 *   3. Add npm dep for the tree-sitter grammar (or alt parser).
 */

import { registerAdapter } from "./registry.js";
import { typescriptAdapter } from "./typescript.js";

registerAdapter(typescriptAdapter);

export {
  registerAdapter,
  getAdapterForFile,
  getAdapterByLanguage,
  getRegisteredExtensions,
  clearAdapters,
} from "./registry.js";
export type { LanguageAdapter, ExtractedFile } from "./types.js";
