/**
 * Materialize an RPG to disk.
 *
 * Phase 1 contract: write each FileNode's `content` verbatim to its
 * `path` under `outDir`, creating the necessary folder structure. Empty
 * folders that exist purely as hierarchy spine but contain no files are
 * created too — they show up in the materialized tree.
 *
 * The Phase 2 AST tools will rewrite `FileNode.content` in place when
 * they edit AST nodes, so persistence stays a flat dump.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isFile, isFolder, walk, type RPG } from "./types.js";

export interface MaterializeReport {
  /** Repo-relative paths written. */
  files: string[];
  /** Repo-relative folder paths created. */
  folders: string[];
}

export async function materializeRPG(
  rpg: RPG,
  outDir: string,
): Promise<MaterializeReport> {
  const absRoot = path.resolve(outDir);
  await mkdir(absRoot, { recursive: true });
  const files: string[] = [];
  const folders: string[] = [];
  for (const node of walk(rpg)) {
    if (isFolder(node)) {
      if (node.path === "") continue; // root already exists
      const dir = path.join(absRoot, node.path);
      await mkdir(dir, { recursive: true });
      folders.push(node.path);
    } else if (isFile(node)) {
      const dest = path.join(absRoot, node.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, node.content, "utf-8");
      files.push(node.path);
    }
  }
  return { files, folders };
}
