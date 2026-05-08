# code-graph-agent

Graph-driven code-generation harness implementing the [Repository Planning Graph (RPG)](2509.16198v6.md) approach: an explicit, structured plan in place of free-form natural-language planning, with TDD-per-leaf code generation, recursive decomposition when leaves get stuck, and branch-level integration testing across leaves.

Currently TypeScript-target only; the language-adapter layer is pluggable.

## What it does

Given a project description (greenfield or existing repo), the harness runs a fixed pipeline that produces working TypeScript with passing tests:

```
Phase 3 — Proposal              capability tree (what to build)
   ↓
Phase 4 — File structure        folders + files (where it lives)
   ↓
Phase 5 — Interfaces            signatures + dataflow (what each leaf does)
   ↓
Refactor pass                   conservative restructuring (extract base class,
                                extract utility, split, merge, rename, move)
   ↓
Phase 6 — Implementor           per-leaf TDD: tests authored, body authored,
                                vitest run, retry with prior failure as feedback;
                                topological build by dataflow + extends
   ↓
Phase 7a — Decompose recovery   when a leaf gets stuck: architect picks
                                `decompose` (split into single-responsibility
                                sub-leaves) or `fresh_approach` (different
                                strategy, same contract). Bounded by
                                MAX_DECOMPOSE_DEPTH=5
   ↓
Phase 7b — Integration tests    branch-level tests across multiple leaves;
                                failures route through architect blame
                                attribution → fresh_approach / decompose
                                recovery on the named leaf. Bounded by
                                MAX_INTEGRATION_ROUNDS=5
```

Every phase mutates an in-memory **Repository Planning Graph** (RPG): folders, files, classes, functions, methods, plus capability-level metadata, data-flow edges, and inheritance edges. Files on disk are an output of `materializeRPG`; the graph is the source of truth. AST extraction is via `tree-sitter`, edits operate on byte-precise ranges, and cross-file imports are resolved on every mutation.

## Project structure

```
src/
  config.ts                           env-var-interpolated JSON config loader
  llm/                                provider abstraction (OpenAI-compatible HTTP)
    types.ts                          LLMClient + ChatOptions
    openai-provider.ts                works with OpenAI, DeepSeek, GLM, OpenRouter, Ollama /v1
    factory.ts                        ProviderConfig → LLMClient
  rpg/                                Repository Planning Graph
    types.ts                          Folder/File/Class/Function/Method/Capability nodes; edges
    load.ts                           dir → RPG (uses tree-sitter via adapters)
    materialize.ts                    RPG → dir
    resolve.ts                        cross-file import + inheritance edges
    adapters/                         language adapters; TS + TSX shipped
  tools/                              AST-aware in-process tools
    edit.ts                           edit_function, edit_method, edit_whole_class, edit_imports
    view.ts                           view_file_interface_feature_map, get_interface_content
    locate.ts                         find AST nodes by name; ambiguity detection
    refresh.ts                        re-extract a file after a byte splice; cross-edge re-resolve
  architect/                          phases 3–5 + refactor + operation vocabulary
    proposal.ts                       Phase 3 — capability tree
    structure.ts                      Phase 4 — folders + files
    interface.ts                      Phase 5 — signatures + dataflow
    operations.ts                     RPGOperation union + apply layer with import maintenance
    refactor.ts                       Phase 5.5 — conservative restructuring orchestrator
  implementor/                        Phases 6 + 7
    render.ts                         pure: InterfacePlan + bodies → TypeScript source
    test-harness.ts                   spawn vitest with JSON reporter; per-leaf + per-branch glob
    validate-ts.ts                    tree-sitter validation for LLM-produced sources
    leaf.ts                           per-leaf TDD loop (test author → body author → run → retry)
    decompose.ts                      Phase 7a — split-or-fresh-approach recovery
    orchestrator.ts                   Phase 6 topological build with decompose recovery
    integration.ts                    Phase 7b — branch tests + blame attribution + recovery
tests/                                vitest suites — 25 files, 151 unit + 5 GLM integration
bin/
  smoke.ts                            manual provider check
config.json                           runtime configuration
```

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure a provider

`config.json` uses `${ENV_VAR}` interpolation:

```json
{
  "defaultProvider": "glm",
  "providers": {
    "glm": {
      "url": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
      "apiKey": "${ZHIPU_API_KEY}",
      "model": "glm-5.1",
      "options": { "temperature": 0.2, "timeout_ms": 600000 }
    }
  }
}
```

The OpenAI-compatible provider works with anything speaking `/chat/completions`: GLM (Zhipu), DeepSeek, OpenAI, OpenRouter, Together, Ollama via `/v1`, llama.cpp servers, etc. The `url` may include or omit `/chat/completions` — it's normalized either way.

### 3. Smoke-test the provider

```bash
npm run smoke
```

Expected output:
```
[smoke] provider=glm model=glm-5.1 url=...
[smoke] finish=stop took=Xms
[smoke] usage={"promptTokens":...}
---
pong
---
```

### 4. Run the test suite

```bash
# Unit tests only (fast, ~30s)
npm test -- --exclude '**/*.integration.test.ts'

# Including LLM-driven integration tests (~15-20 minutes)
npm test
```

## Programmatic use

```ts
import { emptyRPG } from "./src/rpg/index.js";
import { createClient } from "./src/llm/factory.js";
import { loadConfig } from "./src/config.js";
import {
  proposeFunctionalityGraph,
  encodeFileStructure,
  designInterfaces,
  runRefactorPass,
} from "./src/architect/index.js";
import {
  buildImplementations,
  runIntegrationTests,
  discoverBranches,
} from "./src/implementor/index.js";

const { value: config } = await loadConfig();
const client = createClient("glm", config.providers.glm!);

const rpg = emptyRPG();
const description = "Build a tiny TypeScript math-utilities library: clamp, lerp, mean.";

// Phases 3-5
await proposeFunctionalityGraph(client, rpg, { description });
await encodeFileStructure(client, rpg, { description });
await designInterfaces(client, rpg, { description });
await runRefactorPass(client, rpg, { description });

// Phase 6 — per-leaf TDD with topological build
const build = await buildImplementations(client, rpg, {
  outDir: "./out",
  preserveHarness: true,
});

if (build.ok && build.workDir) {
  // Phase 7b — branch-level integration tests
  const bodyByLeafId = new Map<string, string>();
  const testsByLeafId = new Map<string, string>();
  for (const lr of build.leafResults) {
    if (lr.ok) {
      bodyByLeafId.set(lr.leafId, lr.body);
      testsByLeafId.set(lr.leafId, lr.testSource);
    }
  }
  if (discoverBranches(rpg).length > 0) {
    await runIntegrationTests(client, rpg, {
      bodyByLeafId,
      testsByLeafId,
      workDir: build.workDir,
    });
  }
}
```

The architect supports an `extend` mode for working against an existing repo loaded via `loadRepo(rootDir)` — capabilities the architect proposes are integrated into existing structure rather than rebuilt from scratch.

## Operation vocabulary

Architect mutations all flow through a shared vocabulary in `src/architect/operations.ts`:

| Op | Use |
| --- | --- |
| `create_folder` / `create_file` | Phase 4 + extend mode |
| `move_file` (subsumes rename) | Refactor — updates every importer's specifier |
| `delete_file` | Refactor — refuses if anyone still imports the file |
| `split_file` | Refactor — partition members; class methods can't span destinations |
| `merge_files` | Refactor — concatenate plans, redirect imports |
| `extract_base_class` | Refactor — lift recurring class methods, set `extendsName` + `extendsFromFile` cross-file |
| `extract_utility` | Refactor — move recurring helper functions to a shared file |
| `set_interface_plan` / `set_data_flow` | Phase 5 + refactor |

Every op is idempotent where it can be (re-creating an existing folder is a no-op), surfaces typed conflicts loudly (deleting a file that's still imported, splitting a file across overlapping member partitions), and re-runs `resolveImportEdges` + `resolveInheritEdges` on every successful mutation so cross-file edges stay consistent.

## Recovery model

The user-facing principle is **no broken code in the build**. When a leaf can't be implemented, the orchestrator routes through architect-driven recovery:

1. **Body retry within Phase 6** — failure assertion fed back to the body author, up to `maxAttemptsPerLeaf`.
2. **Phase 7a decompose recovery** — when the per-leaf retry budget exhausts:
   - **`decompose`**: architect splits into 2–5 single-responsibility sub-leaves; each implements first; original leaf becomes an assembly composing them.
   - **`fresh_approach`**: architect identifies the leaf is doing one thing but the strategy is wrong; supplies a hint that's spliced into the next body-author prompt.
   - Bounded by `MAX_DECOMPOSE_DEPTH = 5`. At depth = MAX-1 the validator forces `fresh_approach`.
3. **Phase 7b integration recovery** — when a branch-level integration test fails:
   - Architect picks a single culprit leaf via blame attribution.
   - Routes through the same `fresh_approach` / `decompose` vocabulary.
   - Bounded by `MAX_INTEGRATION_ROUNDS = 5`.

Test contracts are immutable across body retries — the failing test stays the contract, the body changes. Test contracts CAN move during decompose (sub-leaves get their own tests; the original leaf's tests are preserved as the assembly contract).

## Test-author validation

LLMs occasionally emit prose-laced source code. The implementor validates every test-author response via tree-sitter; if it doesn't parse, the response is replayed back as the assistant turn with a corrective user message including the parse error. Default `maxTestAuthorAttempts = 3`.

This mattered: in the live e2e run (`npm test`) GLM hit at least one test-author parse failure for `lerp`'s test file (prose like "That should handle the edge case" leaked into the source). The retry recovered without intervention.

## Existing-project support

`loadRepo(rootDir)` parses an existing repo into an RPG (folders, files, classes, functions, methods, imports, exports, inheritance). Phase 3+4+5 in `mode: "extend"` accept this RPG and:

- Render existing structure into the architect prompts so it integrates with what's there
- Skip already-implemented leaves in Phase 5
- Reuse existing folders for new capabilities when names align
- Add new files only when capabilities don't fit in existing ones

The refactor pass can additionally rename, move, split, merge, or extract helpers across existing files. Imports are rewritten on every move so the repo stays compilable.

## Constraints + known limitations

| Item | Status |
| --- | --- |
| TypeScript output only | Pluggable `LanguageAdapter` ready; only TS shipped |
| `containerKind: "interface"` | Renderer always emits `class`; refactor outputs only `class` so far |
| Aliased `extends` imports | Renderer assumes `extendsName` matches the imported binding |
| Final cross-file test timeout | 300s default; bump `BuildInput.finalRunTimeoutMs` for larger projects |
| EpiCoder feature-tree retrieval | Skipped (paper §3.2's explore-exploit step); pure-LLM exploration on small targets |
| Token budget for large repos | `summarizeExistingRPG` and `renderStructurePromptBody` not yet truncated |

## Testing

```bash
npm test                                                # all
npm test -- --exclude '**/*.integration.test.ts'        # unit only
npm test -- tests/architect.proposal.test.ts            # one file
```

Test layout:
- `tests/*.test.ts` — unit tests with mocked LLM client
- `tests/*.integration.test.ts` — real-LLM integration tests (skipped automatically when no API key resolves)
- `tests/helpers/mock-implementor-client.ts` — shared mock LLM with role-aware dispatch
- `tests/fixtures/sample-repo/` — fixture repo for round-trip tests

Current count: 25 test files, 151 unit tests + 5 LLM-driven integration tests.

### CI

`.github/workflows/ci.yml` runs the typecheck + unit tests on every push and PR. The LLM-driven integration tests are gated behind `workflow_dispatch` with a `run_llm_integration: true` input — they're non-deterministic and consume real API credits, so opt in via:

1. **Settings → Secrets and variables → Actions** — add `ZHIPU_API_KEY` (or your provider's key + corresponding `config.json` adjustments).
2. **Actions → CI → Run workflow** — flip the `Run LLM-driven integration tests` toggle on before dispatching.

The integration job has `needs: unit` so it only runs after the unit suite passes.

## License

(Configure as needed — no license file shipped yet.)
