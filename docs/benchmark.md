# Baseline vs. harness — TodoMVC core library

Apples-to-apples comparison of one-shot LLM output against the full
RPG-driven harness on the same project description. Same model
(GLM-5.1), same description, same target (TypeScript TodoMVC core,
no UI / DOM / persistence — pure data + operation layer).

The two drivers:

- `bin/baseline-todomvc.ts` — single chat call. System prompt asks
  for the whole repo as `{files: [{path, content}]}`. No iteration,
  no tests against the model's code. Materialize, install, run.
- `bin/build-todomvc.ts` — full pipeline. Phase 0 stack proposal
  → proposal → file structure → interfaces → refactor → per-leaf
  TDD with 5-round MV diagnostic + auto test-rewrite + env-fix +
  surgical edit tools → branch-level integration tests with §D.1
  localization seeded into blame.

Both run against the same `DESCRIPTION` block.

## Baseline (one-shot GLM-5.1)

Single LLM call took 445 s (~7.5 min). GLM produced a complete
project as a JSON blob; harness materialized it.

### Files emitted

```
demo/todomvc-baseline/
├── package.json     [12 lines]   — emitted as "package."; renamed by hand
├── tsconfig.json    [18 lines]   — emitted as "tsconfig."; renamed by hand
├── src/
│   ├── errors.ts          [17 lines]
│   ├── index.ts           [3 lines]   barrel re-export
│   ├── todo-store.ts      [126 lines]
│   └── types.ts           [11 lines]
└── tests/
    └── todo-store.test.ts [377 lines]
```

Total: 564 LOC across 7 files (after renaming the two extension-
truncated files; pre-rename, neither install nor test would run).

### Tests

`tests/todo-store.test.ts` carries **36 test cases** across 7
`describe` blocks:

- `TodoStore.addTodo` (7 tests): UUID format, whitespace trimming,
  empty/whitespace-only rejection, defensive copy, insertion order,
  unique ids
- `TodoStore.toggleTodo` (5): bidirectional flip, copy semantics,
  unknown-id error, sibling preservation
- `TodoStore.removeTodo` (4): present + absent + isolation +
  middle-of-list
- `TodoStore.editTodo` (7): text replacement, trimming, unknown-id,
  empty/whitespace rejection, completed flag preserved, copy semantics
- `TodoStore.clearCompleted` (4): count return, 0 paths, multiple
- `TodoStore query methods` (5): frozen array, filtering, length
  invariants, empty-store
- `TodoStore integration scenarios` (4): full lifecycle, bulk
  clear, post-removal access, instance isolation

All 36 tests **pass** (after the filename fix-up). The tests
genuinely exercise the surface — no pro-forma assertions; edge
cases are covered.

### Failure modes the baseline hit

- **Truncated extensions** on `package.json` and `tsconfig.json`
  (emitted as `package.` and `tsconfig.`). Caused the baseline
  driver's "no package.json detected; skipping install + test"
  fallback to fire. The harness's phase 0 doesn't have this
  failure mode — its `parsePackageJson` validates on a strict
  schema before write.
- No incremental progress: the user waits ~7.5 min for nothing,
  then everything appears at once. If GLM had timed out or
  returned bad JSON, no partial result would have been salvageable.
- No retry loop: any malformed JSON kills the run with `[fatal]
  response did not parse as { files: [{path, content}, ...] }`.

### Verdict

For a small, well-specified target like this, GLM-5.1 in one shot
is **surprisingly competent** — clean module split, real test
coverage, idiomatic TS. The baseline is a fair adversary, not a
strawman.

Where the harness has to differentiate is on:

1. Operational robustness (no truncated filenames, no
   all-or-nothing fail, recoverable errors)
2. Larger / more complex projects where one-shot context blows
3. Tests that actually run end-to-end without manual rename

## Harness (full RPG pipeline)

_TODO: fill in after the run lands. Currently in phase 6 (per-leaf
TDD) at ~15 min mark. Will update with:_

- _Total wall clock_
- _Per-phase breakdown (stack / proposal / structure / interfaces /
  refactor / implementor / integration)_
- _Files emitted, LOC, test count_
- _Test pass rate_
- _Recovery events (decompose, fresh_approach, test_rewrites,
  env_patches)_
- _Whether the final run passes vitest from a clean clone_

## Methodology notes

- Same model: `glm-5.1` configured as `defaultProvider` in
  `config.json`.
- Same description: see the `DESCRIPTION` constant in
  `bin/baseline-todomvc.ts` and `bin/build-todomvc.ts` (kept
  identical between the drivers).
- Same OS: macOS (sandbox-exec / bwrap not in this comparison;
  both runs are local-dev mode).
- Both runs: cold start, no caching of prior runs.
- Comparison fairness limit: GLM is non-deterministic. A second
  run of either driver could produce different numbers; the
  comparison captures one representative run per driver.
