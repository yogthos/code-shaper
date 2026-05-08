/**
 * Config loader.
 *
 * Reads a JSON config (default: ./config.json) and interpolates
 * `${ENV_VAR}` references in any string field against process.env.
 * Missing env vars are reported with the JSON path where they were
 * referenced, so a multi-provider config can say "ZHIPU_API_KEY is
 * missing for providers.glm.apiKey" instead of just "ZHIPU_API_KEY".
 *
 * Missing vars do NOT throw — the caller decides what to do (tests
 * skip the provider, runtime might prompt or refuse).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ProviderOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  timeout_ms?: number;
}

export interface ProviderConfig {
  /** Endpoint URL — may include or omit /chat/completions suffix. */
  url: string;
  /** API key (literal value or `${ENV_VAR}` reference). */
  apiKey?: string;
  /** Model identifier passed in the request body. */
  model: string;
  options?: ProviderOptions;
}

export interface AgentConfig {
  providers: Record<string, ProviderConfig>;
  /** Which provider to use by default. */
  defaultProvider?: string;
}

export interface MissingEnvVar {
  /** Name of the env var that was referenced but not set. */
  name: string;
  /** Dotted JSON path (e.g. `providers.glm.apiKey`) where the
   *  reference appeared. Empty string for top-level scalar configs. */
  jsonPath: string;
}

export interface InterpolationResult<T> {
  value: T;
  missing: MissingEnvVar[];
}

const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function interpolateString(
  s: string,
  env: NodeJS.ProcessEnv,
  missing: MissingEnvVar[],
  jsonPath: string,
): string {
  return s.replace(ENV_VAR_PATTERN, (_, varName: string) => {
    const value = env[varName];
    if (value === undefined) {
      missing.push({ name: varName, jsonPath });
      return "";
    }
    return value;
  });
}

function interpolate(
  node: unknown,
  env: NodeJS.ProcessEnv,
  missing: MissingEnvVar[],
  jsonPath: string,
): unknown {
  if (typeof node === "string") {
    return interpolateString(node, env, missing, jsonPath);
  }
  if (Array.isArray(node)) {
    return node.map((item, i) =>
      interpolate(item, env, missing, joinPath(jsonPath, `[${i}]`)),
    );
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = interpolate(v, env, missing, joinPath(jsonPath, k));
    }
    return out;
  }
  return node;
}

function joinPath(base: string, key: string): string {
  if (base === "") return key;
  if (key.startsWith("[")) return `${base}${key}`;
  return `${base}.${key}`;
}

export function interpolateConfig<T>(
  raw: T,
  env: NodeJS.ProcessEnv = process.env,
): InterpolationResult<T> {
  const missing: MissingEnvVar[] = [];
  const value = interpolate(raw, env, missing, "") as T;
  return { value, missing };
}

/** Filter missing vars whose `jsonPath` falls under a given prefix.
 *  Useful for attributing missing keys to a specific provider config. */
export function missingForPath(
  result: InterpolationResult<unknown>,
  prefix: string,
): MissingEnvVar[] {
  return result.missing.filter(
    (m) => m.jsonPath === prefix || m.jsonPath.startsWith(`${prefix}.`),
  );
}

export async function loadConfig(
  configPath?: string,
): Promise<InterpolationResult<AgentConfig>> {
  const resolvedPath = path.resolve(configPath ?? "config.json");
  const raw = await readFile(resolvedPath, "utf-8");
  const parsed = JSON.parse(raw) as AgentConfig;
  return interpolateConfig(parsed);
}
