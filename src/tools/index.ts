// Public surface for in-process AST tools.
//
// Phase 2 ships four edit primitives + two view primitives. The names
// match the paper's tool roster (Appendix D.1, D.2). When the MCP
// transport lands these same functions get wrapped — they're already
// JSON-shaped (single object in, ToolResult out).

export {
  editFunctionInFile,
  editMethodOfClassInFile,
  editWholeClassInFile,
  editImportsAndAssignmentsInFile,
} from "./edit.js";
export type {
  EditFunctionRequest,
  EditMethodRequest,
  EditClassRequest,
  EditImportsRequest,
} from "./edit.js";

export { viewFileInterfaceMap, getInterfaceContent } from "./view.js";
export type {
  InterfaceMap,
  InterfaceMapEntry,
  InterfaceContent,
  InterfaceContentRequest,
} from "./view.js";

export { refreshFile } from "./refresh.js";
export type { RefreshResult, RefreshStatus } from "./refresh.js";

export type { ToolResult, ToolError, EditApplied } from "./types.js";
