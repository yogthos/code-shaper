/**
 * Global language-adapter registry. Built-in adapters self-register at
 * import time (see `./index.ts`); host code can also register custom
 * adapters at runtime.
 */

import path from "node:path";
import type { LanguageAdapter } from "./types.js";

const adaptersByLanguage = new Map<string, LanguageAdapter>();
const adaptersByExtension = new Map<string, LanguageAdapter>();

export function registerAdapter(adapter: LanguageAdapter): void {
  adaptersByLanguage.set(adapter.language, adapter);
  for (const ext of adapter.extensions) {
    adaptersByExtension.set(ext.toLowerCase(), adapter);
  }
}

export function getAdapterForFile(filePath: string): LanguageAdapter | null {
  const ext = path.extname(filePath).toLowerCase();
  return adaptersByExtension.get(ext) ?? null;
}

export function getAdapterByLanguage(language: string): LanguageAdapter | null {
  return adaptersByLanguage.get(language) ?? null;
}

export function getRegisteredExtensions(): string[] {
  return Array.from(adaptersByExtension.keys());
}

export function clearAdapters(): void {
  adaptersByLanguage.clear();
  adaptersByExtension.clear();
}
