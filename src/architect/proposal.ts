/**
 * Proposal-level architect.
 *
 * Drives a single LLM round-trip with a structured-output prompt and
 * returns the parsed capability tree, attached to the supplied RPG's
 * root folder. Validation is hand-written (rather than relying on the
 * provider's `response_format: json_schema` which not all OpenAI-
 * compatible APIs support reliably) so a malformed response surfaces
 * as a typed error and triggers a retry rather than corrupt RPG state.
 */

import type { LLMClient } from "../llm/types.js";
import type { CapabilityNode, NodeId, RPG } from "../rpg/types.js";
import { isFolder } from "../rpg/types.js";
import {
  PROPOSAL_SYSTEM_PROMPT,
  buildProposalUserPrompt,
  summarizeExistingRPG,
  type ProposalPromptInput,
} from "./prompts.js";

export interface ProposalInput {
  /** User-supplied project description. */
  description: string;
  /** Defaults to "greenfield". When "extend", the prompt is augmented
   *  with a summary of the existing RPG so the architect proposes
   *  deltas rather than duplicates. */
  mode?: "greenfield" | "extend";
  /** Number of LLM round-trips before giving up on validation. The
   *  retry prompt includes the previous parse error so the model can
   *  correct itself. Defaults to 2. */
  maxAttempts?: number;
  /** Optional override for the LLM temperature on this call. */
  temperature?: number;
}

export interface ProposalResult {
  /** Whether a valid plan was produced and attached to the RPG. */
  ok: boolean;
  /** When ok=true: ids of the capability nodes attached at the root.
   *  When ok=false: empty. */
  attachedRootIds: NodeId[];
  /** Total number of capability nodes added (transitive, including
   *  leaves and non-leaves). */
  totalNodesAdded: number;
  /** When ok=false: the reason. */
  error?: string;
  /** Number of LLM attempts taken (1 if the first response validated). */
  attempts: number;
  /** The raw parsed plan, useful for diagnostics + tests. */
  plan?: ProjectPlan;
}

/** Validated shape returned by the LLM. */
export interface ProjectPlan {
  projectName: string;
  description: string;
  rootCapabilities: PlanCapability[];
}

export interface PlanCapability {
  name: string;
  description: string;
  children?: PlanCapability[];
}

export async function proposeFunctionalityGraph(
  client: LLMClient,
  rpg: RPG,
  input: ProposalInput,
): Promise<ProposalResult> {
  const mode: ProposalPromptInput["mode"] = input.mode ?? "greenfield";
  const maxAttempts = input.maxAttempts ?? 2;
  const existingSummary =
    mode === "extend" ? summarizeExistingRPG(rpg) : undefined;

  let lastError: string | null = null;
  let lastResponse: string | null = null;
  let plan: ProjectPlan | null = null;
  let attempts = 0;

  // Transport errors (network, auth, 5xx-after-retries) bubble out of
  // `client.chat()` and propagate up. The retry loop only handles
  // *validation* failures — retrying those with the prior response in
  // hand is a productive correction, while retrying a 401 burns budget
  // for nothing.
  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [
      { role: "system", content: PROPOSAL_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildProposalUserPrompt({
          description: input.description,
          mode,
          existingSummary,
        }),
      },
    ];
    if (lastError !== null && lastResponse !== null) {
      // Strict role alternation: replay the bad response as the prior
      // assistant turn, then the corrective user prompt. Keeps chat
      // providers happy and lets the model see exactly what it produced.
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
    const parsed = parsePlanResponse(response.content);
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
      attachedRootIds: [],
      totalNodesAdded: 0,
      error: lastError ?? "no plan produced",
      attempts,
    };
  }

  const { rootIds, total } = attachPlan(rpg, plan);
  return {
    ok: true,
    attachedRootIds: rootIds,
    totalNodesAdded: total,
    attempts,
    plan,
  };
}

// ── Parsing + validation ────────────────────────────────────────────

interface ParseOk {
  ok: true;
  plan: ProjectPlan;
}
interface ParseErr {
  ok: false;
  error: string;
}

export function parsePlanResponse(raw: string): ParseOk | ParseErr {
  // The model sometimes wraps the JSON in a fenced block even when we
  // ask for json_object mode. Strip a fence if present, then JSON.parse.
  const jsonText = stripFences(raw).trim();
  if (!jsonText) return { ok: false, error: "empty response body" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return { ok: false, error: `JSON parse error: ${(e as Error).message}` };
  }
  return validatePlan(parsed);
}

function stripFences(s: string): string {
  const fence = s.match(/```(?:json)?\s*\r?\n([\s\S]*?)```/);
  return fence ? fence[1]! : s;
}

function validatePlan(parsed: unknown): ParseOk | ParseErr {
  if (!isObject(parsed)) {
    return { ok: false, error: "top-level value is not an object" };
  }
  const projectName = parsed["projectName"];
  if (typeof projectName !== "string" || projectName.trim().length === 0) {
    return { ok: false, error: "projectName must be a non-empty string" };
  }
  const description = parsed["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    return { ok: false, error: "description must be a non-empty string" };
  }
  const roots = parsed["rootCapabilities"];
  if (!Array.isArray(roots) || roots.length === 0) {
    return {
      ok: false,
      error: "rootCapabilities must be a non-empty array",
    };
  }
  const rootCapabilities: PlanCapability[] = [];
  for (const r of roots) {
    const v = validateCapability(r, "rootCapabilities[]");
    if (!v.ok) return v;
    rootCapabilities.push(v.value);
  }
  return {
    ok: true,
    plan: {
      projectName: projectName.trim(),
      description: description.trim(),
      rootCapabilities,
    },
  };
}

function validateCapability(
  node: unknown,
  path: string,
):
  | { ok: true; value: PlanCapability }
  | ParseErr {
  if (!isObject(node)) {
    return { ok: false, error: `${path}: not an object` };
  }
  const name = node["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, error: `${path}: name must be a non-empty string` };
  }
  const description = node["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    return {
      ok: false,
      error: `${path}: description must be a non-empty string`,
    };
  }
  const out: PlanCapability = {
    name: name.trim(),
    description: description.trim(),
  };
  const children = node["children"];
  if (children === undefined || children === null) {
    return { ok: true, value: out };
  }
  if (!Array.isArray(children)) {
    return { ok: false, error: `${path}.children: must be an array if present` };
  }
  if (children.length === 0) {
    return { ok: true, value: out };
  }
  const validated: PlanCapability[] = [];
  for (let i = 0; i < children.length; i++) {
    const v = validateCapability(children[i], `${path} > ${name.trim()}.children[${i}]`);
    if (!v.ok) return v;
    validated.push(v.value);
  }
  out.children = validated;
  return { ok: true, value: out };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

// ── Attaching to the RPG ────────────────────────────────────────────

interface AttachResult {
  rootIds: NodeId[];
  total: number;
}

function attachPlan(rpg: RPG, plan: ProjectPlan): AttachResult {
  const root = rpg.nodes[rpg.rootId];
  if (!root || !isFolder(root)) {
    throw new Error("attachPlan: rpg.rootId does not resolve to a FolderNode");
  }
  const rootIds: NodeId[] = [];
  let total = 0;
  for (let i = 0; i < plan.rootCapabilities.length; i++) {
    const id = attachCapability(
      rpg,
      root.id,
      plan.rootCapabilities[i]!,
      /*depth*/ 1,
      i,
    );
    rootIds.push(id);
    root.children.push(id);
    total += sizeOf(rpg, id);
  }
  return { rootIds, total };
}

function attachCapability(
  rpg: RPG,
  parentId: NodeId,
  cap: PlanCapability,
  depth: number,
  siblingIndex: number,
): NodeId {
  const isLeaf = !cap.children || cap.children.length === 0;
  const id = capabilityId(parentId, cap.name, depth, siblingIndex);
  const node: CapabilityNode = {
    id,
    kind: "capability",
    name: cap.name,
    parent: parentId,
    children: [],
    features: [],
    description: cap.description,
    isLeaf,
    status: "planned",
    mappedToId: null,
    decompositionDepth: 0,
  };
  rpg.nodes[id] = node;
  if (cap.children) {
    for (let i = 0; i < cap.children.length; i++) {
      const childId = attachCapability(
        rpg,
        id,
        cap.children[i]!,
        depth + 1,
        i,
      );
      node.children.push(childId);
    }
  }
  return id;
}

/** Stable, collision-resistant id for a capability node.
 *
 *  Format: `cap:<parentId>/<slug>@d<depth>#<siblingIndex>`. The
 *  sibling index disambiguates same-named siblings (which the LLM
 *  occasionally produces under low-temperature settings), keeping
 *  every node addressable without lossy id collisions. */
function capabilityId(
  parentId: NodeId,
  name: string,
  depth: number,
  siblingIndex: number,
): NodeId {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `cap:${parentId}/${slug}@d${depth}#${siblingIndex}`;
}

function sizeOf(rpg: RPG, id: NodeId): number {
  const node = rpg.nodes[id];
  if (!node) return 0;
  let n = 1;
  for (const child of node.children) n += sizeOf(rpg, child);
  return n;
}
