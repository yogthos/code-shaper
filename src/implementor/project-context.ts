/**
 * Static project digest passed into every leaf's dev-loop user
 * prompt. The harness already has all of this — package.json (on
 * disk in outDir) + the RPG (folders, files, planned interfaces).
 * Synthesizing it once and shipping it with the prompt saves each
 * leaf from re-discovering the project shape with list_files /
 * read_file / read package.json round-trips.
 *
 * Two pieces:
 *  1. Static digest: stack, scripts, deps, layout, planned exports.
 *     Built once after Phase 5 (interfaces) so it captures all
 *     planned files + their planned exports.
 *  2. Learned facts: orchestrator-owned accumulator. Each entry is
 *     a one-line lesson extracted from a failed leaf's trail
 *     (e.g. "package X failed to install — use Y instead"). Grows
 *     across leaves so subsequent workers don't repeat the same
 *     mistake.
 */

import { readFileSync, existsSync } from "node:fs";
import nodePath from "node:path";

import type { FileNode, FolderNode, RPG } from "../rpg/types.js";

export interface BuildProjectContextInput {
  rpg: RPG;
  /** Project dir on disk; when present, package.json is read for
   *  scripts + deps. */
  outDir?: string;
  /** Accumulated lessons learned from prior leaf attempts in this
   *  build. Pass [] on the first leaf. */
  learnedFacts?: string[];
}

export function buildProjectContext(input: BuildProjectContextInput): string {
  const { rpg, outDir } = input;
  const lines: string[] = [];
  lines.push("# Project context");
  lines.push("");

  const pkg = readPackageJson(outDir);
  if (pkg !== null) {
    lines.push("## Stack");
    if (pkg.type) lines.push(`- Module type: ${pkg.type}`);
    const scripts = pkg.scripts ?? {};
    if (scripts.test) lines.push(`- Test command: \`npm test\` → \`${scripts.test}\``);
    if (scripts.build) lines.push(`- Build command: \`npm run build\` → \`${scripts.build}\``);
    const deps = Object.entries(pkg.dependencies ?? {});
    const devDeps = Object.entries(pkg.devDependencies ?? {});
    if (deps.length > 0) {
      lines.push(
        `- Runtime deps: ${deps.map(([n, v]) => `${n}@${v}`).join(", ")}`,
      );
    }
    if (devDeps.length > 0) {
      lines.push(
        `- Dev deps: ${devDeps.map(([n, v]) => `${n}@${v}`).join(", ")}`,
      );
    }
    lines.push("");
  }

  const layout = describeLayout(rpg);
  if (layout.length > 0) {
    lines.push("## Layout");
    for (const l of layout) lines.push(`- ${l}`);
    lines.push("");
  }

  const filesByFolder = groupFilesByFolder(rpg);
  if (filesByFolder.size > 0) {
    lines.push("## Files (planned exports)");
    const folderNames = Array.from(filesByFolder.keys()).sort();
    for (const folderPath of folderNames) {
      const files = filesByFolder.get(folderPath)!;
      for (const f of files) {
        const exports = describePlannedExports(f);
        if (exports.length === 0) {
          lines.push(`- ${f.path}`);
        } else {
          lines.push(`- ${f.path}: ${exports.join(", ")}`);
        }
      }
    }
    lines.push("");
  }

  const facts = (input.learnedFacts ?? []).filter(
    (s) => typeof s === "string" && s.trim().length > 0,
  );
  if (facts.length > 0) {
    lines.push("## Known constraints (learned during this build)");
    for (const f of facts) lines.push(`- ${f}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

interface PackageJsonShape {
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(outDir: string | undefined): PackageJsonShape | null {
  if (!outDir) return null;
  const p = nodePath.join(outDir, "package.json");
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as PackageJsonShape;
  } catch {
    return null;
  }
}

function describeLayout(rpg: RPG): string[] {
  const folderCounts = new Map<string, number>();
  for (const node of Object.values(rpg.nodes)) {
    if (node.kind !== "file") continue;
    const file = node as FileNode;
    const top = file.path.split("/")[0] ?? "";
    if (!top) continue;
    folderCounts.set(top, (folderCounts.get(top) ?? 0) + 1);
  }
  const out: string[] = [];
  const tops = Array.from(folderCounts.keys()).sort();
  for (const t of tops) {
    out.push(`${t}/ — ${folderCounts.get(t)} file(s)`);
  }
  return out;
}

function groupFilesByFolder(rpg: RPG): Map<string, FileNode[]> {
  const out = new Map<string, FileNode[]>();
  for (const node of Object.values(rpg.nodes)) {
    if (node.kind !== "file") continue;
    const file = node as FileNode;
    const parent = file.parent ? rpg.nodes[file.parent] : null;
    const folderPath =
      parent && parent.kind === "folder" ? (parent as FolderNode).path : "";
    const list = out.get(folderPath) ?? [];
    list.push(file);
    out.set(folderPath, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.path.localeCompare(b.path));
  }
  return out;
}

function describePlannedExports(file: FileNode): string[] {
  const plan = file.interfacePlan;
  if (!plan) return [];
  const out: string[] = [];
  // Classes first.
  for (const cls of plan.classes ?? []) {
    out.push(`class ${cls.name}`);
  }
  // Standalone functions; methods are grouped under their class.
  const seenClass = new Set((plan.classes ?? []).map((c) => c.name));
  for (const e of plan.entries ?? []) {
    if (e.kind === "method" && e.ownerClassName) {
      // Already covered by `class X`; skip individual methods to
      // keep the digest compact.
      if (seenClass.has(e.ownerClassName)) continue;
      out.push(`${e.ownerClassName}.${e.name}()`);
    } else if (e.kind === "function") {
      out.push(`${e.name}()`);
    }
  }
  return out;
}

/**
 * Inspect a failed leaf's trail and extract a one-line lesson when
 * the failure looks cross-cutting (something subsequent leaves
 * should know about).
 *
 * Returns null when nothing learnable was found. Returned strings
 * are short and self-contained — they get appended to
 * `learnedFacts` and rendered in every subsequent leaf's prompt
 * under "Known constraints".
 */
export interface TrailEntryLite {
  tool: string;
  args?: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export function extractLessonFromTrail(
  trail: readonly TrailEntryLite[],
): string | null {
  for (const t of trail) {
    if (t.ok) continue;
    const err = (t.error ?? "").toLowerCase();
    // Native-build / postinstall failures from add_dependency.
    if (
      t.tool === "add_dependency" &&
      (err.includes("npm install exited") ||
        err.includes("gyp") ||
        err.includes("node-gyp") ||
        err.includes("postinstall"))
    ) {
      const name = typeof t.args?.["name"] === "string" ? (t.args!["name"] as string) : null;
      if (name) {
        return `Package "${name}" fails to install in this environment (native build / postinstall error). Avoid adding it; pick a pure-JS alternative.`;
      }
    }
  }
  return null;
}
