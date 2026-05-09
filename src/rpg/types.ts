/**
 * Repository Planning Graph (RPG) — schema.
 *
 * Models the paper's hierarchy: folder → file → class/function → method.
 * Every node carries enough metadata for round-trip persistence: where it
 * came from on disk and (for AST-derived nodes) the byte/line range
 * within its file. Files own raw source so materialize is a flat write.
 *
 * Edges:
 *   - contains: structural hierarchy (Folder→File, File→Class/Function,
 *     Class→Method).
 *   - imports: file-level import edges (file → resolved or unresolved
 *     module specifier; cross-references resolve later when both ends are
 *     known).
 *   - calls: caller (function/method) → callee name (resolved later).
 *   - inherits: class → class.
 *   - data_flow: typed I/O between subgraph roots. Populated by the
 *     architect in Phase 5; left empty by `loadRepo`.
 */

/** Stable, globally unique node id. */
export type NodeId = string;

export type NodeKind =
  | "folder"
  | "file"
  | "class"
  | "function"
  | "method"
  /** Architect-authored hierarchical capability — what to build, before
   *  file paths or signatures are assigned. Phase 4 promotes capability
   *  subtrees to folder/file structures. */
  | "capability";

/** Closed-open `[start, end)` range in the owning file's `content`.
 *
 *  Units are JavaScript string indices (UTF-16 code units) — what
 *  `String.prototype.slice` and `String.prototype.length` use, and what
 *  the native tree-sitter Node bindings hand back via
 *  `node.startIndex`/`endIndex`. The field name "byte" is a misnomer
 *  inherited from tree-sitter's underlying C API; for ASCII source
 *  bytes and code units coincide, so callers rarely notice. Slice
 *  arithmetic and adapter range emission must stay in the same unit
 *  system, which they do. */
export interface ByteRange {
  start: number;
  end: number;
}

/** 1-based, closed `[start, end]` line range in the owning file's source. */
export interface LineRange {
  start: number;
  end: number;
}

interface BaseNode {
  id: NodeId;
  kind: NodeKind;
  /** Display name. For folders/files, the basename; for classes/functions/
   *  methods, the declared identifier. */
  name: string;
  /** Parent node id, or null for the root folder. */
  parent: NodeId | null;
  /** Direct child node ids in declaration order. */
  children: NodeId[];
  /** Capability/feature path tags, e.g. ["data/loading"]. Architect-set;
   *  empty after `loadRepo`. */
  features: string[];
}

export interface FolderNode extends BaseNode {
  kind: "folder";
  /** Path relative to the repo root. "" for the root folder. */
  path: string;
}

export interface FileNode extends BaseNode {
  kind: "file";
  /** Path relative to the repo root. */
  path: string;
  /** Source code; the canonical content for materialize(). */
  content: string;
  /** Detected language id (e.g. "typescript"). null = unsupported. */
  language: string | null;
  /** Imports observed by the parser. Edges are derived from these in
   *  `RPG.imports`. Resolution to concrete file ids happens after every
   *  file is loaded (cross-file pass). */
  rawImports: RawImport[];
  /** Top-level export names. */
  exports: string[];
  /** Architect-authored plan for the interfaces this file should
   *  expose. Populated in Phase 5. Phase 6 (implementor) reads this to
   *  generate code; once code lands, the AST extractor populates real
   *  Function/Class/Method nodes alongside (the plan stays for
   *  traceability + tests). Undefined when the file pre-existed on
   *  disk or hasn't been planned yet. */
  interfacePlan?: InterfacePlan;
  /** Step U2: when the dev loop edits a file, the FULL post-edit
   *  source is stored here. The renderer returns it verbatim
   *  instead of regenerating from interfacePlan + bodyByLeafId.
   *  This persists model edits to NON-leaf scopes (class
   *  declarations without method leaves, top-level constants,
   *  etc.) which the regenerate model would otherwise wipe on
   *  the next render.
   *
   *  Cleared by the orchestrator only at scaffold time (when
   *  spawning a fresh project). Subsequent edits append; final
   *  materialize writes this verbatim. */
  userEditedSource?: string;
}

/** Per-file plan for the interfaces the implementor must produce.
 *
 *  Plans cover every leaf capability that resolves to this file.
 *  Functions are top-level; methods belong to a container declared in
 *  `classes`. The schema is paradigm-agnostic: `PlannedClass` is named
 *  for OO familiarity but, via `containerKind`, models any callable-
 *  bearing namespace — class, interface, Clojure protocol, Haskell
 *  type-class, Rust trait, OCaml module signature. Language adapters
 *  in Phase 6 emit the appropriate syntactic form. */
export interface InterfacePlan {
  /** One entry per leaf capability that lives in this file. */
  entries: PlannedInterface[];
  /** Classes / containers declared in this file. Methods reference
   *  them by `name` (case-sensitive). Empty when the file has only
   *  standalone functions / values. */
  classes: PlannedClass[];
}

/** Kind of callable container.
 *
 *  Naming convention: each language adapter chooses how to render. For
 *  TypeScript: `class` and `interface` are direct; `protocol` and
 *  `trait` map to abstract classes or interfaces; `record`/`struct`
 *  map to a class with a constructor or a TS `interface` plus factory.
 *  For Clojure: `protocol` is a defprotocol, `record` is a defrecord.
 *  For Haskell: `interface`/`protocol` map to `class`, `record` to
 *  `data` with named fields. */
export type ContainerKind =
  | "class"
  | "interface"
  | "protocol"
  | "record"
  | "struct"
  | "trait"
  | "module";

export interface PlannedSignature {
  params: Array<{
    name: string;
    type: string;
    optional?: boolean;
    defaultValue?: string;
  }>;
  returnType: string;
  isAsync: boolean;
}

export interface PlannedInterface {
  /** The leaf capability this interface implements. Each leaf maps to
   *  exactly one interface entry. */
  leafCapabilityId: NodeId;
  kind: "function" | "method";
  name: string;
  /** Required when `kind === "method"`; null otherwise. References a
   *  `PlannedClass.name` declared in the same file. */
  ownerClassName: string | null;
  signature: PlannedSignature;
  /** Plain-language description used to derive tests in Phase 6. */
  description: string;
  exported: boolean;
  isStatic: boolean;
}

export interface PlannedClass {
  name: string;
  /** Paradigm-agnostic container kind. Defaults to "class" when the
   *  architect doesn't specify one (TS, Python, Java conventions).
   *  Phase 6's language adapter consults this when rendering. */
  containerKind?: ContainerKind;
  description: string;
  /** When non-null, names the base container this class extends.
   *  Resolution rule: if `extendsFromFile` is null, the base must be
   *  declared in the same file's `InterfacePlan.classes`. Otherwise
   *  the base lives in `extendsFromFile`'s plan. The implementor adds
   *  an import of the base class into this file's source when
   *  `extendsFromFile` is set. */
  extendsName: string | null;
  /** File path of the base class. Null = within-file. Set by refactor
   *  ops (extract_base_class) and supported by language adapters in
   *  Phase 6 to emit cross-file imports. */
  extendsFromFile: string | null;
  exported: boolean;
}

export interface RawImport {
  /** Imported binding (the name visible in this file). */
  name: string;
  /** Module specifier as written in source (e.g. "./util", "node:path"). */
  source: string;
  /** Whether this came from a default-import clause. */
  isDefault: boolean;
}

interface AstNode extends BaseNode {
  /** File node id this AST node lives in. Always set for class/function/
   *  method. */
  file: NodeId;
  byteRange: ByteRange;
  lineRange: LineRange;
}

export interface ClassNode extends AstNode {
  kind: "class";
  /** Names of base classes the parser observed in `extends`. Resolved to
   *  ClassNode ids in `RPG.inherits`. */
  extendsNames: string[];
}

export interface FunctionNode extends AstNode {
  kind: "function";
  /** True for `export function` and `export const f = …` arrow forms. */
  exported: boolean;
}

export interface MethodNode extends AstNode {
  kind: "method";
  /** Class node id that owns this method. */
  ownerClass: NodeId;
  isStatic: boolean;
  /** Methods may contain nested function/class declarations in their
   *  body, but the Phase 1 extractor does not surface them — Phase 2
   *  edit tools rewrite whole methods, so intra-method structure is
   *  irrelevant at this layer. `children` is therefore always empty. */
}

/**
 * Architect-authored capability — a "what to build" node. Lives in the
 * RPG before any file structure is assigned.
 *
 * Phase 3 (proposal) populates a tree of these. Phase 4 (file
 * structure) promotes capability subtrees to folders/files by adding
 * a `path`. Phase 5 enriches leaves with signatures and data flow.
 *
 * Status transitions:
 *   "planned"  → after Phase 3
 *   "mapped"   → after Phase 4 — folder/file paths assigned to this
 *                 subtree, but the node itself is still a capability;
 *                 use `mappedToId` to find the folder/file id it
 *                 produced.
 */
export interface CapabilityNode extends BaseNode {
  kind: "capability";
  /** One-paragraph description of the capability. Drives prompts in
   *  Phase 4–6. */
  description: string;
  /** Leaf capabilities are atomic features the implementor turns into
   *  one or more functions/classes. Non-leaves are organizational. */
  isLeaf: boolean;
  status: "planned" | "mapped";
  /** Set in Phase 4 once this capability has been mapped to a folder
   *  or file in the same RPG. Null until then. */
  mappedToId: NodeId | null;
  /** How many decomposition rounds this capability has gone through.
   *  Architect-authored capabilities start at 0; sub-leaves born from
   *  a Phase 7a decompose carry their parent's depth + 1. The
   *  orchestrator caps recursion at `MAX_DECOMPOSE_DEPTH` so a
   *  pathologically stuck leaf can't blow up indefinitely. */
  decompositionDepth: number;
}

export type RPGNode =
  | FolderNode
  | FileNode
  | ClassNode
  | FunctionNode
  | MethodNode
  | CapabilityNode;

export interface ImportEdge {
  /** File node id where the import statement lives. */
  fromFile: NodeId;
  /** Resolved file node id, or null if the source is external/unresolved. */
  toFile: NodeId | null;
  /** Original specifier as written in source. */
  source: string;
  /** Imported binding name. */
  name: string;
}

export interface CallEdge {
  /** Function/method node id of the caller. */
  fromNode: NodeId;
  /** Bare callee name as observed in source. Resolution to a target node
   *  id is left to consumers (multiple targets may share a name). */
  calleeName: string;
}

export interface InheritsEdge {
  /** Subclass node id. */
  fromClass: NodeId;
  /** Base class node id, or null if the base couldn't be resolved within
   *  the repo (e.g. extends an external class). */
  toClass: NodeId | null;
  /** Name as written in source. */
  baseName: string;
}

export interface DataFlowEdge {
  /** Source subgraph-root node id. */
  fromNode: NodeId;
  /** Target subgraph-root node id. */
  toNode: NodeId;
  /** Type label, e.g. "ndarray<float, [N, D]>". */
  payload: string;
}

export interface RPG {
  /** All nodes by id. */
  nodes: Record<NodeId, RPGNode>;
  /** Id of the root FolderNode. */
  rootId: NodeId;
  imports: ImportEdge[];
  calls: CallEdge[];
  inherits: InheritsEdge[];
  dataFlow: DataFlowEdge[];
}

// ── Type guards / accessors ─────────────────────────────────────────

export function isFolder(node: RPGNode): node is FolderNode {
  return node.kind === "folder";
}

export function isFile(node: RPGNode): node is FileNode {
  return node.kind === "file";
}

export function isClass(node: RPGNode): node is ClassNode {
  return node.kind === "class";
}

export function isFunction(node: RPGNode): node is FunctionNode {
  return node.kind === "function";
}

export function isMethod(node: RPGNode): node is MethodNode {
  return node.kind === "method";
}

export function isCapability(node: RPGNode): node is CapabilityNode {
  return node.kind === "capability";
}

export function getNode(rpg: RPG, id: NodeId): RPGNode {
  const node = rpg.nodes[id];
  if (!node) throw new Error(`RPG: no node with id ${id}`);
  return node;
}

export function getFile(rpg: RPG, id: NodeId): FileNode {
  const node = getNode(rpg, id);
  if (!isFile(node)) throw new Error(`RPG: node ${id} is not a file`);
  return node;
}

export function getFolder(rpg: RPG, id: NodeId): FolderNode {
  const node = getNode(rpg, id);
  if (!isFolder(node)) throw new Error(`RPG: node ${id} is not a folder`);
  return node;
}

/** Iterate every node in declaration order (depth-first from root). */
export function* walk(rpg: RPG, startId: NodeId = rpg.rootId): Generator<RPGNode> {
  const node = getNode(rpg, startId);
  yield node;
  for (const child of node.children) {
    yield* walk(rpg, child);
  }
}

/** Empty RPG with a root folder.
 *
 *  The root id is the literal string `"folder:"` (no path component).
 *  Every other folder follows the `folder:<rel>` scheme where `<rel>`
 *  is the repo-relative path. Treat the empty-suffix form as the
 *  reserved sentinel for the repo root. */
export function emptyRPG(): RPG {
  const rootId: NodeId = "folder:";
  const root: FolderNode = {
    id: rootId,
    kind: "folder",
    name: "",
    parent: null,
    children: [],
    features: [],
    path: "",
  };
  return {
    nodes: { [rootId]: root },
    rootId,
    imports: [],
    calls: [],
    inherits: [],
    dataFlow: [],
  };
}
