/**
 * Phase 7a — decompose-on-stuck.
 *
 * When `implementLeaf` exhausts its retries, this module asks the
 * architect for a recovery plan: split into single-responsibility
 * sub-leaves, OR retry with a fresh approach hint. There is no
 * "give up" path — every leaf must eventually pass its tests, and
 * exhausting the depth budget is treated as a hard build failure
 * that the user can resolve by intervening or letting Phase 7b's
 * integration loop surface the structural problem.
 */

import type { LLMClient } from "../llm/types.js";
import type {
  CapabilityNode,
  FileNode,
  InterfacePlan,
  NodeId,
  PlannedInterface,
  PlannedSignature,
  RPG,
} from "../rpg/types.js";
import { isCapability } from "../rpg/types.js";
import {
  DECOMPOSE_SYSTEM_PROMPT,
  buildDecomposeUserPrompt,
} from "./decompose-prompts.js";

export const MAX_DECOMPOSE_DEPTH = 5;

export interface DecomposeRequest {
  leaf: PlannedInterface;
  hostFile: FileNode;
  rpg: RPG;
  testSource: string;
  lastBody: string;
  lastFailure: string;
  attemptsExhausted: number;
  /** Highest decomposition depth observed on this leaf or any of its
   *  ancestor capabilities. The orchestrator threads the running max
   *  in so the architect knows when it's at the budget. */
  decompositionDepth: number;
  maxAttempts?: number;
  temperature?: number;
}

export type DecomposeDecision =
  | {
      kind: "decompose";
      reason: string;
      subLeaves: SubLeafSpec[];
      /** New CapabilityNode ids created by `applyDecomposition`. */
      newCapabilityIds: NodeId[];
    }
  | {
      kind: "fresh_approach";
      reason: string;
      approachHint: string;
    }
  | {
      kind: "depth_exhausted";
      reason: string;
    };

export interface DecomposeResult {
  /** True when a valid decision was returned — note this does NOT
   *  imply recovery succeeded. `decision.kind === "depth_exhausted"`
   *  is a valid decision (the architect was correctly told the
   *  budget ran out) but the leaf will not implement and the build
   *  will fail. Callers must read `decision.kind` to distinguish
   *  productive from terminal outcomes. */
  ok: boolean;
  decision?: DecomposeDecision;
  attempts: number;
  error?: string;
}

export interface SubLeafSpec {
  name: string;
  description: string;
  signature: PlannedSignature;
  kind: "function" | "method";
  ownerClassName: string | null;
  isStatic: boolean;
  exported: boolean;
}

interface ParsedResponse {
  decision: "decompose" | "fresh_approach";
  reason: string;
  subLeaves?: SubLeafSpec[];
  approachHint?: string;
}

export async function decomposeStuckLeaf(
  client: LLMClient,
  req: DecomposeRequest,
): Promise<DecomposeResult> {
  const maxAttempts = req.maxAttempts ?? 2;
  // Hard depth check first — short-circuit the LLM call.
  if (req.decompositionDepth >= MAX_DECOMPOSE_DEPTH) {
    return {
      ok: true,
      attempts: 0,
      decision: {
        kind: "depth_exhausted",
        reason: `decomposition depth budget (${MAX_DECOMPOSE_DEPTH}) exhausted on leaf ${req.leaf.name}`,
      },
    };
  }
  // Off-by-one rationale: decomposing a leaf at depth N produces
  // sub-leaves at depth N+1. So at depth = MAX-1, decomposing would
  // create sub-leaves AT the budget — the next failure round on any
  // of them would short-circuit to depth_exhausted. To avoid that
  // futile round-trip, we force the architect to pick fresh_approach
  // here.
  const atLimit = req.decompositionDepth === MAX_DECOMPOSE_DEPTH - 1;

  const userPrompt = buildDecomposeUserPrompt({
    leaf: req.leaf,
    hostFilePath: req.hostFile.path,
    testSource: req.testSource,
    lastBody: req.lastBody,
    lastFailure: req.lastFailure,
    attemptsExhausted: req.attemptsExhausted,
    decompositionDepth: req.decompositionDepth,
    atDepthLimit: atLimit,
  });

  let lastError: string | null = null;
  let lastResponse: string | null = null;
  let attempts = 0;
  let parsed: ParsedResponse | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [
      { role: "system", content: DECOMPOSE_SYSTEM_PROMPT },
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
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
    });
    const validated = validateDecomposeResponse(response.content, atLimit);
    if (validated.ok) {
      parsed = validated.value;
      break;
    }
    lastError = validated.error;
    lastResponse = response.content;
  }

  if (!parsed) {
    return {
      ok: false,
      attempts,
      error: lastError ?? "no decompose plan produced",
    };
  }

  if (parsed.decision === "fresh_approach") {
    return {
      ok: true,
      attempts,
      decision: {
        kind: "fresh_approach",
        reason: parsed.reason,
        approachHint: parsed.approachHint!,
      },
    };
  }

  // decompose: apply to RPG.
  const newIds = applyDecomposition(req, parsed.subLeaves!);
  return {
    ok: true,
    attempts,
    decision: {
      kind: "decompose",
      reason: parsed.reason,
      subLeaves: parsed.subLeaves!,
      newCapabilityIds: newIds,
    },
  };
}

// ── Apply ───────────────────────────────────────────────────────────

/** Apply a pre-validated decompose decision directly, without an LLM
 *  call. Phase 7b uses this when its blame-attribution step has
 *  already produced a structured decision. Returns the new
 *  capability ids on success, or a typed error explaining what made
 *  the spec invalid. */
export function applyPresetDecomposition(
  req: DecomposeRequest,
  subLeaves: SubLeafSpec[],
):
  | { ok: true; newCapabilityIds: NodeId[] }
  | { ok: false; error: string } {
  // Re-run the same shape validation `parseDecomposeResponse` does so
  // an externally-supplied spec hits the same guardrails.
  if (subLeaves.length < 2 || subLeaves.length > 5) {
    return {
      ok: false,
      error: `subLeaves must contain 2-5 entries; got ${subLeaves.length}`,
    };
  }
  const seen = new Set<string>();
  for (const sub of subLeaves) {
    if (seen.has(sub.name)) {
      return { ok: false, error: `duplicate sub-leaf name: ${sub.name}` };
    }
    seen.add(sub.name);
    if (!/^[a-z][A-Za-z0-9_]*$/.test(sub.name)) {
      return {
        ok: false,
        error: `sub-leaf name must be camelCase: ${sub.name}`,
      };
    }
    if (sub.kind === "method" && !sub.ownerClassName) {
      return {
        ok: false,
        error: `sub-leaf ${sub.name}: method requires ownerClassName`,
      };
    }
  }
  const newIds = applyDecomposition(req, subLeaves);
  return { ok: true, newCapabilityIds: newIds };
}

function applyDecomposition(
  req: DecomposeRequest,
  subLeaves: SubLeafSpec[],
): NodeId[] {
  const newIds: NodeId[] = [];
  const childDepth = req.decompositionDepth + 1;

  // Sub-leaves are siblings of the failed leaf — they share the same
  // host file's interface plan and the same parent. The parent may be
  // another capability OR a folder (top-level leaves whose immediate
  // parent is the root folder); both are valid sibling anchors.
  const parentId = siblingParentOfLeaf(req.rpg, req.leaf);
  if (!parentId) {
    // The failed leaf's capability isn't reachable from the RPG. Real
    // production flows always have one; defensive return for stale-id
    // injection scenarios.
    return [];
  }

  const plan: InterfacePlan = req.hostFile.interfacePlan ?? {
    classes: [],
    entries: [],
  };
  req.hostFile.interfacePlan = plan;

  for (let i = 0; i < subLeaves.length; i++) {
    const sub = subLeaves[i]!;
    const capId = synthSubLeafCapId(
      req.leaf.leafCapabilityId,
      sub.name,
      childDepth,
      i,
    );
    const cap: CapabilityNode = {
      id: capId,
      kind: "capability",
      name: sub.name,
      parent: parentId,
      children: [],
      features: [],
      description: sub.description,
      isLeaf: true,
      status: "mapped",
      mappedToId: req.hostFile.id,
      decompositionDepth: childDepth,
    };
    req.rpg.nodes[capId] = cap;
    const parentNode = req.rpg.nodes[parentId];
    if (parentNode) {
      // Folder + capability nodes both have `children: NodeId[]`.
      parentNode.children.push(capId);
    }

    // Plan entry for the sub-leaf.
    plan.entries.push({
      leafCapabilityId: capId,
      kind: sub.kind,
      ownerClassName: sub.ownerClassName,
      name: sub.name,
      signature: {
        params: sub.signature.params.map((p) => ({ ...p })),
        returnType: sub.signature.returnType,
        isAsync: sub.signature.isAsync,
      },
      description: sub.description,
      exported: sub.exported,
      isStatic: sub.isStatic,
    });

    // Data-flow edge: the sub-leaf produces output consumed by the
    // failed leaf (the assembly). Phase 6's topo-sort uses dataFlow
    // edges to schedule producers before consumers.
    req.rpg.dataFlow.push({
      fromNode: capId,
      toNode: req.leaf.leafCapabilityId,
      payload: sub.signature.returnType,
    });

    newIds.push(capId);
  }
  return newIds;
}

/** Find the parent node that should "own" the new sibling sub-leaves.
 *  Looks up the failed leaf's CapabilityNode by id and returns its
 *  `parent` regardless of kind — capability or folder both work as
 *  sibling anchors. Returns null only when the leaf's capability is
 *  not in the graph at all (shouldn't happen in production flows). */
function siblingParentOfLeaf(rpg: RPG, leaf: PlannedInterface): NodeId | null {
  const cap = rpg.nodes[leaf.leafCapabilityId];
  if (cap && isCapability(cap)) return cap.parent;
  return null;
}

/** Stable id for a sub-leaf produced by decompose. The format strips
 *  the `cap:` prefix from the parent leaf id so the synthesized id
 *  doesn't double-prefix. Visually compact, still unique. */
function synthSubLeafCapId(
  parentLeafId: NodeId,
  name: string,
  depth: number,
  index: number,
): NodeId {
  const cleanParent = parentLeafId.startsWith("cap:")
    ? parentLeafId.slice("cap:".length)
    : parentLeafId;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `cap:decomposed/${cleanParent}/${slug}@d${depth}#${index}`;
}

// ── Validation ───────────────────────────────────────────────────────

interface ValidateOk<T> {
  ok: true;
  value: T;
}
interface ValidateErr {
  ok: false;
  error: string;
}

function validateDecomposeResponse(
  raw: string,
  atLimit: boolean,
): ValidateOk<ParsedResponse> | ValidateErr {
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
  const decision = parsed["decision"];
  const reason = parsed["reason"];
  if (decision !== "decompose" && decision !== "fresh_approach") {
    return {
      ok: false,
      error: `decision must be "decompose" or "fresh_approach"; got ${JSON.stringify(decision)}`,
    };
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return { ok: false, error: "reason must be a non-empty string" };
  }
  if (atLimit && decision === "decompose") {
    return {
      ok: false,
      error:
        "depth budget exhausted; decision must be fresh_approach at the depth limit",
    };
  }

  if (decision === "fresh_approach") {
    const hint = parsed["approachHint"];
    if (typeof hint !== "string" || hint.trim().length === 0) {
      return {
        ok: false,
        error: "fresh_approach requires a non-empty approachHint",
      };
    }
    return {
      ok: true,
      value: { decision, reason: reason.trim(), approachHint: hint.trim() },
    };
  }

  // decompose
  const subRaw = parsed["subLeaves"];
  if (!Array.isArray(subRaw) || subRaw.length < 2 || subRaw.length > 5) {
    return {
      ok: false,
      error: `subLeaves must be an array of 2-5 entries; got ${Array.isArray(subRaw) ? subRaw.length : typeof subRaw}`,
    };
  }
  const subLeaves: SubLeafSpec[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < subRaw.length; i++) {
    const v = validateSubLeaf(subRaw[i], i);
    if (!v.ok) return v;
    if (seenNames.has(v.value.name)) {
      return {
        ok: false,
        error: `subLeaves[${i}]: duplicate name ${v.value.name}`,
      };
    }
    seenNames.add(v.value.name);
    subLeaves.push(v.value);
  }
  return {
    ok: true,
    value: { decision, reason: reason.trim(), subLeaves },
  };
}

function validateSubLeaf(
  raw: unknown,
  i: number,
): ValidateOk<SubLeafSpec> | ValidateErr {
  if (!isObject(raw)) {
    return { ok: false, error: `subLeaves[${i}]: not an object` };
  }
  const name = raw["name"];
  const description = raw["description"];
  const sig = raw["signature"];
  const kind = raw["kind"];
  const ownerClassName = raw["ownerClassName"];
  const isStatic = raw["isStatic"];
  const exported = raw["exported"];
  if (typeof name !== "string" || !/^[a-z][A-Za-z0-9_]*$/.test(name)) {
    return {
      ok: false,
      error: `subLeaves[${i}].name: required camelCase identifier`,
    };
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    return {
      ok: false,
      error: `subLeaves[${i}].description: required non-empty string`,
    };
  }
  if (kind !== "function" && kind !== "method") {
    return {
      ok: false,
      error: `subLeaves[${i}].kind: must be "function" or "method"`,
    };
  }
  if (kind === "method") {
    if (typeof ownerClassName !== "string" || ownerClassName.length === 0) {
      return {
        ok: false,
        error: `subLeaves[${i}].ownerClassName: required for methods`,
      };
    }
  } else {
    if (ownerClassName !== null && ownerClassName !== undefined) {
      return {
        ok: false,
        error: `subLeaves[${i}].ownerClassName: must be null for functions`,
      };
    }
  }
  if (typeof exported !== "boolean") {
    return {
      ok: false,
      error: `subLeaves[${i}].exported: required boolean`,
    };
  }
  if (typeof isStatic !== "boolean") {
    return {
      ok: false,
      error: `subLeaves[${i}].isStatic: required boolean`,
    };
  }
  if (!isObject(sig)) {
    return {
      ok: false,
      error: `subLeaves[${i}].signature: required object`,
    };
  }
  const sigParsed = validateSignature(sig, `subLeaves[${i}].signature`);
  if (!sigParsed.ok) return sigParsed;

  return {
    ok: true,
    value: {
      name,
      description: description.trim(),
      signature: sigParsed.value,
      kind,
      ownerClassName: kind === "method" ? (ownerClassName as string) : null,
      isStatic,
      exported,
    },
  };
}

function validateSignature(
  raw: Record<string, unknown>,
  ctx: string,
): ValidateOk<PlannedSignature> | ValidateErr {
  const paramsRaw = raw["params"];
  const returnType = raw["returnType"];
  const isAsync = raw["isAsync"];
  if (!Array.isArray(paramsRaw)) {
    return { ok: false, error: `${ctx}.params: required array` };
  }
  if (typeof returnType !== "string" || returnType.length === 0) {
    return { ok: false, error: `${ctx}.returnType: required string` };
  }
  if (typeof isAsync !== "boolean") {
    return { ok: false, error: `${ctx}.isAsync: required boolean` };
  }
  const params: PlannedSignature["params"] = [];
  const seen = new Set<string>();
  for (let j = 0; j < paramsRaw.length; j++) {
    const p = paramsRaw[j];
    if (!isObject(p)) {
      return { ok: false, error: `${ctx}.params[${j}]: not an object` };
    }
    const pname = p["name"];
    const ptype = p["type"];
    if (typeof pname !== "string" || !/^_?[a-z][A-Za-z0-9_]*$/.test(pname)) {
      return {
        ok: false,
        error: `${ctx}.params[${j}].name: required camelCase`,
      };
    }
    if (seen.has(pname)) {
      return {
        ok: false,
        error: `${ctx}.params[${j}]: duplicate name ${pname}`,
      };
    }
    seen.add(pname);
    if (typeof ptype !== "string" || ptype.length === 0) {
      return {
        ok: false,
        error: `${ctx}.params[${j}].type: required non-empty string`,
      };
    }
    const entry: PlannedSignature["params"][number] = {
      name: pname,
      type: ptype,
    };
    if (p["optional"] === true) entry.optional = true;
    if (typeof p["defaultValue"] === "string") {
      entry.defaultValue = p["defaultValue"];
    }
    params.push(entry);
  }
  return { ok: true, value: { params, returnType, isAsync } };
}

function stripFences(s: string): string {
  const fence = s.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/);
  return fence ? fence[1]! : s;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
