// Architect public surface.

// Phase 3 — proposal-level construction.
export {
  proposeFunctionalityGraph,
  parsePlanResponse,
} from "./proposal.js";
export type {
  ProposalInput,
  ProposalResult,
  ProjectPlan,
  PlanCapability,
} from "./proposal.js";

export {
  PROPOSAL_SYSTEM_PROMPT,
  buildProposalUserPrompt,
  summarizeExistingRPG,
} from "./prompts.js";
export type { ProposalPromptInput } from "./prompts.js";

// Phase 4 — file-structure encoding.
export {
  encodeFileStructure,
  parseStructureResponse,
} from "./structure.js";
export type {
  StructureInput,
  StructureResult,
  StructurePlan,
  StructureMapping,
} from "./structure.js";

export {
  STRUCTURE_SYSTEM_PROMPT,
  buildStructureUserPrompt,
  renderStructurePromptBody,
} from "./structure-prompts.js";
export type { StructurePromptInput } from "./structure-prompts.js";

// Phase 5 — interface design + data flow.
export {
  designInterfaces,
  parseInterfaceResponse,
} from "./interface.js";
export type {
  InterfaceInput,
  InterfaceResult,
  ParsedInterfacePlan,
} from "./interface.js";

export {
  INTERFACE_SYSTEM_PROMPT,
  buildInterfaceUserPrompt,
  renderInterfacePromptBody,
} from "./interface-prompts.js";
export type { InterfacePromptInput } from "./interface-prompts.js";

// Operation vocabulary — shared apply layer used by every architect
// stage that can mutate structure.
export {
  applyOperation,
  applyOperations,
} from "./operations.js";
export type {
  RPGOperation,
  ApplyResult,
  BatchResult,
  CreateFolderOp,
  CreateFileOp,
  DeleteFileOp,
  MoveFileOp,
  SplitFileOp,
  MergeFilesOp,
  ExtractBaseClassOp,
  ExtractUtilityOp,
  SetInterfacePlanOp,
  SetDataFlowOp,
} from "./operations.js";

// Refactor pass — conservative restructuring after Phase 5 (and on
// demand from Phase 6+ when implementation reveals planning gaps).
export { runRefactorPass, parseRefactorResponse } from "./refactor.js";
export type { RefactorInput, RefactorResult } from "./refactor.js";

export {
  REFACTOR_SYSTEM_PROMPT,
  buildRefactorUserPrompt,
  renderRefactorPromptBody,
} from "./refactor-prompts.js";
export type { RefactorPromptInput } from "./refactor-prompts.js";

// §D.1 localization tools — graph-guided exploration primitives.
export {
  viewFileInterfaceFeatureMap,
  getInterfaceContent,
  expandLeafNodeInfo,
  searchInterfaceByFunctionality,
} from "./localization-tools.js";
export type {
  FileInterfaceMap,
  InterfaceContent,
  LeafNodeExpansion,
  FunctionalitySearchResult,
} from "./localization-tools.js";

// §D.1 localization agent — multi-step tool-using loop with Terminate.
export { localize } from "./localization.js";
export type {
  LocalizationInput,
  LocalizationResult,
  LocatedInterface,
} from "./localization.js";

// Failure diagnosis — 5-round majority-vote routing for test failures.
export { diagnoseFailure } from "./diagnose-failure.js";
export type {
  FailureCategory,
  FailureDiagnosisInput,
  FailureDiagnosisResult,
} from "./diagnose-failure.js";

export {
  FAILURE_DIAGNOSIS_SYSTEM_PROMPT,
  buildFailureDiagnosisUserPrompt,
} from "./diagnose-failure-prompts.js";
export type { FailureDiagnosisPromptInput } from "./diagnose-failure-prompts.js";
