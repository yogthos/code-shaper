/**
 * Localization tools — RPG paper Appendix D.1.
 *
 * Five graph-guided tools the agent uses to map a natural-language
 * task ("fix this failing branch", "add this feature") onto the
 * concrete code artifacts that need attention. Outputs are
 * structured lists; the agent terminates with a ranked list of
 * `{file_path, interface}` pairs the editing stage will then act on.
 *
 * §D.1 specifies the tools verbatim:
 *
 *   view_file_interface_feature_map(file_path)
 *     "Inspects a single file to list the interface structures
 *      (functions, classes, methods) it contains, along with the
 *      feature mappings they support."
 *
 *   get_interface_content(target_specs)
 *     "Retrieves the full implementation code of a specific
 *      function, class, or method, given its fully qualified name
 *      (file path + entity name)."
 *
 *   expand_leaf_node_info(feature_path)
 *     "Given a feature path from the implemented feature tree,
 *      this tool expands and lists all associated interfaces
 *      (functions or classes)."
 *
 *   search_interface_by_functionality(keywords)
 *     "Performs a fuzzy semantic search for interfaces based on
 *      given keywords and returns the top-5 most relevant
 *      interface implementations."
 *
 *   Terminate(result)
 *     "Returns the final ranked list of located interfaces."
 *
 * This module implements the four data-tools (Terminate is a
 * control-flow signal handled by the agent loop in localization.ts).
 * Each function takes the RPG and the tool's arguments; returns a
 * structured payload the agent serializes into its prompt.
 */

import {
  isCapability,
  isClass,
  isFile,
  isFunction,
  isMethod,
  type CapabilityNode,
  type ClassNode,
  type FileNode,
  type FunctionNode,
  type MethodNode,
  type NodeId,
  type RPG,
  type RPGNode,
} from "../rpg/types.js";

// ── Output shapes ────────────────────────────────────────────────────

export interface FileInterfaceMap {
  filePath: string;
  /** Top-level functions in source order. */
  functions: Array<{
    name: string;
    /** Feature tags = capability descriptions associated with this
     *  interface via PlannedInterface.leafCapabilityId. Empty when
     *  the function isn't bound to a planned leaf (rare in
     *  greenfield runs; common in extend mode where existing code
     *  hasn't been mapped). */
    features: string[];
    signature: string;
  }>;
  /** Top-level classes in source order, with their methods and
   *  per-method features. */
  classes: Array<{
    name: string;
    features: string[];
    methods: Array<{
      name: string;
      features: string[];
      signature: string;
    }>;
  }>;
}

export interface InterfaceContent {
  /** Fully qualified spec the agent passed in. */
  spec: string;
  /** "function" | "class" | "method" — what was located. */
  kind: "function" | "class" | "method" | "not_found";
  /** Source code; empty when kind === "not_found". */
  source: string;
  /** Containing file path. */
  filePath: string;
  /** Optional feature tags. */
  features?: string[];
}

export interface LeafNodeExpansion {
  featurePath: string;
  /** The capability the feature path resolved to; null if the path
   *  doesn't match any capability in the RPG. */
  capabilityId: NodeId | null;
  /** Children interfaces (functions, classes, methods). For a
   *  non-leaf capability, includes interfaces under all descendants. */
  interfaces: Array<{
    kind: "function" | "class" | "method";
    /** "ClassName.method" for methods; bare name for functions/classes. */
    name: string;
    filePath: string;
    description: string;
  }>;
}

export interface FunctionalitySearchResult {
  keywords: string[];
  /** Top-5 (or fewer) interfaces ranked by simple keyword overlap.
   *  This is the lexical version; embedding-based ranking is
   *  feature #6's territory and would replace the scoring here. */
  hits: Array<{
    kind: "function" | "class" | "method";
    name: string;
    filePath: string;
    description: string;
    score: number;
  }>;
}

// ── Tools ────────────────────────────────────────────────────────────

/**
 * Tool 1 (§D.1): list interfaces in a file along with their feature
 * tags. Returns null when the file isn't in the RPG.
 */
export function viewFileInterfaceFeatureMap(
  rpg: RPG,
  filePath: string,
): FileInterfaceMap | null {
  const file = findFileByPath(rpg, filePath);
  if (!file) return null;

  const functions: FileInterfaceMap["functions"] = [];
  const classes: FileInterfaceMap["classes"] = [];

  // Source-order is the order children land in `file.children`. For
  // files with an interfacePlan but no AST extraction yet (fresh
  // generation), we fall back to the plan's own ordering.
  if (file.children.length > 0) {
    // AST-extracted: iterate file.children, preserving source order.
    for (const id of file.children) {
      const node = rpg.nodes[id];
      if (!node) continue;
      if (isFunction(node)) {
        functions.push({
          name: node.name,
          features: featuresForName(file, node.name, null),
          signature: signatureFromAst(node),
        });
      } else if (isClass(node)) {
        const methods: FileInterfaceMap["classes"][number]["methods"] = [];
        for (const mid of node.children) {
          const method = rpg.nodes[mid];
          if (method && isMethod(method)) {
            methods.push({
              name: method.name,
              features: featuresForName(file, method.name, node.name),
              signature: signatureFromAst(method),
            });
          }
        }
        classes.push({
          name: node.name,
          features: featuresForName(file, node.name, null),
          methods,
        });
      }
    }
  } else if (file.interfacePlan) {
    // Plan-only: emit from the architect's planned interfaces.
    const methodsByClass = new Map<
      string,
      FileInterfaceMap["classes"][number]["methods"]
    >();
    for (const e of file.interfacePlan.entries) {
      const sig = renderPlannedSignature(e);
      if (e.kind === "method" && e.ownerClassName) {
        const list = methodsByClass.get(e.ownerClassName) ?? [];
        list.push({
          name: e.name,
          features: [e.description],
          signature: sig,
        });
        methodsByClass.set(e.ownerClassName, list);
      } else {
        functions.push({
          name: e.name,
          features: [e.description],
          signature: sig,
        });
      }
    }
    for (const cls of file.interfacePlan.classes) {
      classes.push({
        name: cls.name,
        features: [cls.description],
        methods: methodsByClass.get(cls.name) ?? [],
      });
    }
  }

  return { filePath: file.path, functions, classes };
}

/**
 * Tool 2 (§D.1): fetch the source code of a specific interface by
 * fully qualified name. The spec format is `<file_path>:<entity>`
 * where `<entity>` is `name`, `Class.method`, or just `Class`.
 *
 * For AST-extracted nodes, returns the slice from the file's content
 * by byteRange. For plan-only files, returns the rendered output of
 * the implementor's renderer (the renderer can't be imported here
 * to avoid a cycle, so the caller must pass an explicit `renderFn`
 * if they want plan-only support — for now we return empty for that
 * branch and let the agent navigate elsewhere).
 */
export function getInterfaceContent(
  rpg: RPG,
  spec: string,
): InterfaceContent {
  const parsed = parseFqn(spec);
  if (!parsed) {
    return {
      spec,
      kind: "not_found",
      source: "",
      filePath: "",
    };
  }
  const { filePath, classOrFn, methodName } = parsed;
  const file = findFileByPath(rpg, filePath);
  if (!file) {
    return { spec, kind: "not_found", source: "", filePath };
  }

  if (methodName !== null) {
    // ClassName.method
    for (const id of file.children) {
      const node = rpg.nodes[id];
      if (!node || !isClass(node)) continue;
      if (node.name !== classOrFn) continue;
      for (const mid of node.children) {
        const method = rpg.nodes[mid];
        if (method && isMethod(method) && method.name === methodName) {
          const src = extractFromContent(file, method);
          // Review fix #7: empty extraction is treated as
          // not_found. Otherwise callers get kind:"method"
          // with source:"" and no signal that the lookup
          // actually failed.
          if (!src) {
            return { spec, kind: "not_found", source: "", filePath };
          }
          return {
            spec,
            kind: "method",
            source: src,
            filePath,
            features: featuresForName(file, methodName, classOrFn),
          };
        }
      }
    }
    return { spec, kind: "not_found", source: "", filePath };
  }

  // Free-standing: try function first, then class.
  for (const id of file.children) {
    const node = rpg.nodes[id];
    if (!node) continue;
    if (isFunction(node) && node.name === classOrFn) {
      const src = extractFromContent(file, node);
      if (!src) {
        return { spec, kind: "not_found", source: "", filePath };
      }
      return {
        spec,
        kind: "function",
        source: src,
        filePath,
        features: featuresForName(file, classOrFn, null),
      };
    }
    if (isClass(node) && node.name === classOrFn) {
      const src = extractFromContent(file, node);
      if (!src) {
        return { spec, kind: "not_found", source: "", filePath };
      }
      return {
        spec,
        kind: "class",
        source: src,
        filePath,
        features: featuresForName(file, classOrFn, null),
      };
    }
  }
  return { spec, kind: "not_found", source: "", filePath };
}

/**
 * Tool 3 (§D.1): given a slash-separated capability path
 * (e.g. "TodoStore/Mutations/addTodo"), expand it to the list of
 * interfaces under that capability — including descendants when the
 * target is a non-leaf.
 */
export function expandLeafNodeInfo(
  rpg: RPG,
  featurePath: string,
): LeafNodeExpansion {
  const target = findCapabilityByPath(rpg, featurePath);
  if (!target) {
    return { featurePath, capabilityId: null, interfaces: [] };
  }
  const out: LeafNodeExpansion["interfaces"] = [];
  collectMappedInterfaces(rpg, target, out);
  return { featurePath, capabilityId: target.id, interfaces: out };
}

/**
 * Tool 4 (§D.1): fuzzy keyword search across all interfaces
 * (functions, classes, methods) — name, description, and feature
 * tags. Returns the top-5 (or fewer) by overlap score.
 *
 * Lexical-only ranking: each interface's searchable text is
 * tokenized, tokens overlapping with the query keywords contribute
 * to score. Embedding-based ranking is feature #6 and would slot
 * in here verbatim by replacing the score function.
 */
export function searchInterfaceByFunctionality(
  rpg: RPG,
  keywords: string[],
  topK = 5,
): FunctionalitySearchResult {
  const queryTokens = keywords
    .flatMap((k) => tokenize(k))
    .filter((t) => t.length > 0);
  const querySet = new Set(queryTokens);
  const candidates: Array<{
    kind: "function" | "class" | "method";
    name: string;
    filePath: string;
    description: string;
    score: number;
  }> = [];

  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node)) continue;
    const filePath = node.path;
    if (node.interfacePlan) {
      for (const e of node.interfacePlan.entries) {
        const display = e.kind === "method" && e.ownerClassName
          ? `${e.ownerClassName}.${e.name}`
          : e.name;
        const haystack = [display, e.description].join(" ");
        const score = scoreOverlap(haystack, querySet);
        if (score > 0) {
          candidates.push({
            kind: e.kind,
            name: display,
            filePath,
            description: e.description,
            score,
          });
        }
      }
      for (const cls of node.interfacePlan.classes) {
        const haystack = [cls.name, cls.description].join(" ");
        const score = scoreOverlap(haystack, querySet);
        if (score > 0) {
          candidates.push({
            kind: "class",
            name: cls.name,
            filePath,
            description: cls.description,
            score,
          });
        }
      }
    }
    // AST-extracted children too — lets the search find hand-
    // written interfaces in extend mode.
    for (const id of node.children) {
      const child = rpg.nodes[id];
      if (!child) continue;
      if (isFunction(child)) {
        const score = scoreOverlap(child.name, querySet);
        if (score > 0) {
          candidates.push({
            kind: "function",
            name: child.name,
            filePath,
            description: "",
            score,
          });
        }
      }
      if (isClass(child)) {
        const score = scoreOverlap(child.name, querySet);
        if (score > 0) {
          candidates.push({
            kind: "class",
            name: child.name,
            filePath,
            description: "",
            score,
          });
        }
        for (const mid of child.children) {
          const method = rpg.nodes[mid];
          if (method && isMethod(method)) {
            const display = `${child.name}.${method.name}`;
            const sc = scoreOverlap(display, querySet);
            if (sc > 0) {
              candidates.push({
                kind: "method",
                name: display,
                filePath,
                description: "",
                score: sc,
              });
            }
          }
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return { keywords, hits: candidates.slice(0, topK) };
}

// ── Internals ────────────────────────────────────────────────────────

function findFileByPath(rpg: RPG, filePath: string): FileNode | null {
  // Normalize trailing slashes / duplicate separators.
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const node of Object.values(rpg.nodes)) {
    if (isFile(node) && node.path === normalized) return node;
  }
  return null;
}

interface ParsedFqn {
  filePath: string;
  classOrFn: string;
  methodName: string | null;
}

/**
 * Parse a fully qualified spec like "src/foo.ts:bar" or
 * "src/foo.ts:Bar.baz". The split point is the LAST colon (so file
 * paths can't contain colons — POSIX repo-relative paths can't, so
 * this is fine for our targets). The entity then splits on the
 * LAST dot — review fix #2: a class/function with multiple dots
 * (e.g. "Bar.Baz.qux") is parsed as `class Bar.Baz` + `method qux`,
 * which matches what writers actually mean by a fully qualified
 * name. The previous first-dot split mistakenly mapped
 * "obj.inner.fn" to `obj` + `inner.fn`.
 */
function parseFqn(spec: string): ParsedFqn | null {
  const colon = spec.lastIndexOf(":");
  if (colon < 0) return null;
  const filePath = spec.slice(0, colon).trim();
  const entity = spec.slice(colon + 1).trim();
  if (!filePath || !entity) return null;
  const dot = entity.lastIndexOf(".");
  if (dot < 0) {
    return { filePath, classOrFn: entity, methodName: null };
  }
  return {
    filePath,
    classOrFn: entity.slice(0, dot),
    methodName: entity.slice(dot + 1),
  };
}

function findCapabilityByPath(
  rpg: RPG,
  featurePath: string,
): CapabilityNode | null {
  // Path segments separated by "/". Each segment matches a capability
  // name at the corresponding depth (case-sensitive). The walk starts
  // from a TOP-LEVEL capability whose name matches the first segment.
  // Review fix #10: we previously matched any capability anywhere in
  // the graph; if "Mutations" appeared under multiple parents the
  // walker matched the first by Object.values order — non-deterministic.
  const parts = featurePath
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  // Top-level capabilities = direct children of the root folder, OR
  // capabilities whose parent isn't itself a capability (some RPGs
  // attach top-level caps directly under a non-root grouping).
  const topLevelCaps = Object.values(rpg.nodes).filter(
    (n): n is CapabilityNode => {
      if (!isCapability(n)) return false;
      // parent is NodeId | null; null means top-level under the
      // root folder. A capability whose parent is non-capability
      // (folder/file) is also "top-level" in the capability tree.
      if (n.parent === null) return true;
      const parent = rpg.nodes[n.parent];
      return !parent || !isCapability(parent);
    },
  );
  for (const cap of topLevelCaps) {
    if (cap.name !== parts[0]) continue;
    let cursor: CapabilityNode | null = cap;
    let matched = true;
    for (let i = 1; i < parts.length && cursor; i++) {
      const targetName = parts[i];
      let next: CapabilityNode | null = null;
      const childIds: NodeId[] = cursor.children;
      for (const id of childIds) {
        const child: RPGNode | undefined = rpg.nodes[id];
        if (child && isCapability(child) && child.name === targetName) {
          next = child;
          break;
        }
      }
      if (!next) {
        matched = false;
        break;
      }
      cursor = next;
    }
    if (matched && cursor) return cursor;
  }
  return null;
}

function collectMappedInterfaces(
  rpg: RPG,
  cap: CapabilityNode,
  out: LeafNodeExpansion["interfaces"],
): void {
  if (cap.mappedToId && cap.isLeaf) {
    const target = rpg.nodes[cap.mappedToId];
    if (target && isFile(target) && target.interfacePlan) {
      // Find the entry in the plan that matches this leaf id.
      const entry = target.interfacePlan.entries.find(
        (e) => e.leafCapabilityId === cap.id,
      );
      if (entry) {
        const display =
          entry.kind === "method" && entry.ownerClassName
            ? `${entry.ownerClassName}.${entry.name}`
            : entry.name;
        out.push({
          kind: entry.kind,
          name: display,
          filePath: target.path,
          description: cap.description,
        });
      }
    }
  }
  for (const id of cap.children) {
    const child = rpg.nodes[id];
    if (child && isCapability(child)) {
      collectMappedInterfaces(rpg, child, out);
    }
  }
}

function featuresForName(
  file: FileNode,
  entityName: string,
  ownerClassName: string | null,
): string[] {
  if (!file.interfacePlan) return [];
  const features: string[] = [];
  for (const e of file.interfacePlan.entries) {
    if (
      e.name === entityName &&
      (ownerClassName === null
        ? e.kind === "function"
        : e.ownerClassName === ownerClassName)
    ) {
      features.push(e.description);
    }
  }
  for (const c of file.interfacePlan.classes) {
    if (c.name === entityName && ownerClassName === null) {
      features.push(c.description);
    }
  }
  return features;
}

function signatureFromAst(node: FunctionNode | MethodNode): string {
  // The AST nodes don't carry signature text directly; we reconstruct
  // a coarse signature from the node's own properties. For a detailed
  // view the agent should call get_interface_content.
  return `${node.name}(...)`;
}

function renderPlannedSignature(entry: {
  name: string;
  signature: { params: Array<{ name: string; type: string }>; returnType: string; isAsync: boolean };
}): string {
  const params = entry.signature.params
    .map((p) => `${p.name}: ${p.type}`)
    .join(", ");
  const asyncPrefix = entry.signature.isAsync ? "async " : "";
  return `${asyncPrefix}${entry.name}(${params}): ${entry.signature.returnType}`;
}

function extractFromContent(
  file: FileNode,
  node: ClassNode | FunctionNode | MethodNode,
): string {
  if (!file.content) return "";
  const start = node.byteRange.start;
  const end = node.byteRange.end;
  if (start < 0 || end > file.content.length || start >= end) return "";
  return file.content.slice(start, end);
}

/** Common English words we skip so they don't dominate score. */
const STOPLIST = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "this",
  "that",
  "into",
  "but",
  "not",
  "are",
  "was",
  "use",
  "uses",
  "used",
]);

/**
 * Tokenize for fuzzy search. Splits on non-alphanumerics (so
 * "user_name" → "user","name") AND on camelCase boundaries (so
 * "addTodo" → "add","todo"). Without the camelCase split the
 * search misses every AST-extracted hit by name only — review
 * fix #13.
 */
function tokenize(s: string): string[] {
  // First split camelCase: insert spaces between lower→upper and
  // between letter→digit. Then lowercase + split on non-alnum.
  const normalized = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return normalized
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPLIST.has(t));
}

/**
 * Length-normalized overlap: hits / sqrt(haystack token count).
 * Review fix #5: pure overlap let long descriptions dominate the
 * ranking purely by surface area. Square-root denominator reins in
 * runaway descriptions without over-penalizing short names.
 */
function scoreOverlap(haystack: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const tokens = tokenize(haystack);
  if (tokens.length === 0) return 0;
  const tokenSet = new Set(tokens);
  let hits = 0;
  for (const q of queryTokens) {
    if (tokenSet.has(q)) hits++;
  }
  if (hits === 0) return 0;
  return hits / Math.sqrt(tokens.length);
}

// Re-export RPGNode so callers don't need a second import for type
// narrowing when working with rpg.nodes results.
export type { RPGNode };
