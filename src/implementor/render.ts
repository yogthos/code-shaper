/**
 * TS source renderer.
 *
 * Pure function (no LLM, no I/O) that turns a `FileNode`'s
 * `interfacePlan` + a per-leaf body map into TypeScript source code.
 * Used by the test harness on every dispatch (so tests run against the
 * latest in-progress code) and by the final materialize pass.
 *
 * Stubbing: leaves without an entry in `bodyByLeafId` render with
 * `throw new Error("<name> not implemented")`. The file always
 * compiles, which lets vitest run with deterministic timing — a leaf
 * that hasn't been tackled yet just fails its own test, not the whole
 * file.
 *
 * Imports:
 *   - File-level `rawImports` are emitted verbatim (the architect /
 *     refactor pass owns them).
 *   - Cross-file extends (`extendsFromFile`) are translated into
 *     additional imports of the base class.
 *
 * Phase 6 MVP only handles TypeScript. Other language adapters get
 * their own renderers in Phase 6+ when those targets land.
 */

import path from "node:path";

import type {
  FileNode,
  InterfacePlan,
  PlannedClass,
  PlannedInterface,
  PlannedSignature,
  RPG,
} from "../rpg/types.js";

export interface RenderInput {
  /** The file to render. Its `interfacePlan` field drives output. */
  file: FileNode;
  /** Per-leaf body source (function/method body, NOT including
   *  signature or braces). Missing entries render as throwing stubs. */
  bodyByLeafId: Map<string, string>;
  /** The full RPG — used to compute relative-import specifiers for
   *  cross-file `extendsFromFile` references. */
  rpg: RPG;
}

export function renderTypeScriptFile(input: RenderInput): string {
  const { file } = input;
  const plan = file.interfacePlan ?? { entries: [], classes: [] };
  const importLines = renderImports(file, plan);
  const blocks: string[] = [];

  // Order: classes first (with their methods), then standalone
  // functions. Within each class, methods follow architect order.
  const methodsByClass = new Map<string, PlannedInterface[]>();
  const standaloneFns: PlannedInterface[] = [];
  for (const entry of plan.entries) {
    if (entry.kind === "method" && entry.ownerClassName) {
      const list = methodsByClass.get(entry.ownerClassName) ?? [];
      list.push(entry);
      methodsByClass.set(entry.ownerClassName, list);
    } else if (entry.kind === "function") {
      standaloneFns.push(entry);
    }
  }

  for (const cls of plan.classes) {
    blocks.push(renderClass(cls, methodsByClass.get(cls.name) ?? [], input.bodyByLeafId));
  }
  for (const fn of standaloneFns) {
    blocks.push(renderFunction(fn, input.bodyByLeafId));
  }

  const importBlock = importLines.length > 0 ? importLines.join("\n") + "\n\n" : "";
  return importBlock + blocks.join("\n\n") + "\n";
}

function renderImports(file: FileNode, plan: InterfacePlan): string[] {
  // KNOWN LIMITATION: imports are re-grouped by source and emitted in
  // alphabetical order (side-effects first, then defaults+named).
  // Files with deliberate import ordering (polyfill before app code,
  // for example) lose that ordering — the side-effect-first emission
  // covers the common polyfill case. Add per-import ordering metadata
  // if a real consumer needs it.
  const lines: string[] = [];
  const namedBySource = new Map<string, Set<string>>();
  const defaultBySource = new Map<string, string>();
  const sideEffects = new Set<string>();

  for (const imp of file.rawImports) {
    if (imp.name === "") {
      sideEffects.add(imp.source);
      continue;
    }
    if (imp.isDefault) {
      defaultBySource.set(imp.source, imp.name);
      continue;
    }
    const set = namedBySource.get(imp.source) ?? new Set<string>();
    set.add(imp.name);
    namedBySource.set(imp.source, set);
  }

  // Cross-file extends: ensure the base class is imported. The
  // architect's apply layer has already pushed a rawImport for it,
  // so this pass is mostly a safety net for plans whose imports
  // weren't refreshed.
  for (const cls of plan.classes) {
    if (cls.extendsName !== null && cls.extendsFromFile !== null) {
      const source = relativeImport(file.path, cls.extendsFromFile);
      const set = namedBySource.get(source) ?? new Set<string>();
      set.add(cls.extendsName);
      namedBySource.set(source, set);
    }
  }

  // Render in stable order: side-effects, defaults, named.
  for (const src of [...sideEffects].sort()) {
    lines.push(`import "${src}";`);
  }
  const allSources = new Set<string>([
    ...defaultBySource.keys(),
    ...namedBySource.keys(),
  ]);
  for (const src of [...allSources].sort()) {
    const def = defaultBySource.get(src);
    const named = namedBySource.get(src);
    const namedList = named ? [...named].sort().join(", ") : "";
    if (def && named) {
      lines.push(`import ${def}, { ${namedList} } from "${src}";`);
    } else if (def) {
      lines.push(`import ${def} from "${src}";`);
    } else if (named) {
      lines.push(`import { ${namedList} } from "${src}";`);
    }
  }
  return lines;
}

function renderClass(
  cls: PlannedClass,
  methods: PlannedInterface[],
  bodyByLeafId: Map<string, string>,
): string {
  // KNOWN LIMITATIONS:
  //   - `containerKind` is ignored; output is always `class`. Plans
  //     with kind `interface` / `protocol` / `trait` render as
  //     classes with method bodies — compiles in TS but is
  //     semantically wrong. Honoring kind needs a per-language
  //     adapter; tracked for when a non-OO target lands.
  //   - `extendsName` is emitted verbatim. If the host file imports
  //     the base under an alias (`import { Base as B } from …`), the
  //     rendered `extends Base` would refer to a missing binding.
  //     Our pipeline never produces aliased imports today; revisit
  //     when it does.
  const exportPrefix = cls.exported ? "export " : "";
  const extendsClause =
    cls.extendsName !== null ? ` extends ${cls.extendsName}` : "";
  const lines: string[] = [];
  if (cls.description.trim().length > 0) {
    lines.push(renderDocBlock(cls.description));
  }
  lines.push(`${exportPrefix}class ${cls.name}${extendsClause} {`);
  for (let i = 0; i < methods.length; i++) {
    if (i > 0) lines.push("");
    lines.push(renderMethod(methods[i]!, bodyByLeafId));
  }
  lines.push(`}`);
  return lines.join("\n");
}

function renderMethod(
  method: PlannedInterface,
  bodyByLeafId: Map<string, string>,
): string {
  const indent = "  ";
  const staticPrefix = method.isStatic ? "static " : "";
  const asyncPrefix = method.signature.isAsync ? "async " : "";
  const params = renderParams(method.signature.params);
  const ret = method.signature.returnType;
  const body = bodyByLeafId.get(method.leafCapabilityId);
  const bodyText = body ?? stubBody(method.name);
  const lines: string[] = [];
  if (method.description.trim().length > 0) {
    lines.push(indentText(renderDocBlock(method.description), indent));
  }
  lines.push(
    `${indent}${staticPrefix}${asyncPrefix}${method.name}(${params}): ${ret} {`,
  );
  lines.push(indentText(bodyText, indent + "  "));
  lines.push(`${indent}}`);
  return lines.join("\n");
}

function renderFunction(
  fn: PlannedInterface,
  bodyByLeafId: Map<string, string>,
): string {
  const exportPrefix = fn.exported ? "export " : "";
  const asyncPrefix = fn.signature.isAsync ? "async " : "";
  const params = renderParams(fn.signature.params);
  const ret = fn.signature.returnType;
  const body = bodyByLeafId.get(fn.leafCapabilityId);
  const bodyText = body ?? stubBody(fn.name);
  const lines: string[] = [];
  if (fn.description.trim().length > 0) {
    lines.push(renderDocBlock(fn.description));
  }
  lines.push(
    `${exportPrefix}${asyncPrefix}function ${fn.name}(${params}): ${ret} {`,
  );
  lines.push(indentText(bodyText, "  "));
  lines.push(`}`);
  return lines.join("\n");
}

function renderParams(params: PlannedSignature["params"]): string {
  return params
    .map((p) => {
      const opt = p.optional ? "?" : "";
      const def =
        p.defaultValue !== undefined && !p.optional
          ? ` = ${p.defaultValue}`
          : "";
      return `${p.name}${opt}: ${p.type}${def}`;
    })
    .join(", ");
}

function renderDocBlock(description: string): string {
  const trimmed = description.trim();
  // Single-line wrapper adds 7 chars (`/** ` + ` */`). Stay under 80
  // total — accounting for the wrapper, the body limit is 73.
  const SINGLE_LINE_BODY_LIMIT = 80 - "/** ".length - " */".length;
  if (!trimmed.includes("\n") && trimmed.length <= SINGLE_LINE_BODY_LIMIT) {
    return `/** ${trimmed} */`;
  }
  const lines = trimmed.split("\n");
  return ["/**", ...lines.map((l) => ` * ${l}`), " */"].join("\n");
}

function indentText(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? indent + line : line))
    .join("\n");
}

function stubBody(name: string): string {
  return `throw new Error("${name}: not implemented");`;
}

/** Relative-import specifier from `fromFile` to `toFile`, mirroring
 *  the convention used by `operations.ts` (POSIX everywhere, drop
 *  extension, collapse to `<dir>` when target is `<dir>/index.<ext>`). */
function relativeImport(fromFile: string, toFile: string): string {
  const fromDir = path.posix.dirname(fromFile);
  let rel = path.posix.relative(fromDir, toFile);
  const ext = path.extname(rel);
  const base = path.basename(rel, ext);
  if (base === "index") {
    const dir = path.posix.dirname(rel);
    rel = dir === "." ? "." : dir;
  } else if (ext.length > 0) {
    rel = rel.slice(0, -ext.length);
  }
  if (rel === ".") return ".";
  if (rel.startsWith(".") || rel.startsWith("/")) return rel;
  return `./${rel}`;
}
