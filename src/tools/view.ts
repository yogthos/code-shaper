/**
 * Read-only view tools, mirrors the paper's localization primitives
 * (Appendix D.1):
 *   - view_file_interface_feature_map(filePath)
 *   - get_interface_content(targetSpec)  — "file:Class.method" or
 *     "file:functionName" or "file:Class".
 *
 * Search-by-functionality and expand-leaf-node land in Phase 5 once
 * the architect has populated descriptions and feature paths. They
 * would key off `RPGNode.features`, which Phase 1+2 leave empty.
 */

import type { RPG } from "../rpg/types.js";
import { isClass, isFunction, isMethod } from "../rpg/types.js";
import { locateClass, locateFile, locateFunction, locateMethod } from "./locate.js";
import { fail, ok, type ToolResult } from "./types.js";

export interface InterfaceMapEntry {
  kind: "function" | "class" | "method";
  name: string;
  /** "ClassName" for class-owned methods; null otherwise. */
  ownerClass: string | null;
  /** Feature paths attached by the architect; empty if unset. */
  features: string[];
  /** Source-line bounds (1-based, inclusive). */
  lineRange: { start: number; end: number };
  /** True for top-level functions/classes the file exports. */
  exported?: boolean;
}

export interface InterfaceMap {
  filePath: string;
  language: string | null;
  imports: Array<{ name: string; source: string; isDefault: boolean }>;
  exports: string[];
  /** Top-level declarations in source order, with each class
   *  immediately followed by its methods (also in source order).
   *  Methods are *not* interleaved with sibling top-level functions
   *  even if their owning class appeared between them in source — the
   *  intent is "show me this class and its members as a unit." */
  entries: InterfaceMapEntry[];
}

export function viewFileInterfaceMap(
  rpg: RPG,
  filePath: string,
): ToolResult<InterfaceMap> {
  const fileResult = locateFile(rpg, filePath);
  if (!fileResult.ok) return fileResult;
  const file = fileResult.value;

  const entries: InterfaceMapEntry[] = [];
  for (const childId of file.children) {
    const child = rpg.nodes[childId];
    if (!child) continue;
    if (isFunction(child)) {
      entries.push({
        kind: "function",
        name: child.name,
        ownerClass: null,
        features: child.features,
        lineRange: child.lineRange,
        exported: child.exported,
      });
    } else if (isClass(child)) {
      entries.push({
        kind: "class",
        name: child.name,
        ownerClass: null,
        features: child.features,
        lineRange: child.lineRange,
      });
      for (const methodId of child.children) {
        const method = rpg.nodes[methodId];
        if (method && isMethod(method)) {
          entries.push({
            kind: "method",
            name: method.name,
            ownerClass: child.name,
            features: method.features,
            lineRange: method.lineRange,
          });
        }
      }
    }
  }

  return ok({
    filePath: file.path,
    language: file.language,
    imports: file.rawImports.map((i) => ({ ...i })),
    exports: [...file.exports],
    entries,
  });
}

export interface InterfaceContentRequest {
  filePath: string;
  /** Target specifier:
   *    - "name"           → top-level function or class. If both exist
   *      with the same name (TS merged declarations), the function
   *      wins by convention.
   *    - "Class.method"   → method on a class. The split is at the
   *      *first* dot; targets like "a.b.c" treat "a" as the class and
   *      "b.c" as the method, which will fail to locate. If you need
   *      nested class lookup, that's a Phase 5 expansion. */
  target: string;
}

export interface InterfaceContent {
  filePath: string;
  target: string;
  kind: "function" | "class" | "method";
  source: string;
  lineRange: { start: number; end: number };
}

export function getInterfaceContent(
  rpg: RPG,
  req: InterfaceContentRequest,
): ToolResult<InterfaceContent> {
  const fileResult = locateFile(rpg, req.filePath);
  if (!fileResult.ok) return fileResult;
  const file = fileResult.value;

  const dot = req.target.indexOf(".");
  if (dot >= 0) {
    const className = req.target.slice(0, dot);
    const methodName = req.target.slice(dot + 1);
    if (!className || !methodName) {
      return fail(
        "INVALID_REQUEST",
        `bad target "${req.target}" — expected "Class.method"`,
      );
    }
    const classResult = locateClass(rpg, file, className);
    if (!classResult.ok) return classResult;
    const methodResult = locateMethod(rpg, classResult.value, methodName);
    if (!methodResult.ok) return methodResult;
    const m = methodResult.value;
    return ok({
      filePath: file.path,
      target: req.target,
      kind: "method",
      source: file.content.slice(m.byteRange.start, m.byteRange.end),
      lineRange: m.lineRange,
    });
  }

  // Top-level lookup. Functions are tried first to handle the TS
  // merged-declaration pattern (`function Foo(){}` + `class Foo {}`)
  // — function wins by convention. Errors propagate as follows:
  //   - AMBIGUOUS_NAME on the function side: surface immediately. The
  //     caller asked for a name that has multiple definitions; we
  //     should not silently pretend it doesn't exist and try classes.
  //   - NODE_NOT_FOUND on the function side: try classes.
  //   - any other failure: surface.
  const fnResult = locateFunction(rpg, file, req.target);
  if (fnResult.ok) {
    const fn = fnResult.value;
    return ok({
      filePath: file.path,
      target: req.target,
      kind: "function",
      source: file.content.slice(fn.byteRange.start, fn.byteRange.end),
      lineRange: fn.lineRange,
    });
  }
  if (fnResult.error.code !== "NODE_NOT_FOUND") {
    return fnResult;
  }
  const classResult = locateClass(rpg, file, req.target);
  if (classResult.ok) {
    const cls = classResult.value;
    return ok({
      filePath: file.path,
      target: req.target,
      kind: "class",
      source: file.content.slice(cls.byteRange.start, cls.byteRange.end),
      lineRange: cls.lineRange,
    });
  }
  if (classResult.error.code !== "NODE_NOT_FOUND") {
    return classResult;
  }

  return fail(
    "NODE_NOT_FOUND",
    `no function or class "${req.target}" in ${file.path}`,
  );
}
