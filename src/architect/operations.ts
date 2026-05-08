/**
 * Architect operation vocabulary.
 *
 * The architect (and any tool reasoning about the RPG) communicates
 * mutations via a uniform `RPGOperation` union. Every phase that
 * makes structural changes — initial creation, restructuring, base-
 * class extraction, extend-mode integration with an existing repo —
 * emits operations from this vocabulary. The apply layer is the only
 * place that mutates folder/file/plan/edge state, so import-edge
 * bookkeeping and cross-file consistency live in one place.
 *
 * Conservatism principle: every operation is idempotent where it can
 * be (re-creating an existing folder is a no-op; moving a file to its
 * current path is a no-op) and surfaces conflicts loudly when it
 * can't (deleting a file that's still imported, splitting a file
 * across overlapping member partitions). The architect can re-run
 * the refactor pass without fear of compounding mutations.
 */

import path from "node:path";

import {
  getAdapterForFile,
  isCapability,
  isFile,
  isFolder,
  type DataFlowEdge,
  type FileNode,
  type FolderNode,
  type InterfacePlan,
  type NodeId,
  type PlannedClass,
  type PlannedInterface,
  type RPG,
} from "../rpg/index.js";
import { resolveImportEdges, resolveInheritEdges } from "../rpg/resolve.js";

// ── Operation types ──────────────────────────────────────────────────

export type RPGOperation =
  | CreateFolderOp
  | CreateFileOp
  | DeleteFileOp
  | MoveFileOp
  | SplitFileOp
  | MergeFilesOp
  | ExtractBaseClassOp
  | ExtractUtilityOp
  | SetInterfacePlanOp
  | SetDataFlowOp;

export interface CreateFolderOp {
  kind: "create_folder";
  path: string;
  /** Optional: link an architect-authored capability to this folder
   *  (sets `cap.mappedToId` + `cap.status = "mapped"`). */
  capabilityId?: NodeId;
}

export interface CreateFileOp {
  kind: "create_file";
  path: string;
  /** Optional starting source. Defaults to empty string — the file is
   *  empty until the implementor (Phase 6) writes code. */
  content?: string;
  capabilityId?: NodeId;
}

export interface DeleteFileOp {
  kind: "delete_file";
  path: string;
}

export interface MoveFileOp {
  kind: "move_file";
  fromPath: string;
  toPath: string;
}

export interface SplitFileOp {
  kind: "split_file";
  fromPath: string;
  /** Each destination owns a disjoint subset of the source's
   *  interfaces (by leaf-capability id). Members not listed in any
   *  partition stay in the source file. */
  into: Array<{ path: string; leafCapabilityIds: NodeId[] }>;
}

export interface MergeFilesOp {
  kind: "merge_files";
  fromPaths: string[];
  toPath: string;
}

export interface ExtractBaseClassOp {
  kind: "extract_base_class";
  /** File where the new base class lives. Created if absent. */
  toFile: string;
  baseClassName: string;
  baseDescription: string;
  /** Methods shared across the source classes that get lifted to the
   *  base. Each entry is a *signature* — the implementor decides
   *  whether the base provides a default body or stays abstract. */
  methods: Array<{
    name: string;
    description: string;
    signature: PlannedInterface["signature"];
    isStatic: boolean;
  }>;
  /** Classes (file path + class name) that should now extend the new
   *  base. Their `extendsName` is rewritten and `extendsFromFile` is
   *  set to `toFile`. Existing within-file extends are replaced. */
  rewriteExtenders: Array<{ filePath: string; className: string }>;
}

export interface ExtractUtilityOp {
  kind: "extract_utility";
  toFile: string;
  /** Functions to lift. Each names the source file + function name +
   *  the leaf capability that produced it. The leaf is re-mapped to
   *  the destination file. */
  members: Array<{ fromFile: string; functionName: string; leafCapabilityId: NodeId }>;
}

export interface SetInterfacePlanOp {
  kind: "set_interface_plan";
  filePath: string;
  plan: InterfacePlan;
}

export interface SetDataFlowOp {
  kind: "set_data_flow";
  edge: DataFlowEdge;
}

// ── Apply result ─────────────────────────────────────────────────────

export interface ApplyResult {
  ok: boolean;
  /** Per-operation diagnostic on failure. */
  error?: string;
  /** Stable label for the failure cause; lets the orchestrator decide
   *  whether to abort the batch or continue. */
  errorCode?:
    | "FILE_EXISTS"
    | "FILE_NOT_FOUND"
    | "PATH_INVALID"
    | "MEMBER_NOT_FOUND"
    | "BROKEN_IMPORT"
    | "OVERLAPPING_PARTITION"
    | "UNSUPPORTED_OPERATION"
    | "STATE_CONFLICT";
  /** Side-effects worth surfacing — file paths added, removed, or
   *  renamed. Useful for logs and downstream cache invalidation. */
  filesAdded: string[];
  filesRemoved: string[];
  filesRenamed: Array<{ from: string; to: string }>;
}

function ok(extra: Partial<ApplyResult> = {}): ApplyResult {
  return {
    ok: true,
    filesAdded: [],
    filesRemoved: [],
    filesRenamed: [],
    ...extra,
  };
}

function err(
  code: NonNullable<ApplyResult["errorCode"]>,
  message: string,
): ApplyResult {
  return {
    ok: false,
    errorCode: code,
    error: message,
    filesAdded: [],
    filesRemoved: [],
    filesRenamed: [],
  };
}

// ── Apply ────────────────────────────────────────────────────────────

export function applyOperation(rpg: RPG, op: RPGOperation): ApplyResult {
  switch (op.kind) {
    case "create_folder":
      return applyCreateFolder(rpg, op);
    case "create_file":
      return applyCreateFile(rpg, op);
    case "delete_file":
      return applyDeleteFile(rpg, op);
    case "move_file":
      return applyMoveFile(rpg, op);
    case "split_file":
      return applySplitFile(rpg, op);
    case "merge_files":
      return applyMergeFiles(rpg, op);
    case "extract_base_class":
      return applyExtractBaseClass(rpg, op);
    case "extract_utility":
      return applyExtractUtility(rpg, op);
    case "set_interface_plan":
      return applySetInterfacePlan(rpg, op);
    case "set_data_flow":
      return applySetDataFlow(rpg, op);
  }
}

/** Convenience: apply a batch of ops, stopping at the first failure
 *  and returning the merged report up to and including the failure.
 *  Caller can inspect `results[results.length - 1]` to find the cause. */
export interface BatchResult {
  ok: boolean;
  results: ApplyResult[];
  /** Aggregated side-effects across successful ops. */
  filesAdded: string[];
  filesRemoved: string[];
  filesRenamed: Array<{ from: string; to: string }>;
}

export function applyOperations(
  rpg: RPG,
  ops: RPGOperation[],
): BatchResult {
  const results: ApplyResult[] = [];
  const filesAdded: string[] = [];
  const filesRemoved: string[] = [];
  const filesRenamed: Array<{ from: string; to: string }> = [];
  for (const op of ops) {
    const r = applyOperation(rpg, op);
    results.push(r);
    if (!r.ok) {
      return { ok: false, results, filesAdded, filesRemoved, filesRenamed };
    }
    filesAdded.push(...r.filesAdded);
    filesRemoved.push(...r.filesRemoved);
    filesRenamed.push(...r.filesRenamed);
  }
  return { ok: true, results, filesAdded, filesRemoved, filesRenamed };
}

// ── Individual op implementations ────────────────────────────────────

function applyCreateFolder(rpg: RPG, op: CreateFolderOp): ApplyResult {
  const validation = validateRelPath(op.path, "folder");
  if (!validation.ok) return err("PATH_INVALID", validation.error);
  const folder = ensureFolder(rpg, validation.path);
  if (op.capabilityId) {
    const link = linkCapability(rpg, op.capabilityId, folder.id);
    if (!link.ok) return link;
  }
  return ok();
}

function applyCreateFile(rpg: RPG, op: CreateFileOp): ApplyResult {
  const validation = validateRelPath(op.path, "file");
  if (!validation.ok) return err("PATH_INVALID", validation.error);
  const existing = rpg.nodes[fileId(validation.path)];
  if (existing && isFile(existing)) {
    // Idempotent — just optionally link the capability.
    if (op.capabilityId) {
      const link = linkCapability(rpg, op.capabilityId, existing.id);
      if (!link.ok) return link;
    }
    return ok();
  }
  const file = ensureFile(rpg, validation.path, op.content ?? "");
  if (op.capabilityId) {
    const link = linkCapability(rpg, op.capabilityId, file.id);
    if (!link.ok) return link;
  }
  return ok({ filesAdded: [validation.path] });
}

function applyDeleteFile(rpg: RPG, op: DeleteFileOp): ApplyResult {
  const validation = validateRelPath(op.path, "file");
  if (!validation.ok) return err("PATH_INVALID", validation.error);
  const file = rpg.nodes[fileId(validation.path)];
  if (!file || !isFile(file)) {
    return err("FILE_NOT_FOUND", `no file at ${validation.path}`);
  }
  // Anyone still importing this file?
  const importers = importersOf(rpg, validation.path);
  if (importers.length > 0) {
    return err(
      "BROKEN_IMPORT",
      `cannot delete ${validation.path}; still imported by: ${importers.join(", ")}`,
    );
  }
  removeFileFromGraph(rpg, file);
  return ok({ filesRemoved: [validation.path] });
}

function applyMoveFile(rpg: RPG, op: MoveFileOp): ApplyResult {
  const fromOk = validateRelPath(op.fromPath, "file");
  if (!fromOk.ok) return err("PATH_INVALID", `fromPath: ${fromOk.error}`);
  const toOk = validateRelPath(op.toPath, "file");
  if (!toOk.ok) return err("PATH_INVALID", `toPath: ${toOk.error}`);
  if (fromOk.path === toOk.path) return ok();

  const file = rpg.nodes[fileId(fromOk.path)];
  if (!file || !isFile(file)) {
    return err("FILE_NOT_FOUND", `no file at ${fromOk.path}`);
  }
  const collision = rpg.nodes[fileId(toOk.path)];
  if (collision && isFile(collision)) {
    return err("FILE_EXISTS", `cannot move onto existing file ${toOk.path}`);
  }

  // Step 1: re-parent the FileNode under the destination folder, with
  // a new id keyed by the new path. Children/methods follow.
  const oldId = file.id;
  const newId = fileId(toOk.path);

  // Detach from old parent.
  const oldParent = rpg.nodes[file.parent!] as FolderNode | undefined;
  if (oldParent && isFolder(oldParent)) {
    oldParent.children = oldParent.children.filter((c) => c !== oldId);
  }

  // Mutate identity + path, attach to new parent.
  const newParentDir =
    path.dirname(toOk.path) === "." ? "" : path.dirname(toOk.path);
  const newParent = ensureFolder(rpg, newParentDir);
  delete rpg.nodes[oldId];
  file.id = newId;
  file.path = toOk.path;
  file.name = path.basename(toOk.path);
  file.parent = newParent.id;
  file.language = getAdapterForFile(toOk.path)?.language ?? null;
  rpg.nodes[newId] = file;
  newParent.children.push(newId);

  // Step 2: any AST node (class/function/method) inside this file
  // points at the file id via `parent` and `file`. Update them.
  for (const childId of file.children) {
    const child = rpg.nodes[childId];
    if (!child) continue;
    if (child.kind === "class") {
      child.parent = newId;
      child.file = newId;
      for (const methodId of child.children) {
        const method = rpg.nodes[methodId];
        if (method && method.kind === "method") {
          method.file = newId;
        }
      }
    } else if (child.kind === "function") {
      child.parent = newId;
      child.file = newId;
    }
  }

  // Step 3: rewrite import sources in any file that referenced the
  // old path via a relative specifier. We rewrite at the *raw* level
  // and then re-run resolution so import edges line up.
  rewriteImportSources(rpg, fromOk.path, toOk.path);

  // Step 4: any capability whose `mappedToId` was the old file id now
  // points at the new id.
  for (const node of Object.values(rpg.nodes)) {
    if (isCapability(node) && node.mappedToId === oldId) {
      node.mappedToId = newId;
    }
  }

  // Step 5: update PlannedClass.extendsFromFile values across the repo
  // that referred to the old path.
  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node) || !node.interfacePlan) continue;
    for (const cls of node.interfacePlan.classes) {
      if (cls.extendsFromFile === fromOk.path) {
        cls.extendsFromFile = toOk.path;
      }
    }
  }

  // Step 6: re-resolve cross-file edges.
  rpg.imports = resolveImportEdges(rpg);
  rpg.inherits = resolveInheritEdges(rpg);

  return ok({ filesRenamed: [{ from: fromOk.path, to: toOk.path }] });
}

function applySplitFile(rpg: RPG, op: SplitFileOp): ApplyResult {
  const fromOk = validateRelPath(op.fromPath, "file");
  if (!fromOk.ok) return err("PATH_INVALID", `fromPath: ${fromOk.error}`);
  const file = rpg.nodes[fileId(fromOk.path)];
  if (!file || !isFile(file)) {
    return err("FILE_NOT_FOUND", `no file at ${fromOk.path}`);
  }
  if (op.into.length === 0) {
    return err("UNSUPPORTED_OPERATION", "split_file with empty `into`");
  }
  // Validate destination paths + check overlap.
  const destPaths: string[] = [];
  for (const dest of op.into) {
    const v = validateRelPath(dest.path, "file");
    if (!v.ok) return err("PATH_INVALID", `into[].path: ${v.error}`);
    destPaths.push(v.path);
  }
  const seen = new Set<NodeId>();
  for (const dest of op.into) {
    for (const id of dest.leafCapabilityIds) {
      if (seen.has(id)) {
        return err(
          "OVERLAPPING_PARTITION",
          `leaf ${id} appears in multiple destinations`,
        );
      }
      seen.add(id);
    }
  }
  // Validate every leaf id is in the source file's plan.
  const plan = file.interfacePlan;
  if (!plan) {
    return err(
      "STATE_CONFLICT",
      `cannot split ${fromOk.path}: no interface plan attached`,
    );
  }
  const planLeafIds = new Set(plan.entries.map((e) => e.leafCapabilityId));
  for (const id of seen) {
    if (!planLeafIds.has(id)) {
      return err(
        "MEMBER_NOT_FOUND",
        `leaf ${id} not in ${fromOk.path}'s interface plan`,
      );
    }
  }

  // Build the leaf → destination map first; the cohesion check below
  // and the partition step further down both consume it.
  const leafToDest = new Map<NodeId, string>();
  for (let i = 0; i < op.into.length; i++) {
    const dest = op.into[i]!;
    const dp = destPaths[i]!;
    for (const id of dest.leafCapabilityIds) leafToDest.set(id, dp);
  }

  // Class-cohesion check: methods of the same class must all land in
  // the same destination, AND there can't be a method left in the
  // source while sibling methods move out — either case would orphan
  // a method whose ownerClassName isn't declared in its new file.
  const classDestSeen = new Map<string, string>();
  for (const entry of plan.entries) {
    if (entry.kind !== "method" || !entry.ownerClassName) continue;
    const dest = leafToDest.get(entry.leafCapabilityId);
    if (!dest) continue;
    const prior = classDestSeen.get(entry.ownerClassName);
    if (prior !== undefined && prior !== dest) {
      return err(
        "OVERLAPPING_PARTITION",
        `class "${entry.ownerClassName}" methods cannot split across destinations (${prior} vs ${dest})`,
      );
    }
    classDestSeen.set(entry.ownerClassName, dest);
  }
  for (const [className, destPath] of classDestSeen) {
    const stayingInSource = plan.entries.some(
      (e) =>
        e.kind === "method" &&
        e.ownerClassName === className &&
        !leafToDest.has(e.leafCapabilityId),
    );
    if (stayingInSource) {
      return err(
        "OVERLAPPING_PARTITION",
        `class "${className}" methods cannot split between source ${fromOk.path} and ${destPath}`,
      );
    }
  }

  // Partition entries by destination. Members not assigned stay in the
  // source. Classes follow their methods (cohesion already verified).
  const destPlans = new Map<string, InterfacePlan>();
  for (const dp of destPaths) {
    destPlans.set(dp, { entries: [], classes: [] });
  }
  const sourcePlan: InterfacePlan = { entries: [], classes: [] };

  // Move entries.
  const classDest = new Map<string, string>();
  for (const entry of plan.entries) {
    const dest = leafToDest.get(entry.leafCapabilityId);
    if (dest) {
      destPlans.get(dest)!.entries.push(entry);
      if (entry.kind === "method" && entry.ownerClassName) {
        const existing = classDest.get(entry.ownerClassName);
        if (!existing) {
          classDest.set(entry.ownerClassName, dest);
        }
      }
    } else {
      sourcePlan.entries.push(entry);
    }
  }
  // Move classes following their first-moved method; classes with no
  // moved methods stay in the source.
  for (const cls of plan.classes) {
    const dest = classDest.get(cls.name);
    if (dest) {
      destPlans.get(dest)!.classes.push(cls);
    } else {
      sourcePlan.classes.push(cls);
    }
  }

  // Apply: ensure destination files exist, set their plans, update
  // capability mappings.
  const filesAdded: string[] = [];
  for (const dp of destPaths) {
    const existed = rpg.nodes[fileId(dp)];
    if (!existed || !isFile(existed)) {
      ensureFile(rpg, dp, "");
      filesAdded.push(dp);
    }
    const target = rpg.nodes[fileId(dp)] as FileNode;
    target.interfacePlan = destPlans.get(dp);
  }
  // Update source plan in place; capabilities that moved get re-mapped.
  file.interfacePlan = sourcePlan;
  for (const [leafId, dest] of leafToDest) {
    const cap = rpg.nodes[leafId];
    if (cap && isCapability(cap)) {
      cap.mappedToId = fileId(dest);
    }
  }

  // Imports of moved members from sibling files need redirection to
  // their new home. We do this conservatively: for each file that
  // imported a moved member name from `fromPath`, add equivalent
  // import lines from the destinations. The original import line
  // stays intact (it might still reference members that didn't move);
  // dead imports are caught later by the loader's `parse-error` /
  // tsc steps when the source no longer exports the symbol.
  const movedNames = new Set<string>();
  for (const dest of op.into) {
    for (const leafId of dest.leafCapabilityIds) {
      const entry = plan.entries.find((e) => e.leafCapabilityId === leafId);
      if (entry) movedNames.add(entry.name);
    }
  }
  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node)) continue;
    if (node.path === fromOk.path) continue;
    for (const imp of node.rawImports) {
      if (!isRelativeReferenceTo(node.path, imp.source, fromOk.path)) continue;
      if (!movedNames.has(imp.name)) continue;
      // Find which destination owns `imp.name`.
      for (const [dest, dp] of destPlans) {
        if (dp.entries.some((e) => e.name === imp.name)) {
          // Add an import row from the destination file to the same
          // local binding.
          const newSource = relativeImportSpecifier(node.path, dest);
          if (
            !node.rawImports.some(
              (existing) =>
                existing.name === imp.name && existing.source === newSource,
            )
          ) {
            node.rawImports.push({
              name: imp.name,
              source: newSource,
              isDefault: imp.isDefault,
            });
          }
          break;
        }
      }
    }
  }

  // Re-resolve edges.
  rpg.imports = resolveImportEdges(rpg);
  rpg.inherits = resolveInheritEdges(rpg);

  return ok({ filesAdded });
}

function applyMergeFiles(rpg: RPG, op: MergeFilesOp): ApplyResult {
  if (op.fromPaths.length === 0) {
    return err("UNSUPPORTED_OPERATION", "merge_files with no sources");
  }
  const toOk = validateRelPath(op.toPath, "file");
  if (!toOk.ok) return err("PATH_INVALID", `toPath: ${toOk.error}`);
  const sources: FileNode[] = [];
  for (const fromPath of op.fromPaths) {
    const v = validateRelPath(fromPath, "file");
    if (!v.ok) return err("PATH_INVALID", `fromPaths: ${v.error}`);
    const f = rpg.nodes[fileId(v.path)];
    if (!f || !isFile(f)) {
      return err("FILE_NOT_FOUND", `no file at ${v.path}`);
    }
    sources.push(f);
  }

  // Create or reuse the destination.
  let dest = rpg.nodes[fileId(toOk.path)];
  if (!dest || !isFile(dest)) {
    ensureFile(rpg, toOk.path, "");
    dest = rpg.nodes[fileId(toOk.path)] as FileNode;
  }
  const destFile = dest as FileNode;
  destFile.interfacePlan = destFile.interfacePlan ?? { entries: [], classes: [] };

  // Concatenate plans + collision-check class names.
  const filesRemoved: string[] = [];
  const seenClassNames = new Set(destFile.interfacePlan.classes.map((c) => c.name));
  for (const src of sources) {
    if (src.path === toOk.path) continue;
    if (src.interfacePlan) {
      for (const cls of src.interfacePlan.classes) {
        if (seenClassNames.has(cls.name)) {
          return err(
            "STATE_CONFLICT",
            `merge would duplicate class ${cls.name} in ${toOk.path}`,
          );
        }
        seenClassNames.add(cls.name);
        destFile.interfacePlan.classes.push(cls);
      }
      destFile.interfacePlan.entries.push(...src.interfacePlan.entries);
    }
    // Re-map each source's leaf capabilities to the destination.
    for (const node of Object.values(rpg.nodes)) {
      if (isCapability(node) && node.mappedToId === src.id) {
        node.mappedToId = destFile.id;
      }
    }
    // Append rawImports — Phase 6 regenerates `content` from the
    // merged `interfacePlan`, so the merge intentionally leaves
    // `destFile.content` alone. Imports are concatenated with
    // duplicate suppression so the resolver still sees consistent
    // edges before Phase 6 runs.
    for (const imp of src.rawImports) {
      if (
        !destFile.rawImports.some(
          (existing) =>
            existing.name === imp.name &&
            existing.source === imp.source &&
            existing.isDefault === imp.isDefault,
        )
      ) {
        destFile.rawImports.push({ ...imp });
      }
    }

    removeFileFromGraph(rpg, src);
    filesRemoved.push(src.path);
  }

  // Rewrite imports in the rest of the repo: any import from a removed
  // source path is redirected to the destination.
  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node)) continue;
    if (node.path === toOk.path) continue;
    for (const imp of node.rawImports) {
      for (const removed of filesRemoved) {
        if (isRelativeReferenceTo(node.path, imp.source, removed)) {
          imp.source = relativeImportSpecifier(node.path, toOk.path);
        }
      }
    }
  }

  rpg.imports = resolveImportEdges(rpg);
  rpg.inherits = resolveInheritEdges(rpg);

  return ok({ filesRemoved });
}

function applyExtractBaseClass(
  rpg: RPG,
  op: ExtractBaseClassOp,
): ApplyResult {
  const toOk = validateRelPath(op.toFile, "file");
  if (!toOk.ok) return err("PATH_INVALID", `toFile: ${toOk.error}`);
  // Resolve every extender pointer.
  const extenders: Array<{ file: FileNode; cls: PlannedClass }> = [];
  for (const ref of op.rewriteExtenders) {
    const f = rpg.nodes[fileId(ref.filePath)];
    if (!f || !isFile(f) || !f.interfacePlan) {
      return err(
        "FILE_NOT_FOUND",
        `extender file ${ref.filePath} missing or has no plan`,
      );
    }
    const cls = f.interfacePlan.classes.find((c) => c.name === ref.className);
    if (!cls) {
      return err(
        "MEMBER_NOT_FOUND",
        `class ${ref.className} not found in ${ref.filePath}`,
      );
    }
    extenders.push({ file: f, cls });
  }
  // Create / reuse the base file.
  const filesAdded: string[] = [];
  let baseFile = rpg.nodes[fileId(toOk.path)];
  if (!baseFile || !isFile(baseFile)) {
    ensureFile(rpg, toOk.path, "");
    baseFile = rpg.nodes[fileId(toOk.path)] as FileNode;
    filesAdded.push(toOk.path);
  }
  const basePlan = (baseFile as FileNode).interfacePlan ?? {
    entries: [],
    classes: [],
  };
  // Don't duplicate the base class if it already exists.
  if (!basePlan.classes.some((c) => c.name === op.baseClassName)) {
    basePlan.classes.push({
      name: op.baseClassName,
      description: op.baseDescription,
      extendsName: null,
      extendsFromFile: null,
      exported: true,
    });
  }
  // Add the lifted method signatures as plan entries on the base
  // file. Each entry gets a synthetic leaf-capability id keyed by
  // file + class + method so re-running the op stays idempotent. The
  // implementor (Phase 6) renders abstract methods or default bodies
  // depending on the language adapter — same as any other planned
  // method.
  for (const m of op.methods) {
    const synthLeafId = baseMethodLeafId(toOk.path, op.baseClassName, m.name);
    if (
      !basePlan.entries.some((e) => e.leafCapabilityId === synthLeafId)
    ) {
      basePlan.entries.push({
        leafCapabilityId: synthLeafId,
        kind: "method",
        ownerClassName: op.baseClassName,
        name: m.name,
        signature: {
          params: m.signature.params.map((p) => ({ ...p })),
          returnType: m.signature.returnType,
          isAsync: m.signature.isAsync,
        },
        description: m.description,
        exported: true,
        isStatic: m.isStatic,
      });
    }
  }
  (baseFile as FileNode).interfacePlan = basePlan;

  // Wire each extender to point at the base. If the extender already
  // had its own extends, surface a STATE_CONFLICT — silently
  // overwriting prior inheritance is too risky.
  for (const ext of extenders) {
    if (
      ext.cls.extendsName !== null &&
      !(
        ext.cls.extendsName === op.baseClassName &&
        ext.cls.extendsFromFile === toOk.path
      )
    ) {
      return err(
        "STATE_CONFLICT",
        `class ${ext.cls.name} in ${ext.file.path} already extends ${ext.cls.extendsName}; refusing to overwrite`,
      );
    }
    ext.cls.extendsName = op.baseClassName;
    ext.cls.extendsFromFile = toOk.path;
    // Add an import row so cross-file resolution sees the link.
    const source = relativeImportSpecifier(ext.file.path, toOk.path);
    if (
      !ext.file.rawImports.some(
        (i) => i.name === op.baseClassName && i.source === source,
      )
    ) {
      ext.file.rawImports.push({
        name: op.baseClassName,
        source,
        isDefault: false,
      });
    }
  }

  rpg.imports = resolveImportEdges(rpg);
  rpg.inherits = resolveInheritEdges(rpg);

  return ok({ filesAdded });
}

function applyExtractUtility(rpg: RPG, op: ExtractUtilityOp): ApplyResult {
  const toOk = validateRelPath(op.toFile, "file");
  if (!toOk.ok) return err("PATH_INVALID", `toFile: ${toOk.error}`);
  // Validate and gather members.
  const moves: Array<{
    sourceFile: FileNode;
    entry: PlannedInterface;
  }> = [];
  for (const m of op.members) {
    const src = rpg.nodes[fileId(m.fromFile)];
    if (!src || !isFile(src)) {
      return err("FILE_NOT_FOUND", `source file ${m.fromFile} missing`);
    }
    if (!src.interfacePlan) {
      return err(
        "STATE_CONFLICT",
        `cannot extract from ${m.fromFile}: no interface plan`,
      );
    }
    const entry = src.interfacePlan.entries.find(
      (e) => e.leafCapabilityId === m.leafCapabilityId,
    );
    if (!entry) {
      return err(
        "MEMBER_NOT_FOUND",
        `leaf ${m.leafCapabilityId} not in ${m.fromFile}`,
      );
    }
    if (entry.name !== m.functionName) {
      return err(
        "MEMBER_NOT_FOUND",
        `leaf ${m.leafCapabilityId} is named ${entry.name}, not ${m.functionName}`,
      );
    }
    if (entry.kind !== "function") {
      return err(
        "UNSUPPORTED_OPERATION",
        `extract_utility only moves functions (got ${entry.kind})`,
      );
    }
    moves.push({ sourceFile: src, entry });
  }
  // Create / reuse destination.
  const filesAdded: string[] = [];
  let dest = rpg.nodes[fileId(toOk.path)];
  if (!dest || !isFile(dest)) {
    ensureFile(rpg, toOk.path, "");
    dest = rpg.nodes[fileId(toOk.path)] as FileNode;
    filesAdded.push(toOk.path);
  }
  const destFile = dest as FileNode;
  destFile.interfacePlan = destFile.interfacePlan ?? { entries: [], classes: [] };

  // Move each entry; remove from source plan; remap leaf capability;
  // add import row in source pointing at dest.
  for (const move of moves) {
    const srcPlan = move.sourceFile.interfacePlan!;
    srcPlan.entries = srcPlan.entries.filter(
      (e) => e.leafCapabilityId !== move.entry.leafCapabilityId,
    );
    destFile.interfacePlan.entries.push(move.entry);

    const cap = rpg.nodes[move.entry.leafCapabilityId];
    if (cap && isCapability(cap)) {
      cap.mappedToId = destFile.id;
    }

    // Anyone who used this function via `from './fromFile'` now imports
    // it from the destination. We rewrite at the rawImports level for
    // the actual sources of those imports.
    const importSource = relativeImportSpecifier(
      move.sourceFile.path,
      toOk.path,
    );
    if (
      !move.sourceFile.rawImports.some(
        (i) => i.name === move.entry.name && i.source === importSource,
      )
    ) {
      // This is a self-import from the source's old self-reference;
      // skip if the source file IS the same file (shouldn't happen
      // because we filter by fromFile).
    }
    for (const node of Object.values(rpg.nodes)) {
      if (!isFile(node)) continue;
      if (node.path === toOk.path) continue;
      for (const imp of node.rawImports) {
        if (
          imp.name === move.entry.name &&
          isRelativeReferenceTo(node.path, imp.source, move.sourceFile.path)
        ) {
          imp.source = relativeImportSpecifier(node.path, toOk.path);
        }
      }
    }
  }

  rpg.imports = resolveImportEdges(rpg);
  rpg.inherits = resolveInheritEdges(rpg);

  return ok({ filesAdded });
}

function applySetInterfacePlan(
  rpg: RPG,
  op: SetInterfacePlanOp,
): ApplyResult {
  const v = validateRelPath(op.filePath, "file");
  if (!v.ok) return err("PATH_INVALID", v.error);
  const f = rpg.nodes[fileId(v.path)];
  if (!f || !isFile(f)) {
    return err("FILE_NOT_FOUND", `no file at ${v.path}`);
  }
  f.interfacePlan = op.plan;
  return ok();
}

function applySetDataFlow(rpg: RPG, op: SetDataFlowOp): ApplyResult {
  const key = `${op.edge.fromNode}->${op.edge.toNode}`;
  rpg.dataFlow = rpg.dataFlow.filter(
    (e) => `${e.fromNode}->${e.toNode}` !== key,
  );
  rpg.dataFlow.push({ ...op.edge });
  return ok();
}

// ── Helpers ──────────────────────────────────────────────────────────

interface PathOk {
  ok: true;
  path: string;
}
interface PathErr {
  ok: false;
  error: string;
}

function validateRelPath(raw: string, kind: "file" | "folder"): PathOk | PathErr {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "empty path" };
  }
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return { ok: false, error: `must be relative: ${raw}` };
  }
  if (path.isAbsolute(normalized)) {
    return { ok: false, error: `must be relative: ${raw}` };
  }
  if (normalized.split("/").some((seg) => seg === "..")) {
    return { ok: false, error: `must not contain "..": ${raw}` };
  }
  if (kind === "folder") {
    return { ok: true, path: normalized.replace(/\/+$/, "") };
  }
  if (path.extname(normalized).length === 0) {
    return { ok: false, error: `file path requires an extension: ${raw}` };
  }
  return { ok: true, path: normalized };
}

function fileId(relPath: string): NodeId {
  return `file:${relPath}`;
}
function folderId(relPath: string): NodeId {
  return `folder:${relPath}`;
}

/** Synthetic leaf id for base-class methods produced by
 *  `extract_base_class`. Format keeps the id stable across
 *  re-applications of the same op (idempotency) and clearly marks
 *  the entry as architect-synthesized rather than capability-derived. */
function baseMethodLeafId(
  filePath: string,
  className: string,
  methodName: string,
): NodeId {
  return `iface:${filePath}#${className}.${methodName}`;
}

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

function ensureFile(rpg: RPG, relPath: string, content: string): FileNode {
  const id = fileId(relPath);
  const existing = rpg.nodes[id];
  if (existing && isFile(existing)) return existing;
  const parentDir = path.dirname(relPath) === "." ? "" : path.dirname(relPath);
  const parent = ensureFolder(rpg, parentDir);
  const node: FileNode = {
    id,
    kind: "file",
    name: path.basename(relPath),
    parent: parent.id,
    children: [],
    features: [],
    path: relPath,
    content,
    language: getAdapterForFile(relPath)?.language ?? null,
    rawImports: [],
    exports: [],
  };
  rpg.nodes[id] = node;
  parent.children.push(id);
  return node;
}

function linkCapability(
  rpg: RPG,
  capabilityId: NodeId,
  targetId: NodeId,
): ApplyResult {
  const cap = rpg.nodes[capabilityId];
  if (!cap || !isCapability(cap)) {
    return err(
      "MEMBER_NOT_FOUND",
      `capability ${capabilityId} not found`,
    );
  }
  cap.status = "mapped";
  cap.mappedToId = targetId;
  return ok();
}

function removeFileFromGraph(rpg: RPG, file: FileNode): void {
  // Drop AST children + methods of any class.
  for (const childId of [...file.children]) {
    const child = rpg.nodes[childId];
    if (!child) continue;
    if (child.kind === "class") {
      for (const methodId of child.children) {
        delete rpg.nodes[methodId];
      }
    }
    delete rpg.nodes[childId];
  }
  // Detach from parent folder.
  const parent = rpg.nodes[file.parent!];
  if (parent && isFolder(parent)) {
    parent.children = parent.children.filter((c) => c !== file.id);
  }
  delete rpg.nodes[file.id];
  // Capability mappings to this file fall back to the parent folder.
  for (const node of Object.values(rpg.nodes)) {
    if (isCapability(node) && node.mappedToId === file.id) {
      node.mappedToId = file.parent;
    }
  }
  // Re-resolve edges so phantom imports/inherits to this file go away.
  rpg.imports = resolveImportEdges(rpg);
  rpg.inherits = resolveInheritEdges(rpg);
}

function importersOf(rpg: RPG, filePath: string): string[] {
  const out: string[] = [];
  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node)) continue;
    if (node.path === filePath) continue;
    if (
      node.rawImports.some((imp) =>
        isRelativeReferenceTo(node.path, imp.source, filePath),
      )
    ) {
      out.push(node.path);
    }
  }
  return out;
}

function rewriteImportSources(
  rpg: RPG,
  fromPath: string,
  toPath: string,
): void {
  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node)) continue;
    for (const imp of node.rawImports) {
      if (isRelativeReferenceTo(node.path, imp.source, fromPath)) {
        imp.source = relativeImportSpecifier(node.path, toPath);
      }
    }
  }
}

/** True iff `importerFile`'s import specifier `source` (relative form)
 *  resolves to `targetFile`'s path. Mirrors the loader's
 *  `resolveImportSpecifier` resolution rules:
 *    - bare specifier matching the path with target's extension
 *    - the TS-as-JS rewrite (`./util.js` → `./util.ts`)
 *    - directory specifier whose `index.<ext>` is the target
 *    - explicit `<dir>/index` form */
function isRelativeReferenceTo(
  importerFile: string,
  source: string,
  targetFile: string,
): boolean {
  if (!source.startsWith(".")) return false;
  const importerDir = path.posix.dirname(importerFile);
  const candidate = path.posix.normalize(path.posix.join(importerDir, source));
  const targetExt = path.extname(targetFile);
  const targetDir = path.posix.dirname(targetFile);
  const targetBase = path.basename(targetFile, targetExt);
  return (
    candidate === targetFile ||
    candidate === stripExt(targetFile) ||
    `${candidate}${targetExt}` === targetFile ||
    candidate.replace(/\.js$/, targetExt) === targetFile ||
    // index-file convention: target = `<dir>/index.<ext>` matches a
    // candidate equal to `<dir>` (bare) or `<dir>/index` (explicit).
    (targetBase === "index" &&
      (candidate === targetDir ||
        candidate === path.posix.join(targetDir, "index")))
  );
}

function stripExt(p: string): string {
  const ext = path.extname(p);
  return ext.length > 0 ? p.slice(0, -ext.length) : p;
}

/** Compute the relative-import specifier `from` would use to import
 *  `to`. Uses POSIX separators throughout (in-repo paths are POSIX
 *  even on Windows hosts) and a `./` prefix when the result doesn't
 *  already start with `..`. Drops the file extension to match the
 *  typical TS-source convention; ESM-strict consumers can append it
 *  later.
 *
 *  When the target is a `<dir>/index.<ext>` file, the specifier
 *  collapses to `<dir>` so importers don't have to repeat the index
 *  filename — matches the `import './lib'` convention more readers
 *  expect than `import './lib/index'`. */
function relativeImportSpecifier(fromFile: string, toFile: string): string {
  const fromDir = path.posix.dirname(fromFile);
  let rel = path.posix.relative(fromDir, toFile);
  const ext = path.extname(rel);
  const base = path.basename(rel, ext);
  // index collapse: `./lib/index` → `./lib`.
  if (base === "index") {
    const dir = path.posix.dirname(rel);
    rel = dir === "." ? "." : dir;
  } else {
    rel = stripExt(rel);
  }
  if (rel === ".") return ".";
  if (rel.startsWith(".") || rel.startsWith("/")) return rel;
  return `./${rel}`;
}
