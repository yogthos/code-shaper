/**
 * Refactor orchestrator — the always-available "rearrange" pass.
 *
 * Conservative by design: empty output is the expected shape. The
 * pass produces operations from the shared vocabulary; the apply
 * layer mutates the RPG. Re-running the pass is safe — operations
 * are idempotent where they can be, and if the previous run produced
 * a clean structure the LLM will (correctly) emit zero ops.
 *
 * Phase 5 calls this at the end of the architect chain. Extend mode
 * runs the same pass to align new capabilities with existing
 * structure. Phase 6 (implementor) may also invoke it later when
 * implementation reveals a structural concern that planning missed
 * — same vocabulary, same apply layer.
 */

import type { LLMClient } from "../llm/types.js";
import type { RPG } from "../rpg/types.js";
import {
  applyOperations,
  type BatchResult,
  type ExtractBaseClassOp,
  type RPGOperation,
} from "./operations.js";
import {
  REFACTOR_SYSTEM_PROMPT,
  buildRefactorUserPrompt,
  renderRefactorPromptBody,
} from "./refactor-prompts.js";

export interface RefactorInput {
  description: string;
  mode?: "greenfield" | "extend";
  maxAttempts?: number;
  temperature?: number;
}

export interface RefactorResult {
  ok: boolean;
  /** Operations the architect proposed. Even on apply failure this is
   *  the *attempted* list, useful for diagnostics. */
  operations: RPGOperation[];
  /** Per-op apply outcome from the apply layer. */
  applyReport?: BatchResult;
  /** Reason validation/parse failed. */
  error?: string;
  attempts: number;
}

export async function runRefactorPass(
  client: LLMClient,
  rpg: RPG,
  input: RefactorInput,
): Promise<RefactorResult> {
  const mode = input.mode ?? "greenfield";
  const maxAttempts = input.maxAttempts ?? 2;
  const body = renderRefactorPromptBody(rpg);
  const userPrompt = buildRefactorUserPrompt({
    projectDescription: input.description,
    body,
    mode,
  });

  let lastError: string | null = null;
  let lastResponse: string | null = null;
  let operations: RPGOperation[] | null = null;
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [
      { role: "system", content: REFACTOR_SYSTEM_PROMPT },
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
    const parsed = parseRefactorResponse(response.content);
    if (parsed.ok) {
      operations = parsed.operations;
      break;
    }
    lastError = parsed.error;
    lastResponse = response.content;
  }

  if (operations === null) {
    return {
      ok: false,
      operations: [],
      error: lastError ?? "no operations parsed",
      attempts,
    };
  }

  // Empty list is the conservative happy path. Return an empty
  // BatchResult so callers can always rely on `applyReport` being
  // present when the call succeeded.
  if (operations.length === 0) {
    return {
      ok: true,
      operations: [],
      applyReport: {
        ok: true,
        results: [],
        filesAdded: [],
        filesRemoved: [],
        filesRenamed: [],
      },
      attempts,
    };
  }

  const applyReport = applyOperations(rpg, operations);
  return {
    ok: applyReport.ok,
    operations,
    applyReport,
    attempts,
    error: applyReport.ok
      ? undefined
      : applyReport.results[applyReport.results.length - 1]?.error ??
        "apply failed",
  };
}

interface ParseOk {
  ok: true;
  operations: RPGOperation[];
}
interface ParseErr {
  ok: false;
  error: string;
}

export function parseRefactorResponse(raw: string): ParseOk | ParseErr {
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
  const opsRaw = parsed["operations"];
  if (!Array.isArray(opsRaw)) {
    return { ok: false, error: "operations must be an array" };
  }
  const validated: RPGOperation[] = [];
  for (let i = 0; i < opsRaw.length; i++) {
    const v = validateOp(opsRaw[i], i);
    if (!v.ok) return v;
    validated.push(v.value);
  }
  return { ok: true, operations: validated };
}

function validateOp(
  raw: unknown,
  index: number,
): { ok: true; value: RPGOperation } | ParseErr {
  if (!isObject(raw)) {
    return { ok: false, error: `operations[${index}]: not an object` };
  }
  const kind = raw["kind"];
  switch (kind) {
    case "rename_file":
    case "move_file":
      return validateMoveOp(raw, index);
    case "split_file":
      return validateSplitOp(raw, index);
    case "merge_files":
      return validateMergeOp(raw, index);
    case "extract_base_class":
      return validateExtractBaseClassOp(raw, index);
    case "extract_utility":
      return validateExtractUtilityOp(raw, index);
    default:
      return {
        ok: false,
        error: `operations[${index}]: unknown kind ${JSON.stringify(kind)}`,
      };
  }
}

function validateMoveOp(
  raw: Record<string, unknown>,
  index: number,
): { ok: true; value: RPGOperation } | ParseErr {
  const fromPath = raw["fromPath"];
  const toPath = raw["toPath"];
  if (typeof fromPath !== "string" || fromPath.length === 0) {
    return { ok: false, error: `operations[${index}].fromPath: required string` };
  }
  if (typeof toPath !== "string" || toPath.length === 0) {
    return { ok: false, error: `operations[${index}].toPath: required string` };
  }
  // Both rename_file and move_file map to the same op shape — the
  // distinction is conceptual, not semantic. We canonicalize to
  // move_file so the apply layer has one path.
  return { ok: true, value: { kind: "move_file", fromPath, toPath } };
}

function validateSplitOp(
  raw: Record<string, unknown>,
  index: number,
): { ok: true; value: RPGOperation } | ParseErr {
  const fromPath = raw["fromPath"];
  if (typeof fromPath !== "string" || fromPath.length === 0) {
    return { ok: false, error: `operations[${index}].fromPath: required string` };
  }
  const into = raw["into"];
  if (!Array.isArray(into) || into.length === 0) {
    return {
      ok: false,
      error: `operations[${index}].into: required non-empty array`,
    };
  }
  const partitions: Array<{ path: string; leafCapabilityIds: string[] }> = [];
  for (let i = 0; i < into.length; i++) {
    const dest = into[i];
    if (!isObject(dest)) {
      return {
        ok: false,
        error: `operations[${index}].into[${i}]: not an object`,
      };
    }
    const p = dest["path"];
    const leaves = dest["leafCapabilityIds"];
    if (typeof p !== "string" || p.length === 0) {
      return {
        ok: false,
        error: `operations[${index}].into[${i}].path: required string`,
      };
    }
    if (!Array.isArray(leaves) || leaves.length === 0) {
      return {
        ok: false,
        error: `operations[${index}].into[${i}].leafCapabilityIds: required non-empty array`,
      };
    }
    const leafIds: string[] = [];
    for (let j = 0; j < leaves.length; j++) {
      const id = leaves[j];
      if (typeof id !== "string" || id.length === 0) {
        return {
          ok: false,
          error: `operations[${index}].into[${i}].leafCapabilityIds[${j}]: required string`,
        };
      }
      leafIds.push(id);
    }
    partitions.push({ path: p, leafCapabilityIds: leafIds });
  }
  return {
    ok: true,
    value: { kind: "split_file", fromPath, into: partitions },
  };
}

function validateMergeOp(
  raw: Record<string, unknown>,
  index: number,
): { ok: true; value: RPGOperation } | ParseErr {
  const fromPaths = raw["fromPaths"];
  const toPath = raw["toPath"];
  if (!Array.isArray(fromPaths) || fromPaths.length === 0) {
    return {
      ok: false,
      error: `operations[${index}].fromPaths: required non-empty array`,
    };
  }
  const fp: string[] = [];
  for (let i = 0; i < fromPaths.length; i++) {
    const p = fromPaths[i];
    if (typeof p !== "string" || p.length === 0) {
      return {
        ok: false,
        error: `operations[${index}].fromPaths[${i}]: required string`,
      };
    }
    fp.push(p);
  }
  if (typeof toPath !== "string" || toPath.length === 0) {
    return { ok: false, error: `operations[${index}].toPath: required string` };
  }
  return {
    ok: true,
    value: { kind: "merge_files", fromPaths: fp, toPath },
  };
}

function validateExtractBaseClassOp(
  raw: Record<string, unknown>,
  index: number,
): { ok: true; value: RPGOperation } | ParseErr {
  const toFile = raw["toFile"];
  const baseClassName = raw["baseClassName"];
  const baseDescription = raw["baseDescription"];
  const methods = raw["methods"];
  const rewriteExtenders = raw["rewriteExtenders"];
  if (typeof toFile !== "string") {
    return { ok: false, error: `operations[${index}].toFile: required string` };
  }
  if (typeof baseClassName !== "string") {
    return {
      ok: false,
      error: `operations[${index}].baseClassName: required string`,
    };
  }
  if (typeof baseDescription !== "string") {
    return {
      ok: false,
      error: `operations[${index}].baseDescription: required string`,
    };
  }
  if (!Array.isArray(methods)) {
    return {
      ok: false,
      error: `operations[${index}].methods: required array`,
    };
  }
  if (!Array.isArray(rewriteExtenders) || rewriteExtenders.length === 0) {
    return {
      ok: false,
      error: `operations[${index}].rewriteExtenders: required non-empty array`,
    };
  }
  // Methods: validate structure precisely. The apply layer copies
  // these into the base file's interface plan, so a malformed entry
  // here would corrupt downstream state.
  const validatedMethods: ExtractBaseClassOp["methods"] = [];
  for (let i = 0; i < methods.length; i++) {
    const m = methods[i];
    if (!isObject(m)) {
      return {
        ok: false,
        error: `operations[${index}].methods[${i}]: not an object`,
      };
    }
    const name = m["name"];
    const description = m["description"];
    const signature = m["signature"];
    const isStatic = m["isStatic"];
    if (typeof name !== "string" || name.length === 0) {
      return {
        ok: false,
        error: `operations[${index}].methods[${i}].name: required string`,
      };
    }
    if (typeof description !== "string") {
      return {
        ok: false,
        error: `operations[${index}].methods[${i}].description: required string`,
      };
    }
    if (typeof isStatic !== "boolean") {
      return {
        ok: false,
        error: `operations[${index}].methods[${i}].isStatic: required boolean`,
      };
    }
    if (!isObject(signature)) {
      return {
        ok: false,
        error: `operations[${index}].methods[${i}].signature: required object`,
      };
    }
    const params = signature["params"];
    const returnType = signature["returnType"];
    const isAsync = signature["isAsync"];
    if (!Array.isArray(params)) {
      return {
        ok: false,
        error: `operations[${index}].methods[${i}].signature.params: required array`,
      };
    }
    if (typeof returnType !== "string" || returnType.length === 0) {
      return {
        ok: false,
        error: `operations[${index}].methods[${i}].signature.returnType: required string`,
      };
    }
    if (typeof isAsync !== "boolean") {
      return {
        ok: false,
        error: `operations[${index}].methods[${i}].signature.isAsync: required boolean`,
      };
    }
    const validParams: ExtractBaseClassOp["methods"][number]["signature"]["params"] = [];
    for (let j = 0; j < params.length; j++) {
      const p = params[j];
      if (!isObject(p)) {
        return {
          ok: false,
          error: `operations[${index}].methods[${i}].signature.params[${j}]: not an object`,
        };
      }
      const pname = p["name"];
      const ptype = p["type"];
      if (typeof pname !== "string" || pname.length === 0) {
        return {
          ok: false,
          error: `operations[${index}].methods[${i}].signature.params[${j}].name: required string`,
        };
      }
      if (typeof ptype !== "string" || ptype.length === 0) {
        return {
          ok: false,
          error: `operations[${index}].methods[${i}].signature.params[${j}].type: required string`,
        };
      }
      const entry: typeof validParams[number] = { name: pname, type: ptype };
      const popt = p["optional"];
      if (popt === true) entry.optional = true;
      const pdef = p["defaultValue"];
      if (typeof pdef === "string") entry.defaultValue = pdef;
      validParams.push(entry);
    }
    validatedMethods.push({
      name,
      description,
      isStatic,
      signature: {
        params: validParams,
        returnType,
        isAsync,
      },
    });
  }
  const validatedExtenders: Array<{ filePath: string; className: string }> = [];
  for (let i = 0; i < rewriteExtenders.length; i++) {
    const e = rewriteExtenders[i];
    if (!isObject(e)) {
      return {
        ok: false,
        error: `operations[${index}].rewriteExtenders[${i}]: not an object`,
      };
    }
    const filePath = e["filePath"];
    const className = e["className"];
    if (typeof filePath !== "string" || typeof className !== "string") {
      return {
        ok: false,
        error: `operations[${index}].rewriteExtenders[${i}]: filePath + className required`,
      };
    }
    validatedExtenders.push({ filePath, className });
  }
  return {
    ok: true,
    value: {
      kind: "extract_base_class",
      toFile,
      baseClassName,
      baseDescription,
      methods: validatedMethods,
      rewriteExtenders: validatedExtenders,
    },
  };
}

function validateExtractUtilityOp(
  raw: Record<string, unknown>,
  index: number,
): { ok: true; value: RPGOperation } | ParseErr {
  const toFile = raw["toFile"];
  const members = raw["members"];
  if (typeof toFile !== "string") {
    return { ok: false, error: `operations[${index}].toFile: required string` };
  }
  if (!Array.isArray(members) || members.length === 0) {
    return {
      ok: false,
      error: `operations[${index}].members: required non-empty array`,
    };
  }
  const out: Array<{
    fromFile: string;
    functionName: string;
    leafCapabilityId: string;
  }> = [];
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (!isObject(m)) {
      return {
        ok: false,
        error: `operations[${index}].members[${i}]: not an object`,
      };
    }
    const fromFile = m["fromFile"];
    const functionName = m["functionName"];
    const leafCapabilityId = m["leafCapabilityId"];
    if (
      typeof fromFile !== "string" ||
      typeof functionName !== "string" ||
      typeof leafCapabilityId !== "string"
    ) {
      return {
        ok: false,
        error: `operations[${index}].members[${i}]: fromFile + functionName + leafCapabilityId required`,
      };
    }
    out.push({ fromFile, functionName, leafCapabilityId });
  }
  return {
    ok: true,
    value: { kind: "extract_utility", toFile, members: out },
  };
}

function stripFences(s: string): string {
  const fence = s.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/);
  return fence ? fence[1]! : s;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
