/**
 * Shared types for in-process AST tools.
 *
 * Every tool returns a discriminated `ToolResult` so callers can handle
 * the failure path uniformly. Edits also report which nodes changed
 * (mirrors what an MCP wrapper will eventually surface as structured
 * tool output). All edits are mutations on the RPG passed in — there is
 * no copy. Callers wanting a sandbox should snapshot first.
 */

import type { ByteRange, NodeId } from "../rpg/types.js";

export type ToolResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ToolError };

export interface ToolError {
  /** Stable error code for tool callers. */
  code:
    | "FILE_NOT_FOUND"
    | "NODE_NOT_FOUND"
    | "AMBIGUOUS_NAME"
    | "PARSE_ERROR"
    | "INVALID_REQUEST"
    | "UNSUPPORTED_LANGUAGE";
  message: string;
}

export interface EditApplied {
  filePath: string;
  /** Byte range of the replacement in the post-edit file. */
  newRange: ByteRange;
  /** Node ids removed by the edit (old AST nodes for this file). */
  removed: NodeId[];
  /** Node ids added by the edit (fresh AST nodes for this file). */
  added: NodeId[];
}

export function ok<T>(value: T): ToolResult<T> {
  return { ok: true, value };
}

export function fail<T>(code: ToolError["code"], message: string): ToolResult<T> {
  return { ok: false, error: { code, message } };
}
