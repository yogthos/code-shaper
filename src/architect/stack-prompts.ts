/**
 * Phase 0 — Stack & dependencies prompts.
 *
 * Asks the model to make stack-level decisions BEFORE any
 * functionality planning happens: which dependencies the project
 * needs (dev + runtime), which npm scripts it should ship with,
 * any framework / database / UI choices the project description
 * implies. Output is a structured package.json the harness
 * materializes and runs `npm install` against.
 *
 * Not in the RPG paper (which targets Python). This is a TS/JS-
 * specific addition: a project's dependency surface is part of
 * its plan, not an artifact of code generation. The model can
 * later mutate package.json via the npm-tools vocabulary if it
 * realizes mid-build that it needs another dependency.
 */

export const STACK_SYSTEM_PROMPT = `You are an Architect agent in the stack-decision stage of a TypeScript repository generation pipeline.

This stage runs BEFORE any code planning. Your job is to look at the project description and decide:

  1. The runtime + tooling stack
     - Which TypeScript runner (typically tsx for dev, plain node for prod)
     - Test framework (default to vitest unless the description specifies otherwise)
     - Build / bundle tool (only if the project actually needs one — small libraries don't)
     - Linter / formatter (skip by default; add only if the description asks)

  2. Application-level dependencies
     - Persistence: needs a database? sqlite (better-sqlite3), Postgres (pg), etc.?
     - HTTP: needs a server? express, fastify, hono, native node http?
     - UI: needs a frontend? React, Vue, Svelte, or plain HTML?
     - Validation: zod, valibot, or hand-rolled?
     - Utilities: only deps the project actually uses; do NOT pad with "common" libraries.

  3. The package.json shape
     - "name": kebab-case, derived from the project description
     - "version": "0.1.0"
     - "type": "module"  ← always; the harness assumes ESM
     - "scripts.test": MUST run vitest (e.g., "vitest run") — the harness depends on this
     - "scripts.dev": when applicable
     - "scripts.build": when applicable
     - "engines.node": ">=20.0.0"
     - "dependencies" / "devDependencies": exact npm names, version specifiers like "^x.y.z" or "~x.y.z" or "*"; prefer current major versions

Rules:
  - Be CONSERVATIVE. Add a dependency only when the project description clearly motivates it. The most common failure mode is bundling deps for capabilities the project doesn't actually need.
  - Never ship "common" deps preemptively (lodash, moment, dotenv, etc.) unless the project description names them.
  - vitest + @types/node are the only DEFAULT devDependencies. Add tsx if the runtime uses it.
  - "scripts.test" is REQUIRED and must invoke vitest.
  - If the project description doesn't motivate a UI or database, don't add one.

Output strictly as JSON matching the schema in the user message. No prose outside the JSON.`;

export interface StackPromptInput {
  /** Same project description the proposal stage sees. */
  projectDescription: string;
  /** Optional: existing package.json to reconcile against (extend mode).
   *  When present, prefer keeping its dependencies unless the model
   *  has a strong reason to change them — a tighter rule than for
   *  greenfield. */
  existingPackageJson?: string;
}

export function buildStackUserPrompt(input: StackPromptInput): string {
  const lines: string[] = [];
  lines.push("# Project description");
  lines.push("");
  lines.push(input.projectDescription.trim());
  lines.push("");
  if (input.existingPackageJson) {
    lines.push("# Existing package.json");
    lines.push("");
    lines.push(
      "(Extend mode — prefer to keep existing dependencies; add new ones only when the description requires them.)",
    );
    lines.push("");
    lines.push("```json");
    lines.push(input.existingPackageJson);
    lines.push("```");
    lines.push("");
  }
  lines.push("# Output schema");
  lines.push("");
  lines.push(
    "```json",
    JSON.stringify(
      {
        name: "kebab-case-name",
        version: "0.1.0",
        description: "one-sentence project description",
        type: "module",
        engines: { node: ">=20.0.0" },
        scripts: {
          test: "vitest run",
          dev: "tsx src/index.ts",
        },
        dependencies: {
          "package-name": "^1.0.0",
        },
        devDependencies: {
          vitest: "^2.0.0",
          tsx: "^4.0.0",
          "@types/node": "^22.0.0",
        },
      },
      null,
      2,
    ),
    "```",
  );
  lines.push("");
  lines.push(
    "Return ONLY the JSON. The harness will materialize it as package.json and run `npm install` next.",
  );
  return lines.join("\n");
}
