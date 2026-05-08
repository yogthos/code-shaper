/**
 * Locate AST nodes by file + symbolic name. Lookup is case-sensitive
 * and prefers exact matches; ambiguous lookups (two functions with the
 * same name in the same file — possible after a botched edit) return
 * an `AMBIGUOUS_NAME` error so the caller can disambiguate by line.
 */

import type {
  ClassNode,
  FileNode,
  FunctionNode,
  MethodNode,
  RPG,
} from "../rpg/types.js";
import { isClass, isFile, isFunction, isMethod } from "../rpg/types.js";
import { fail, ok, type ToolResult } from "./types.js";

export function locateFile(rpg: RPG, filePath: string): ToolResult<FileNode> {
  for (const node of Object.values(rpg.nodes)) {
    if (isFile(node) && node.path === filePath) return ok(node);
  }
  return fail("FILE_NOT_FOUND", `no file in RPG at path: ${filePath}`);
}

export function locateFunction(
  rpg: RPG,
  file: FileNode,
  name: string,
): ToolResult<FunctionNode> {
  const matches: FunctionNode[] = [];
  for (const childId of file.children) {
    const child = rpg.nodes[childId];
    if (child && isFunction(child) && child.name === name) {
      matches.push(child);
    }
  }
  if (matches.length === 0) {
    return fail(
      "NODE_NOT_FOUND",
      `no function "${name}" in ${file.path}`,
    );
  }
  if (matches.length > 1) {
    const lines = matches.map((m) => m.lineRange.start).join(", ");
    return fail(
      "AMBIGUOUS_NAME",
      `multiple functions named "${name}" in ${file.path} at lines ${lines}`,
    );
  }
  return ok(matches[0]!);
}

export function locateClass(
  rpg: RPG,
  file: FileNode,
  name: string,
): ToolResult<ClassNode> {
  const matches: ClassNode[] = [];
  for (const childId of file.children) {
    const child = rpg.nodes[childId];
    if (child && isClass(child) && child.name === name) {
      matches.push(child);
    }
  }
  if (matches.length === 0) {
    return fail(
      "NODE_NOT_FOUND",
      `no class "${name}" in ${file.path}`,
    );
  }
  if (matches.length > 1) {
    const lines = matches.map((m) => m.lineRange.start).join(", ");
    return fail(
      "AMBIGUOUS_NAME",
      `multiple classes named "${name}" in ${file.path} at lines ${lines}`,
    );
  }
  return ok(matches[0]!);
}

export function locateMethod(
  rpg: RPG,
  cls: ClassNode,
  methodName: string,
): ToolResult<MethodNode> {
  const matches: MethodNode[] = [];
  for (const childId of cls.children) {
    const child = rpg.nodes[childId];
    if (child && isMethod(child) && child.name === methodName) {
      matches.push(child);
    }
  }
  if (matches.length === 0) {
    return fail(
      "NODE_NOT_FOUND",
      `no method "${methodName}" on class "${cls.name}"`,
    );
  }
  if (matches.length > 1) {
    const lines = matches.map((m) => m.lineRange.start).join(", ");
    return fail(
      "AMBIGUOUS_NAME",
      `multiple methods named "${methodName}" on class "${cls.name}" at lines ${lines}`,
    );
  }
  return ok(matches[0]!);
}
