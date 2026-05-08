/**
 * Language adapter contract.
 *
 * One adapter per language. The adapter knows how to parse a source
 * file and extract the AST-level nodes the RPG cares about. Adding a
 * new language is: implement this interface, register it.
 *
 * The contract is deliberately narrow — adapters do NOT touch:
 *   - file I/O (the loader does that)
 *   - cross-file resolution (the loader runs a separate resolution pass)
 *   - features / data flow (the architect populates those later)
 *
 * They produce strictly per-file structural facts.
 */

import type {
  ClassNode,
  FunctionNode,
  MethodNode,
  NodeId,
  RawImport,
} from "../types.js";

export interface ExtractedFile {
  /**
   * Top-level definitions in **source order**. Loaders use this ordering
   * to populate `FileNode.children` so subsequent edit tools and data-
   * flow analyses see the same sequence as the source.
   */
  topLevel: Array<ClassNode | FunctionNode>;
  /** Methods owned by classes in `topLevel`. Adapters are responsible
   *  for appending each method id to its owning class's `children`
   *  array; the loader only ensures every method is reachable from the
   *  global node map. */
  methods: MethodNode[];
  imports: RawImport[];
  /** Names declared in this file that are exported. */
  exports: string[];
  /** Soft signals worth surfacing to the loader — currently used to
   *  report parse errors. The loader forwards these to its `onWarning`
   *  callback. */
  warnings?: ExtractWarning[];
}

export interface ExtractWarning {
  kind: "parse-error";
  message: string;
}

export interface LanguageAdapter {
  /** Identifier for diagnostics, e.g. "typescript". */
  language: string;
  /** Extensions this adapter handles, lowercased, including the dot.
   *  E.g. [".ts", ".tsx"]. */
  extensions: string[];
  /**
   * Parse + extract per-file structural facts. The adapter assigns ids
   * to AST nodes; ids must be globally unique. The recommended scheme
   * is `${kind}:${fileId}#${name}@${line}` so the same name at a
   * different line collides predictably (overloads / re-declarations).
   */
  extract(args: {
    fileId: NodeId;
    filePath: string;
    source: string;
  }): ExtractedFile;
}
