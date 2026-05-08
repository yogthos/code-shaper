/**
 * Phase 5 — interface design + data flow.
 *
 * Given an RPG with capabilities and Phase-4 file-structure mappings,
 * the architect plans:
 *   - one function or method per leaf capability, with signature and
 *     description;
 *   - the host file each leaf lives in (creating new files when the
 *     leaf's nearest mapped ancestor is a folder);
 *   - classes declared per file, including within-file inheritance;
 *   - typed data-flow edges between leaves.
 *
 * The plan is stored on the RPG:
 *   - `FileNode.interfacePlan` per file (entries + classes);
 *   - `rpg.dataFlow` populated with cross-leaf edges.
 *
 * Phase 6 reads `interfacePlan` to generate code; once the AST
 * extractor runs over the generated source, real Function/Class/Method
 * nodes appear alongside the plan (the plan stays for traceability).
 */

import type { LLMClient } from "../llm/types.js";
import {
  getAdapterForFile,
  getRegisteredExtensions,
} from "../rpg/index.js";
import {
  isCapability,
  isFile,
  isFolder,
  type CapabilityNode,
  type ContainerKind,
  type DataFlowEdge,
  type FileNode,
  type FolderNode,
  type InterfacePlan,
  type NodeId,
  type PlannedClass,
  type PlannedInterface,
  type RPG,
} from "../rpg/types.js";
import {
  INTERFACE_SYSTEM_PROMPT,
  buildInterfaceUserPrompt,
  renderInterfacePromptBody,
} from "./interface-prompts.js";
import path from "node:path";

export interface InterfaceInput {
  description: string;
  /** Greenfield: Phase 5 plans every leaf from scratch.
   *  Extend: existing FileNodes carry AST nodes from a prior `loadRepo`
   *  run; the prompt body surfaces them so the architect plans only
   *  the *new* leaves, integrating into existing files where natural. */
  mode?: "greenfield" | "extend";
  maxAttempts?: number;
  temperature?: number;
}

export interface InterfaceResult {
  ok: boolean;
  /** All planned interface entries that landed (one per leaf when ok). */
  entries: PlannedInterface[];
  /** All classes declared across files. */
  classes: PlannedClass[];
  /** Data-flow edges added to `rpg.dataFlow`. */
  dataFlow: DataFlowEdge[];
  /** Leaf capability ids the architect failed to plan an interface for. */
  unplannedLeaves: NodeId[];
  /** Files newly created during this run (planned + materialized). */
  filesCreated: NodeId[];
  error?: string;
  attempts: number;
  plan?: ParsedInterfacePlan;
}

/** Validated raw shape returned by the LLM. */
export interface ParsedInterfacePlan {
  interfaces: ParsedInterface[];
  classes: ParsedClass[];
  dataFlow: ParsedDataFlow[];
}

interface ParsedInterface {
  leafCapabilityId: NodeId;
  filePath: string;
  kind: "function" | "method";
  name: string;
  ownerClassName: string | null;
  signature: {
    params: Array<{
      name: string;
      type: string;
      optional?: boolean;
      defaultValue?: string;
    }>;
    returnType: string;
    isAsync: boolean;
  };
  description: string;
  exported: boolean;
  isStatic: boolean;
}

interface ParsedClass {
  filePath: string;
  name: string;
  containerKind?: ContainerKind;
  description: string;
  extendsName: string | null;
  exported: boolean;
}

interface ParsedDataFlow {
  fromLeafId: NodeId;
  toLeafId: NodeId;
  payload: string;
}

export async function designInterfaces(
  client: LLMClient,
  rpg: RPG,
  input: InterfaceInput,
): Promise<InterfaceResult> {
  const maxAttempts = input.maxAttempts ?? 2;
  const mode = input.mode ?? "greenfield";
  // In extend mode, leaves whose host file already exposes a member
  // matching the leaf's name need not be re-planned — the
  // implementation is already on disk. We pre-filter here so the
  // architect only sees genuinely-unplanned leaves in the prompt.
  const allLeaves = collectLeafCapabilities(rpg);
  const leaves =
    mode === "extend" ? allLeaves.filter((l) => !alreadyImplemented(rpg, l)) : allLeaves;
  if (leaves.length === 0) {
    return {
      ok: true,
      entries: [],
      classes: [],
      dataFlow: [],
      unplannedLeaves: [],
      filesCreated: [],
      attempts: 0,
      plan: { interfaces: [], classes: [], dataFlow: [] },
    };
  }

  const allowedExtensions = getRegisteredExtensions();
  const skipLeafIds = new Set(
    allLeaves.filter((l) => !leaves.includes(l)).map((l) => l.id),
  );
  const body = renderInterfacePromptBody(rpg, skipLeafIds);
  const userPrompt = buildInterfaceUserPrompt({
    projectDescription: input.description,
    body,
    allowedExtensions,
    mode,
  });

  let lastError: string | null = null;
  let lastResponse: string | null = null;
  let plan: ParsedInterfacePlan | null = null;
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [
      { role: "system", content: INTERFACE_SYSTEM_PROMPT },
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
    const parsed = parseInterfaceResponse(
      response.content,
      leaves,
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
      entries: [],
      classes: [],
      dataFlow: [],
      unplannedLeaves: leaves.map((l) => l.id),
      filesCreated: [],
      error: lastError ?? "no plan produced",
      attempts,
    };
  }

  return applyInterfacePlan(rpg, plan, leaves, attempts);
}

// ── Leaf discovery ───────────────────────────────────────────────────

function collectLeafCapabilities(rpg: RPG): CapabilityNode[] {
  const out: CapabilityNode[] = [];
  for (const node of Object.values(rpg.nodes)) {
    if (isCapability(node) && node.isLeaf) out.push(node);
  }
  return out;
}

/** Heuristic: a leaf is "already implemented" when its host file is
 *  non-empty (carries real AST function/class children from a prior
 *  loadRepo) and an exported symbol's identifier appears as a
 *  WHOLE WORD (case-sensitive) in either the leaf's `name` or its
 *  `description`. Case sensitivity prevents matches like "get" vs
 *  "Get all entries", and word boundaries prevent matches like "get"
 *  vs "getter". The check considers both the leaf's `name` field
 *  (most specific) and its `description` (broader signal); methods
 *  are looked up via class children too so OO-flavored repos aren't
 *  missed. */
function alreadyImplemented(rpg: RPG, leaf: CapabilityNode): boolean {
  if (!leaf.mappedToId) return false;
  const target = rpg.nodes[leaf.mappedToId];
  if (!target || !isFile(target)) return false;
  if (target.children.length === 0) return false;
  const haystack = `${leaf.name}\n${leaf.description}`;

  const candidateNames = new Set<string>();
  for (const exp of target.exports) candidateNames.add(exp);
  for (const childId of target.children) {
    const child = rpg.nodes[childId];
    if (!child) continue;
    if (child.kind === "function" || child.kind === "class") {
      candidateNames.add(child.name);
      if (child.kind === "class") {
        for (const methodId of child.children) {
          const method = rpg.nodes[methodId];
          if (method && method.kind === "method") {
            candidateNames.add(method.name);
          }
        }
      }
    }
  }

  for (const name of candidateNames) {
    if (matchesAsWord(haystack, name)) return true;
  }
  return false;
}

/** Case-sensitive word-boundary match. JavaScript regex `\b` is
 *  ASCII-aware which is fine for identifier matches in source code. */
function matchesAsWord(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

// ── Validation ───────────────────────────────────────────────────────

interface ParseOk {
  ok: true;
  plan: ParsedInterfacePlan;
}
interface ParseErr {
  ok: false;
  error: string;
}

export function parseInterfaceResponse(
  raw: string,
  leaves: CapabilityNode[],
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
  const interfacesRaw = parsed["interfaces"];
  if (!Array.isArray(interfacesRaw)) {
    return { ok: false, error: "interfaces must be an array" };
  }
  const classesRaw = parsed["classes"] ?? [];
  if (!Array.isArray(classesRaw)) {
    return { ok: false, error: "classes must be an array if present" };
  }
  const dataFlowRaw = parsed["dataFlow"] ?? [];
  if (!Array.isArray(dataFlowRaw)) {
    return { ok: false, error: "dataFlow must be an array if present" };
  }

  // Validate classes first; entries reference them by name.
  const classes: ParsedClass[] = [];
  const classByFileAndName = new Map<string, ParsedClass>();
  for (let i = 0; i < classesRaw.length; i++) {
    const v = validateClass(classesRaw[i], i, allowedExtensions);
    if (!v.ok) return v;
    const key = `${v.value.filePath}::${v.value.name}`;
    if (classByFileAndName.has(key)) {
      return {
        ok: false,
        error: `classes[${i}]: duplicate class "${v.value.name}" in ${v.value.filePath}`,
      };
    }
    classByFileAndName.set(key, v.value);
    classes.push(v.value);
  }
  // Validate within-file extends references.
  for (const c of classes) {
    if (c.extendsName !== null) {
      const baseKey = `${c.filePath}::${c.extendsName}`;
      if (!classByFileAndName.has(baseKey)) {
        return {
          ok: false,
          error: `class "${c.name}" extends "${c.extendsName}" which is not declared in ${c.filePath}`,
        };
      }
    }
  }

  const leafIds = new Set(leaves.map((l) => l.id));
  const interfaces: ParsedInterface[] = [];
  const seenLeafIds = new Set<NodeId>();
  // (file, name) uniqueness across the whole file: top-level functions
  // and class members share a namespace for our purposes (a function
  // and a method with the same global name would still be confusing).
  const seenInFile = new Map<string, Set<string>>();
  for (let i = 0; i < interfacesRaw.length; i++) {
    const v = validateInterface(
      interfacesRaw[i],
      i,
      leafIds,
      classByFileAndName,
      allowedExtensions,
    );
    if (!v.ok) return v;
    if (seenLeafIds.has(v.value.leafCapabilityId)) {
      return {
        ok: false,
        error: `interfaces[${i}]: duplicate leafCapabilityId ${v.value.leafCapabilityId}`,
      };
    }
    seenLeafIds.add(v.value.leafCapabilityId);

    const fileBucket = seenInFile.get(v.value.filePath) ?? new Set<string>();
    const memberKey =
      v.value.kind === "method"
        ? `${v.value.ownerClassName}.${v.value.name}`
        : v.value.name;
    if (fileBucket.has(memberKey)) {
      return {
        ok: false,
        error: `interfaces[${i}]: duplicate member ${memberKey} in ${v.value.filePath}`,
      };
    }
    fileBucket.add(memberKey);
    seenInFile.set(v.value.filePath, fileBucket);

    interfaces.push(v.value);
  }

  // Every leaf must appear.
  const missing: NodeId[] = [];
  for (const l of leaves) {
    if (!seenLeafIds.has(l.id)) missing.push(l.id);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: `leaves missing from interfaces: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? `, …+${missing.length - 5}` : ""}`,
    };
  }

  // Validate data flow.
  const dataFlow: ParsedDataFlow[] = [];
  for (let i = 0; i < dataFlowRaw.length; i++) {
    const v = validateDataFlow(dataFlowRaw[i], i, leafIds, rpg);
    if (!v.ok) return v;
    dataFlow.push(v.value);
  }

  return { ok: true, plan: { interfaces, classes, dataFlow } };
}

interface ValidateOk<T> {
  ok: true;
  value: T;
}

const CONTAINER_KINDS: ContainerKind[] = [
  "class",
  "interface",
  "protocol",
  "record",
  "struct",
  "trait",
  "module",
];

function validateClass(
  raw: unknown,
  index: number,
  allowedExtensions: string[],
): ValidateOk<ParsedClass> | ParseErr {
  if (!isObject(raw)) {
    return { ok: false, error: `classes[${index}]: not an object` };
  }
  const filePath = raw["filePath"];
  const name = raw["name"];
  const description = raw["description"];
  const extendsName = raw["extendsName"];
  const exported = raw["exported"];
  const containerKindRaw = raw["containerKind"];
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { ok: false, error: `classes[${index}].filePath: required string` };
  }
  const pathOk = validateFilePath(filePath, allowedExtensions);
  if (!pathOk.ok) {
    return { ok: false, error: `classes[${index}].filePath: ${pathOk.error}` };
  }
  if (typeof name !== "string" || !isPascalCase(name)) {
    return {
      ok: false,
      error: `classes[${index}].name: must be PascalCase, got ${JSON.stringify(name)}`,
    };
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    return {
      ok: false,
      error: `classes[${index}].description: required non-empty string`,
    };
  }
  if (extendsName !== null && typeof extendsName !== "string") {
    return {
      ok: false,
      error: `classes[${index}].extendsName: must be string or null`,
    };
  }
  if (typeof exported !== "boolean") {
    return {
      ok: false,
      error: `classes[${index}].exported: required boolean`,
    };
  }
  // containerKind is optional; default to "class". Any string value
  // must be one of the registered kinds — language adapters in Phase 6
  // dispatch on it, and an unknown kind would silently render as
  // garbage.
  let containerKind: ContainerKind | undefined;
  if (containerKindRaw !== undefined && containerKindRaw !== null) {
    if (
      typeof containerKindRaw !== "string" ||
      !CONTAINER_KINDS.includes(containerKindRaw as ContainerKind)
    ) {
      return {
        ok: false,
        error: `classes[${index}].containerKind: must be one of ${CONTAINER_KINDS.join(", ")}; got ${JSON.stringify(containerKindRaw)}`,
      };
    }
    containerKind = containerKindRaw as ContainerKind;
  }
  return {
    ok: true,
    value: {
      filePath: pathOk.path,
      name,
      ...(containerKind !== undefined ? { containerKind } : {}),
      description: description.trim(),
      extendsName: extendsName === null ? null : (extendsName as string),
      exported,
    },
  };
}

function validateInterface(
  raw: unknown,
  index: number,
  leafIds: Set<NodeId>,
  classByFileAndName: Map<string, ParsedClass>,
  allowedExtensions: string[],
): ValidateOk<ParsedInterface> | ParseErr {
  if (!isObject(raw)) {
    return { ok: false, error: `interfaces[${index}]: not an object` };
  }
  const leafCapabilityId = raw["leafCapabilityId"];
  if (typeof leafCapabilityId !== "string" || leafCapabilityId.length === 0) {
    return {
      ok: false,
      error: `interfaces[${index}].leafCapabilityId: required string`,
    };
  }
  if (!leafIds.has(leafCapabilityId)) {
    return {
      ok: false,
      error: `interfaces[${index}].leafCapabilityId: ${leafCapabilityId} is not a known leaf`,
    };
  }
  const filePath = raw["filePath"];
  if (typeof filePath !== "string" || filePath.length === 0) {
    return {
      ok: false,
      error: `interfaces[${index}].filePath: required string`,
    };
  }
  const pathOk = validateFilePath(filePath, allowedExtensions);
  if (!pathOk.ok) {
    return {
      ok: false,
      error: `interfaces[${index}].filePath: ${pathOk.error}`,
    };
  }
  const kind = raw["kind"];
  if (kind !== "function" && kind !== "method") {
    return {
      ok: false,
      error: `interfaces[${index}].kind: must be "function" or "method"`,
    };
  }
  const name = raw["name"];
  if (typeof name !== "string" || !isCamelCase(name)) {
    return {
      ok: false,
      error: `interfaces[${index}].name: must be camelCase identifier, got ${JSON.stringify(name)}`,
    };
  }
  const ownerClassName = raw["ownerClassName"];
  if (kind === "method") {
    if (typeof ownerClassName !== "string" || ownerClassName.length === 0) {
      return {
        ok: false,
        error: `interfaces[${index}].ownerClassName: required for methods`,
      };
    }
    const key = `${pathOk.path}::${ownerClassName}`;
    if (!classByFileAndName.has(key)) {
      return {
        ok: false,
        error: `interfaces[${index}].ownerClassName: class "${ownerClassName}" not declared in ${pathOk.path}`,
      };
    }
  } else {
    if (ownerClassName !== null && ownerClassName !== undefined) {
      return {
        ok: false,
        error: `interfaces[${index}].ownerClassName: must be null for functions`,
      };
    }
  }
  const sig = validateSignature(raw["signature"], `interfaces[${index}]`);
  if (!sig.ok) return sig;
  const description = raw["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    return {
      ok: false,
      error: `interfaces[${index}].description: required non-empty string`,
    };
  }
  const exported = raw["exported"];
  if (typeof exported !== "boolean") {
    return {
      ok: false,
      error: `interfaces[${index}].exported: required boolean`,
    };
  }
  const isStatic = raw["isStatic"];
  if (typeof isStatic !== "boolean") {
    return {
      ok: false,
      error: `interfaces[${index}].isStatic: required boolean`,
    };
  }
  return {
    ok: true,
    value: {
      leafCapabilityId,
      filePath: pathOk.path,
      kind,
      name,
      ownerClassName: kind === "method" ? (ownerClassName as string) : null,
      signature: sig.value,
      description: description.trim(),
      exported,
      isStatic,
    },
  };
}

function validateSignature(
  raw: unknown,
  ctx: string,
): ValidateOk<ParsedInterface["signature"]> | ParseErr {
  if (!isObject(raw)) {
    return { ok: false, error: `${ctx}.signature: required object` };
  }
  const paramsRaw = raw["params"];
  if (!Array.isArray(paramsRaw)) {
    return { ok: false, error: `${ctx}.signature.params: required array` };
  }
  const params: ParsedInterface["signature"]["params"] = [];
  const seenParams = new Set<string>();
  for (let i = 0; i < paramsRaw.length; i++) {
    const p = paramsRaw[i];
    if (!isObject(p)) {
      return {
        ok: false,
        error: `${ctx}.signature.params[${i}]: not an object`,
      };
    }
    const pname = p["name"];
    const ptype = p["type"];
    const popt = p["optional"];
    const pdef = p["defaultValue"];
    if (typeof pname !== "string" || !isCamelCaseLoose(pname)) {
      return {
        ok: false,
        error: `${ctx}.signature.params[${i}].name: required camelCase`,
      };
    }
    if (seenParams.has(pname)) {
      return {
        ok: false,
        error: `${ctx}.signature.params[${i}]: duplicate param name "${pname}"`,
      };
    }
    seenParams.add(pname);
    if (typeof ptype !== "string" || ptype.length === 0) {
      return {
        ok: false,
        error: `${ctx}.signature.params[${i}].type: required non-empty string`,
      };
    }
    const entry: ParsedInterface["signature"]["params"][number] = {
      name: pname,
      type: ptype,
    };
    if (popt !== undefined) {
      if (typeof popt !== "boolean") {
        return {
          ok: false,
          error: `${ctx}.signature.params[${i}].optional: must be boolean if present`,
        };
      }
      if (popt) entry.optional = true;
    }
    if (pdef !== undefined && pdef !== null) {
      if (typeof pdef !== "string") {
        return {
          ok: false,
          error: `${ctx}.signature.params[${i}].defaultValue: must be string if present`,
        };
      }
      entry.defaultValue = pdef;
    }
    params.push(entry);
  }
  const returnType = raw["returnType"];
  if (typeof returnType !== "string" || returnType.length === 0) {
    return {
      ok: false,
      error: `${ctx}.signature.returnType: required non-empty string`,
    };
  }
  const isAsync = raw["isAsync"];
  if (typeof isAsync !== "boolean") {
    return {
      ok: false,
      error: `${ctx}.signature.isAsync: required boolean`,
    };
  }
  return {
    ok: true,
    value: { params, returnType, isAsync },
  };
}

function validateDataFlow(
  raw: unknown,
  index: number,
  leafIds: Set<NodeId>,
  rpg: RPG,
): ValidateOk<ParsedDataFlow> | ParseErr {
  if (!isObject(raw)) {
    return { ok: false, error: `dataFlow[${index}]: not an object` };
  }
  const fromLeafId = raw["fromLeafId"];
  const toLeafId = raw["toLeafId"];
  const payload = raw["payload"];
  if (typeof fromLeafId !== "string" || fromLeafId.length === 0) {
    return { ok: false, error: `dataFlow[${index}].fromLeafId: required string` };
  }
  if (typeof toLeafId !== "string" || toLeafId.length === 0) {
    return { ok: false, error: `dataFlow[${index}].toLeafId: required string` };
  }
  if (!leafIds.has(fromLeafId)) {
    // Permit the architect to point at a non-leaf capability too — the
    // paper's data-flow edges sometimes cross subgraph roots — as long
    // as the id is a real capability node.
    const node = rpg.nodes[fromLeafId];
    if (!node || !isCapability(node)) {
      return {
        ok: false,
        error: `dataFlow[${index}].fromLeafId: ${fromLeafId} is not a known capability`,
      };
    }
  }
  if (!leafIds.has(toLeafId)) {
    const node = rpg.nodes[toLeafId];
    if (!node || !isCapability(node)) {
      return {
        ok: false,
        error: `dataFlow[${index}].toLeafId: ${toLeafId} is not a known capability`,
      };
    }
  }
  if (typeof payload !== "string" || payload.trim().length === 0) {
    return {
      ok: false,
      error: `dataFlow[${index}].payload: required non-empty string`,
    };
  }
  if (fromLeafId === toLeafId) {
    return {
      ok: false,
      error: `dataFlow[${index}]: source and target are the same id`,
    };
  }
  return {
    ok: true,
    value: { fromLeafId, toLeafId, payload: payload.trim() },
  };
}

function validateFilePath(
  raw: string,
  allowedExtensions: string[],
):
  | { ok: true; path: string }
  | { ok: false; error: string } {
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return { ok: false, error: `must be relative (no leading "/"): ${raw}` };
  }
  if (path.isAbsolute(normalized)) {
    return { ok: false, error: `must be relative: ${raw}` };
  }
  if (normalized.split("/").some((seg) => seg === "..")) {
    return { ok: false, error: `must not contain "..": ${raw}` };
  }
  const ext = path.extname(normalized).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    return {
      ok: false,
      error: `extension ${ext || "<none>"} not in allowed set ${allowedExtensions.join(",")}`,
    };
  }
  return { ok: true, path: normalized };
}

const CAMEL_CASE_RE = /^[a-z][A-Za-z0-9_]*$/;
const PASCAL_CASE_RE = /^[A-Z][A-Za-z0-9_]*$/;

function isCamelCase(s: string): boolean {
  return CAMEL_CASE_RE.test(s);
}
/** Looser camelCase — also accepts leading underscores commonly used
 *  for unused params (e.g. `_unused`, `_ctx`). */
function isCamelCaseLoose(s: string): boolean {
  return /^_?[a-z][A-Za-z0-9_]*$/.test(s) || /^_+$/.test(s);
}
function isPascalCase(s: string): boolean {
  return PASCAL_CASE_RE.test(s);
}

function stripFences(s: string): string {
  const fence = s.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/);
  return fence ? fence[1]! : s;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

// ── Apply plan: attach interface plans to file nodes ─────────────────

function applyInterfacePlan(
  rpg: RPG,
  plan: ParsedInterfacePlan,
  leaves: CapabilityNode[],
  attempts: number,
): InterfaceResult {
  const filesCreated: NodeId[] = [];

  // Collect all file paths the plan touches; ensure each has a FileNode.
  const allFilePaths = new Set<string>();
  for (const e of plan.interfaces) allFilePaths.add(e.filePath);
  for (const c of plan.classes) allFilePaths.add(c.filePath);
  for (const p of allFilePaths) {
    const created = ensureFileNodeExists(rpg, p);
    if (created) filesCreated.push(`file:${p}`);
  }

  // Initialize empty plans on every relevant file, then populate.
  const planByFile = new Map<string, InterfacePlan>();
  for (const p of allFilePaths) {
    planByFile.set(p, { entries: [], classes: [] });
  }
  for (const c of plan.classes) {
    const fp = planByFile.get(c.filePath)!;
    fp.classes.push({
      name: c.name,
      ...(c.containerKind !== undefined ? { containerKind: c.containerKind } : {}),
      description: c.description,
      extendsName: c.extendsName,
      // Phase 5 only emits within-file extends. Phase 5.5 (refactor)
      // sets `extendsFromFile` when lifting a base class to a shared
      // file via the extract_base_class operation.
      extendsFromFile: null,
      exported: c.exported,
    });
  }
  for (const e of plan.interfaces) {
    const fp = planByFile.get(e.filePath)!;
    fp.entries.push({
      leafCapabilityId: e.leafCapabilityId,
      kind: e.kind,
      name: e.name,
      ownerClassName: e.ownerClassName,
      signature: {
        params: e.signature.params.map((p) => ({ ...p })),
        returnType: e.signature.returnType,
        isAsync: e.signature.isAsync,
      },
      description: e.description,
      exported: e.exported,
      isStatic: e.isStatic,
    });
  }
  // Attach plans to file nodes.
  for (const [path, ip] of planByFile) {
    const node = rpg.nodes[`file:${path}`];
    if (node && isFile(node)) node.interfacePlan = ip;
  }

  // Update each leaf capability to point at its planned host file.
  for (const e of plan.interfaces) {
    const cap = rpg.nodes[e.leafCapabilityId];
    if (cap && isCapability(cap)) {
      cap.status = "mapped";
      cap.mappedToId = `file:${e.filePath}`;
    }
  }

  // Populate data flow edges. Replace any prior edges for these leaves
  // — Phase 5 is the canonical source for them — but preserve unrelated
  // entries (e.g. ones the user wrote by hand for testing).
  const touchedLeafPair = (a: NodeId, b: NodeId) =>
    `${a}->${b}`;
  const newPairKeys = new Set(
    plan.dataFlow.map((d) => touchedLeafPair(d.fromLeafId, d.toLeafId)),
  );
  rpg.dataFlow = rpg.dataFlow.filter(
    (e) => !newPairKeys.has(touchedLeafPair(e.fromNode, e.toNode)),
  );
  for (const d of plan.dataFlow) {
    rpg.dataFlow.push({
      fromNode: d.fromLeafId,
      toNode: d.toLeafId,
      payload: d.payload,
    });
  }

  const entries: PlannedInterface[] = [];
  for (const ip of planByFile.values()) entries.push(...ip.entries);
  const classes: PlannedClass[] = [];
  for (const ip of planByFile.values()) classes.push(...ip.classes);

  // Validate post-application: every leaf has been mapped to a file.
  const planned = new Set(plan.interfaces.map((e) => e.leafCapabilityId));
  const unplannedLeaves = leaves
    .filter((l) => !planned.has(l.id))
    .map((l) => l.id);

  return {
    ok: unplannedLeaves.length === 0,
    entries,
    classes,
    dataFlow: rpg.dataFlow,
    unplannedLeaves,
    filesCreated,
    attempts,
    plan,
  };
}

function ensureFileNodeExists(rpg: RPG, relPath: string): boolean {
  const id = `file:${relPath}`;
  const existing = rpg.nodes[id];
  if (existing && isFile(existing)) return false;
  const parentDir = path.dirname(relPath) === "." ? "" : path.dirname(relPath);
  const parent = ensureFolderNodeExists(rpg, parentDir);
  const node: FileNode = {
    id,
    kind: "file",
    name: path.basename(relPath),
    parent: parent.id,
    children: [],
    features: [],
    path: relPath,
    content: "",
    language: getAdapterForFile(relPath)?.language ?? null,
    rawImports: [],
    exports: [],
  };
  rpg.nodes[id] = node;
  parent.children.push(id);
  return true;
}

function ensureFolderNodeExists(rpg: RPG, relPath: string): FolderNode {
  if (relPath === "" || relPath === ".") {
    return rpg.nodes[rpg.rootId] as FolderNode;
  }
  const id = `folder:${relPath}`;
  const existing = rpg.nodes[id];
  if (existing && isFolder(existing)) return existing;
  const parentRel =
    path.dirname(relPath) === "." ? "" : path.dirname(relPath);
  const parent = ensureFolderNodeExists(rpg, parentRel);
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
