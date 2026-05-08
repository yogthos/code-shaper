/**
 * Phase 4 — file-structure encoding.
 *
 * Promotes the capability tree's non-leaf nodes into folder/file
 * structure: each top-level capability becomes a folder, each non-leaf
 * descendant becomes a file. Leaves stay as capability nodes until
 * Phase 5 (interface design) turns them into functions/methods.
 *
 * Mapping policy (option-b from the design discussion):
 *   - Capability stays in the RPG; we set `status = "mapped"` and
 *     `mappedToId = <new folder/file id>`. The original feature
 *     description is preserved for traceability.
 *   - A fresh FolderNode / FileNode is created (or reused if a node at
 *     that path already exists — supports extend mode and projects
 *     where Phase 1 loaded an existing skeleton).
 *
 * Restructuring of existing files (move/rename/split/merge) is NOT
 * handled here — see Task #9. This phase only adds; Phase 8 / future
 * Phase 4.5 will rearrange.
 */

import type { LLMClient } from "../llm/types.js";
import { getAdapterForFile, getRegisteredExtensions } from "../rpg/index.js";
import {
  isCapability,
  isFile,
  isFolder,
  type CapabilityNode,
  type FileNode,
  type FolderNode,
  type NodeId,
  type RPG,
} from "../rpg/types.js";
import {
  STRUCTURE_SYSTEM_PROMPT,
  buildStructureUserPrompt,
  renderStructurePromptBody,
} from "./structure-prompts.js";
import path from "node:path";

export interface StructureInput {
  /** Project description — same string the proposal stage saw. Used
   *  by the architect for path-naming context. */
  description: string;
  mode?: "greenfield" | "extend";
  maxAttempts?: number;
  temperature?: number;
}

export interface StructureResult {
  ok: boolean;
  /** Paths created (or already present) by capability id. Only entries
   *  where mapping succeeded appear here. */
  mappings: Array<{ capabilityId: NodeId; nodeId: NodeId; kind: "folder" | "file"; path: string }>;
  /** Capability ids that needed mapping but didn't get one (LLM
   *  silently skipped them). Empty when ok=true. */
  unmappedRequired: NodeId[];
  /** Reason `ok` is false; empty when `ok` is true. */
  error?: string;
  attempts: number;
  /** The validated raw mapping list returned by the LLM, useful for
   *  diagnostics and tests. */
  plan?: StructurePlan;
}

export interface StructurePlan {
  mappings: StructureMapping[];
}

export interface StructureMapping {
  capabilityId: NodeId;
  kind: "folder" | "file";
  path: string;
}

export async function encodeFileStructure(
  client: LLMClient,
  rpg: RPG,
  input: StructureInput,
): Promise<StructureResult> {
  const mode = input.mode ?? "greenfield";
  const maxAttempts = input.maxAttempts ?? 2;

  const required = collectRequiredMappings(rpg);
  const mappable = collectMappableCapabilities(rpg);
  if (required.length === 0) {
    // Nothing to do — every non-leaf capability is already mapped (or
    // there are no non-leaf capabilities). Treat as success with an
    // empty plan.
    return {
      ok: true,
      mappings: [],
      unmappedRequired: [],
      attempts: 0,
      plan: { mappings: [] },
    };
  }

  const allowedExtensions = getRegisteredExtensions();
  const body = renderStructurePromptBody(rpg);
  const userPrompt = buildStructureUserPrompt({
    projectDescription: input.description,
    mode,
    allowedExtensions,
    body,
  });

  let lastError: string | null = null;
  let lastResponse: string | null = null;
  let plan: StructurePlan | null = null;
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [
      { role: "system", content: STRUCTURE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];
    if (lastError !== null && lastResponse !== null) {
      messages.push({ role: "assistant", content: lastResponse });
      messages.push({
        role: "user",
        content: `Your previous response failed validation: ${lastError}\nReturn corrected JSON now.`,
      });
    }
    const response = await client.chat(messages, {
      responseFormat: { type: "json_object" },
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
    });
    const parsed = parseStructureResponse(
      response.content,
      mappable,
      allowedExtensions,
      rpg,
    );
    if (parsed.ok) {
      plan = parsed.plan;
      break;
    }
    lastError = parsed.error;
    lastResponse = response.content;
  }

  if (!plan) {
    return {
      ok: false,
      mappings: [],
      unmappedRequired: required.map((c) => c.id),
      error: lastError ?? "no plan produced",
      attempts,
    };
  }

  // Apply the validated plan: create/reuse folder/file nodes, update
  // capability statuses. Implicit intermediate folders are backfilled.
  const applied = applyStructurePlan(rpg, plan);
  const requiredIds = new Set(required.map((c) => c.id));
  for (const m of applied) requiredIds.delete(m.capabilityId);
  return {
    ok: requiredIds.size === 0,
    mappings: applied,
    unmappedRequired: [...requiredIds],
    error:
      requiredIds.size > 0
        ? `LLM omitted ${requiredIds.size} required mapping(s)`
        : undefined,
    attempts,
    plan,
  };
}

// ── Required-mapping discovery ───────────────────────────────────────

/** Capabilities that need a path: every non-leaf capability whose
 *  status is still "planned". Leaves are NOT required — they're
 *  optional in Phase 4 and become functions inside their ancestor file
 *  in Phase 5. Architects MAY still map a leaf to a file (creating a
 *  single-function module), validation accepts that.
 *  Already-mapped capabilities are skipped to keep extend-mode runs
 *  idempotent. */
function collectRequiredMappings(rpg: RPG): CapabilityNode[] {
  const out: CapabilityNode[] = [];
  for (const node of Object.values(rpg.nodes)) {
    if (!isCapability(node)) continue;
    if (node.isLeaf) continue;
    if (node.status === "mapped") continue;
    out.push(node);
  }
  return out;
}

/** All capabilities the architect is *allowed* to map: planned (not
 *  yet mapped), regardless of leaf status. Required ⊂ mappable. */
function collectMappableCapabilities(rpg: RPG): CapabilityNode[] {
  const out: CapabilityNode[] = [];
  for (const node of Object.values(rpg.nodes)) {
    if (!isCapability(node)) continue;
    if (node.status === "mapped") continue;
    out.push(node);
  }
  return out;
}

// ── Validation ───────────────────────────────────────────────────────

interface ParseOk {
  ok: true;
  plan: StructurePlan;
}
interface ParseErr {
  ok: false;
  error: string;
}

export function parseStructureResponse(
  raw: string,
  mappable: CapabilityNode[],
  allowedExtensions: string[],
  rpg: RPG,
): ParseOk | ParseErr {
  const text = stripFences(raw).trim();
  if (!text) return { ok: false, error: "empty response body" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON parse error: ${(e as Error).message}` };
  }
  if (!isObject(parsed)) {
    return { ok: false, error: "top-level value is not an object" };
  }
  const mappingsRaw = parsed["mappings"];
  if (!Array.isArray(mappingsRaw)) {
    return { ok: false, error: "mappings must be an array" };
  }

  const mappableById = new Map(mappable.map((c) => [c.id, c]));
  const seenIds = new Set<NodeId>();
  const seenPaths = new Map<string, "folder" | "file">();
  const mappings: StructureMapping[] = [];

  for (let i = 0; i < mappingsRaw.length; i++) {
    const entry = mappingsRaw[i];
    if (!isObject(entry)) {
      return { ok: false, error: `mappings[${i}]: not an object` };
    }
    const capabilityId = entry["capabilityId"];
    const kind = entry["kind"];
    const p = entry["path"];
    if (typeof capabilityId !== "string" || capabilityId.length === 0) {
      return {
        ok: false,
        error: `mappings[${i}]: capabilityId must be a non-empty string`,
      };
    }
    if (kind !== "folder" && kind !== "file") {
      return {
        ok: false,
        error: `mappings[${i}]: kind must be "folder" or "file", got ${JSON.stringify(kind)}`,
      };
    }
    if (typeof p !== "string" || p.length === 0) {
      return {
        ok: false,
        error: `mappings[${i}]: path must be a non-empty string`,
      };
    }
    const validatedPath = validatePath(p, kind, allowedExtensions);
    if (!validatedPath.ok) {
      return {
        ok: false,
        error: `mappings[${i}].path: ${validatedPath.error}`,
      };
    }
    const targetCapability = mappableById.get(capabilityId);
    if (!targetCapability) {
      const existing = rpg.nodes[capabilityId];
      const why =
        existing && isCapability(existing) && existing.status === "mapped"
          ? "already mapped"
          : "unknown id";
      return {
        ok: false,
        error: `mappings[${i}].capabilityId: ${capabilityId} — ${why}`,
      };
    }
    if (seenIds.has(capabilityId)) {
      return {
        ok: false,
        error: `mappings[${i}]: duplicate capabilityId ${capabilityId}`,
      };
    }
    const seenKind = seenPaths.get(validatedPath.path);
    if (seenKind && seenKind !== kind) {
      return {
        ok: false,
        error: `mappings[${i}]: path "${validatedPath.path}" reused as both folder and file`,
      };
    }
    if (seenKind === kind && kind === "file") {
      return {
        ok: false,
        error: `mappings[${i}]: duplicate file path "${validatedPath.path}"`,
      };
    }
    seenIds.add(capabilityId);
    seenPaths.set(validatedPath.path, kind);
    mappings.push({ capabilityId, kind, path: validatedPath.path });
  }

  return { ok: true, plan: { mappings } };
}

interface ValidatedPath {
  ok: true;
  path: string;
}

function validatePath(
  raw: string,
  kind: "folder" | "file",
  allowedExtensions: string[],
): ValidatedPath | { ok: false; error: string } {
  // Normalize separators only; do NOT strip leading slashes — we
  // explicitly reject absolute paths below. Stripping would silently
  // accept "/etc/passwd" as "etc/passwd".
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.length === 0) return { ok: false, error: "empty path" };
  if (normalized.startsWith("/")) {
    return { ok: false, error: `must be relative (no leading "/"): ${raw}` };
  }
  if (path.isAbsolute(normalized)) {
    return { ok: false, error: `must be relative: ${raw}` };
  }
  // Catch ".." as a path *segment* — substring matches incorrectly
  // hit identifiers like "foo..bar" which aren't traversal but are
  // still rejected here as ill-formed; that's fine.
  if (normalized.split("/").some((seg) => seg === "..")) {
    return { ok: false, error: `must not contain "..": ${raw}` };
  }
  if (kind === "folder") {
    const trimmed = normalized.replace(/\/+$/, "");
    if (/\.[a-zA-Z0-9]+$/.test(trimmed)) {
      return {
        ok: false,
        error: `folder path looks like a file: ${raw}`,
      };
    }
    return { ok: true, path: trimmed };
  }
  const ext = path.extname(normalized).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    return {
      ok: false,
      error: `file extension ${ext} not in allowed set ${allowedExtensions.join(",")}: ${raw}`,
    };
  }
  return { ok: true, path: normalized };
}

function stripFences(s: string): string {
  const fence = s.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/);
  return fence ? fence[1]! : s;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

// ── Apply plan: build/reuse folder & file nodes ──────────────────────

interface AppliedMapping {
  capabilityId: NodeId;
  nodeId: NodeId;
  kind: "folder" | "file";
  path: string;
}

function applyStructurePlan(
  rpg: RPG,
  plan: StructurePlan,
): AppliedMapping[] {
  const applied: AppliedMapping[] = [];
  // Apply folders first so a file mapping can reuse the folder ids.
  // Within each kind, sort by depth so parents land before children.
  const folderEntries = plan.mappings
    .filter((m) => m.kind === "folder")
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const fileEntries = plan.mappings.filter((m) => m.kind === "file");

  for (const m of folderEntries) {
    const folder = ensureFolder(rpg, m.path);
    markCapabilityMapped(rpg, m.capabilityId, folder.id);
    applied.push({ capabilityId: m.capabilityId, nodeId: folder.id, kind: "folder", path: m.path });
  }
  for (const m of fileEntries) {
    const file = ensureFile(rpg, m.path);
    markCapabilityMapped(rpg, m.capabilityId, file.id);
    applied.push({ capabilityId: m.capabilityId, nodeId: file.id, kind: "file", path: m.path });
  }
  return applied;
}

/** Permissive: silently no-ops if the target id isn't a capability.
 *  In normal flow `applyStructurePlan` only passes ids that survived
 *  validation, so this branch never fires; keeping the guard avoids a
 *  hard crash when an out-of-band caller (test fixture, MCP wrapper)
 *  hands in a stale id. */
function markCapabilityMapped(
  rpg: RPG,
  capabilityId: NodeId,
  targetId: NodeId,
): void {
  const cap = rpg.nodes[capabilityId];
  if (!cap || !isCapability(cap)) return;
  cap.status = "mapped";
  cap.mappedToId = targetId;
}

function folderId(relPath: string): NodeId {
  return `folder:${relPath}`;
}

function fileId(relPath: string): NodeId {
  return `file:${relPath}`;
}

/** Idempotent: returns the existing folder if one is already present at
 *  this path; otherwise creates it (and any intermediate parents). */
function ensureFolder(rpg: RPG, relPath: string): FolderNode {
  if (relPath === "" || relPath === ".") {
    return rpg.nodes[rpg.rootId] as FolderNode;
  }
  const id = folderId(relPath);
  const existing = rpg.nodes[id];
  if (existing && isFolder(existing)) return existing;
  const parentRel =
    path.dirname(relPath) === "." ? "" : path.dirname(relPath);
  const parent = ensureFolder(rpg, parentRel);
  const node: FolderNode = {
    id,
    kind: "folder",
    name: path.basename(relPath),
    parent: parent.id,
    children: [],
    features: [],
    path: relPath,
  };
  rpg.nodes[id] = node;
  parent.children.push(id);
  return node;
}

function ensureFile(rpg: RPG, relPath: string): FileNode {
  const id = fileId(relPath);
  const existing = rpg.nodes[id];
  if (existing && isFile(existing)) return existing;
  const parentDir =
    path.dirname(relPath) === "." ? "" : path.dirname(relPath);
  const parent = ensureFolder(rpg, parentDir);
  // Resolve language via the adapter registry rather than a hardcoded
  // map. Any registered adapter contributes its language label; files
  // with no matching adapter end up `language: null` (still
  // materializable, just not parseable by Phase 6+).
  const language = getAdapterForFile(relPath)?.language ?? null;
  const node: FileNode = {
    id,
    kind: "file",
    name: path.basename(relPath),
    parent: parent.id,
    children: [],
    features: [],
    path: relPath,
    content: "",
    language,
    rawImports: [],
    exports: [],
  };
  rpg.nodes[id] = node;
  parent.children.push(id);
  return node;
}
