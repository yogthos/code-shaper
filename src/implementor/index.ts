// Phase 6 implementor public surface.

export { renderTypeScriptFile } from "./render.js";
export type { RenderInput } from "./render.js";

export {
  createHarnessDir,
  extractJsonObject,
  leafToTestFilename,
  linkHostNodeModules,
  outcomeForLeaf,
  resolveNodeModulesSource,
  runTests,
} from "./test-harness.js";
export type {
  TestRunOptions,
  TestRunResult,
  LeafTestOutcome,
} from "./test-harness.js";

export {
  TEST_AUTHOR_SYSTEM_PROMPT,
  BODY_AUTHOR_SYSTEM_PROMPT,
  buildTestAuthorUserPrompt,
  buildBodyAuthorUserPrompt,
  stripCodeFences,
} from "./prompts.js";
export type {
  TestAuthorPromptInput,
  BodyAuthorPromptInput,
} from "./prompts.js";

export { implementLeaf } from "./leaf.js";
export type { LeafImplementInput, LeafImplementResult } from "./leaf.js";

export { buildImplementations, renderPlannedFiles } from "./orchestrator.js";
export type { BuildInput, BuildResult } from "./orchestrator.js";

export {
  decomposeStuckLeaf,
  MAX_DECOMPOSE_DEPTH,
} from "./decompose.js";
export type {
  DecomposeRequest,
  DecomposeDecision,
  DecomposeResult,
  SubLeafSpec,
} from "./decompose.js";

export {
  DECOMPOSE_SYSTEM_PROMPT,
  buildDecomposeUserPrompt,
} from "./decompose-prompts.js";
export type { DecomposePromptInput } from "./decompose-prompts.js";

// Stage C of feature #5 — env-fix tool author for `environment`
// diagnostic verdicts. Wraps the npm-mutation primitives as
// OpenAI tool calls; one call per author session.
export { applyEnvFixViaTools } from "./env-fix.js";
export type {
  EnvFixInput,
  EnvFixResult,
  EnvToolName,
} from "./env-fix.js";

// §D.2 surgical edit tools — scope-bounded source mutations.
export {
  editFunctionInFile,
  editWholeClassInFile,
  editMethodOfClassInFile,
  editImportsAndAssignmentsInFile,
} from "./edit-tools.js";
export type { EditResult } from "./edit-tools.js";

// Tool-using edit author — wraps the §D.2 tools as OpenAI function
// tools so the LLM can pick a scope and emit args structured rather
// than streaming prose.
export { editLeafViaTools } from "./edit-author.js";
export type {
  EditAuthorInput,
  EditAuthorResult,
  ToolName,
} from "./edit-author.js";

export { runIntegrationTests, MAX_INTEGRATION_ROUNDS } from "./integration.js";
export type { IntegrationInput, IntegrationResult } from "./integration.js";

export {
  INTEGRATION_TEST_AUTHOR_SYSTEM_PROMPT,
  INTEGRATION_BLAME_SYSTEM_PROMPT,
  buildIntegrationTestAuthorUserPrompt,
  buildIntegrationBlameUserPrompt,
  discoverBranches,
  renderBranchDataFlow,
} from "./integration-prompts.js";
export type {
  IntegrationTestAuthorInput,
  IntegrationBlameInput,
  DiscoveredBranch,
} from "./integration-prompts.js";

export {
  branchToTestFilename,
  outcomeForBranch,
} from "./test-harness.js";
