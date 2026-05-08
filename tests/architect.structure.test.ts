/**
 * Phase 4 acceptance — deterministic.
 *
 *   - Maps every required (non-leaf, planned) capability to a folder
 *     or file, sets status="mapped", populates mappedToId.
 *   - Skips leaves and already-mapped capabilities.
 *   - Backfills implicit intermediate folders when a file's path
 *     contains them.
 *   - Validation rejects: unknown capability ids, mappings of leaves,
 *     bad paths (absolute, "..", folder-with-extension, file with
 *     unknown extension), duplicates, role drift.
 *   - Retry on validation error replays prior assistant turn.
 *   - Idempotent: existing folders/files at the same path are reused
 *     (extend mode).
 *   - When every required mapping is already done, returns ok=true
 *     without calling the LLM.
 */

import { describe, it, expect } from "vitest";

import {
  emptyRPG,
  isCapability,
  isFile,
  isFolder,
  type CapabilityNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  encodeFileStructure,
  parseStructureResponse,
  proposeFunctionalityGraph,
} from "../src/architect/index.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function mockClient(responses: string[]): {
  client: LLMClient;
  calls: Array<{ messages: any[]; options?: any }>;
} {
  const calls: Array<{ messages: any[]; options?: any }> = [];
  let i = 0;
  const client: LLMClient = {
    async chat(messages, options): Promise<LLMResponse> {
      calls.push({ messages, options });
      const content = responses[i++] ?? "";
      return { content, finishReason: "stop" };
    },
    async listModels() {
      return ["mock"];
    },
  };
  return { client, calls };
}

const PROPOSAL_JSON = JSON.stringify({
  projectName: "guestbook",
  description: "Tiny HTTP guestbook with file-backed entries.",
  rootCapabilities: [
    {
      name: "HTTP Interface",
      description: "Listens, routes, parses, responds.",
      children: [
        { name: "Routing", description: "Method+path → handler." },
        { name: "Parsing", description: "Decode JSON payloads." },
      ],
    },
    {
      name: "Persistence",
      description: "Read+write entries to a JSON file.",
      children: [
        { name: "Reader", description: "Load entries from disk." },
        { name: "Writer", description: "Save entries to disk." },
      ],
    },
  ],
});

async function withProposal(): Promise<{
  rpg: RPG;
  caps: { http: CapabilityNode; persistence: CapabilityNode; routing: CapabilityNode; parsing: CapabilityNode; reader: CapabilityNode; writer: CapabilityNode };
}> {
  const rpg = emptyRPG();
  const { client } = mockClient([PROPOSAL_JSON]);
  const r = await proposeFunctionalityGraph(client, rpg, { description: "x" });
  if (!r.ok) throw new Error("proposal setup failed");
  const findCap = (name: string): CapabilityNode => {
    for (const n of Object.values(rpg.nodes)) {
      if (isCapability(n) && n.name === name) return n;
    }
    throw new Error(`capability ${name} not found`);
  };
  return {
    rpg,
    caps: {
      http: findCap("HTTP Interface"),
      persistence: findCap("Persistence"),
      routing: findCap("Routing"),
      parsing: findCap("Parsing"),
      reader: findCap("Reader"),
      writer: findCap("Writer"),
    },
  };
}

describe("encodeFileStructure (mocked)", () => {
  it("maps every required capability and sets status/mappedToId", async () => {
    const { rpg, caps } = await withProposal();
    const planJson = JSON.stringify({
      mappings: [
        { capabilityId: caps.http.id, kind: "folder", path: "src/http" },
        { capabilityId: caps.persistence.id, kind: "folder", path: "src/persistence" },
        { capabilityId: caps.routing.id, kind: "file", path: "src/http/routing.ts" },
        { capabilityId: caps.parsing.id, kind: "file", path: "src/http/parsing.ts" },
        { capabilityId: caps.reader.id, kind: "file", path: "src/persistence/reader.ts" },
        { capabilityId: caps.writer.id, kind: "file", path: "src/persistence/writer.ts" },
      ],
    });
    const { client } = mockClient([planJson]);

    const result = await encodeFileStructure(client, rpg, {
      description: "guestbook",
    });
    expect(result.ok, result.error).toBe(true);
    expect(result.unmappedRequired).toEqual([]);
    expect(result.mappings).toHaveLength(6);

    // Each capability now points to its target via mappedToId.
    for (const cap of [caps.http, caps.persistence, caps.routing, caps.parsing, caps.reader, caps.writer]) {
      const updated = rpg.nodes[cap.id]!;
      if (!isCapability(updated)) throw new Error("kind drift");
      expect(updated.status).toBe("mapped");
      expect(updated.mappedToId).toBeTruthy();
      const target = rpg.nodes[updated.mappedToId!];
      expect(target).toBeDefined();
    }

    // Folder children show the new files (and src parent appeared
    // implicitly because both top-level folders are under it).
    const httpFolder = rpg.nodes[caps.http.mappedToId!];
    if (!httpFolder || !isFolder(httpFolder)) throw new Error("not a folder");
    const httpFolderUpdated = rpg.nodes[httpFolder.id] as FolderNode;
    expect(httpFolderUpdated.children.length).toBe(2);
    const fileNames = httpFolderUpdated.children
      .map((id) => rpg.nodes[id])
      .filter((n) => n && isFile(n))
      .map((n) => (n!.kind === "file" ? n!.name : ""));
    expect(fileNames.sort()).toEqual(["parsing.ts", "routing.ts"]);
  });

  it("backfills implicit intermediate folders not in the mapping list", async () => {
    const { rpg, caps } = await withProposal();
    // Architect deliberately maps top-level folders but only a few
    // file paths require deep intermediates. The "src" folder isn't
    // listed but every file is under "src/...".
    const planJson = JSON.stringify({
      mappings: [
        { capabilityId: caps.http.id, kind: "folder", path: "src/http" },
        { capabilityId: caps.persistence.id, kind: "folder", path: "src/persistence" },
        { capabilityId: caps.routing.id, kind: "file", path: "src/http/routing.ts" },
        { capabilityId: caps.parsing.id, kind: "file", path: "src/http/parsing.ts" },
        { capabilityId: caps.reader.id, kind: "file", path: "src/persistence/reader.ts" },
        { capabilityId: caps.writer.id, kind: "file", path: "src/persistence/writer.ts" },
      ],
    });
    const { client } = mockClient([planJson]);
    const result = await encodeFileStructure(client, rpg, { description: "x" });
    expect(result.ok).toBe(true);

    // Implicit "src/" folder was created.
    const src = rpg.nodes["folder:src"];
    expect(src && isFolder(src)).toBe(true);
    if (!src || !isFolder(src)) return;
    expect(src.children.sort()).toEqual(["folder:src/http", "folder:src/persistence"]);
  });

  it("when every required mapping is done, returns ok=true without an LLM call", async () => {
    const { rpg, caps } = await withProposal();
    // Pre-mark all required as mapped.
    for (const cap of Object.values(rpg.nodes)) {
      if (isCapability(cap) && !cap.isLeaf) {
        cap.status = "mapped";
        cap.mappedToId = "stub";
      }
    }
    const { client, calls } = mockClient([]);
    const result = await encodeFileStructure(client, rpg, {
      description: "x",
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(0);
    expect(calls).toHaveLength(0);
    void caps;
  });

  it("retries on validation error and replays the assistant turn", async () => {
    const { rpg, caps } = await withProposal();
    // First response: bad — file with unknown extension.
    const bad = JSON.stringify({
      mappings: [
        { capabilityId: caps.http.id, kind: "folder", path: "src/http" },
        { capabilityId: caps.persistence.id, kind: "folder", path: "src/persist" },
        { capabilityId: caps.routing.id, kind: "file", path: "src/http/routing.exe" },
        { capabilityId: caps.parsing.id, kind: "file", path: "src/http/parsing.ts" },
        { capabilityId: caps.reader.id, kind: "file", path: "src/persist/reader.ts" },
        { capabilityId: caps.writer.id, kind: "file", path: "src/persist/writer.ts" },
      ],
    });
    // Second: good.
    const good = JSON.stringify({
      mappings: [
        { capabilityId: caps.http.id, kind: "folder", path: "src/http" },
        { capabilityId: caps.persistence.id, kind: "folder", path: "src/persist" },
        { capabilityId: caps.routing.id, kind: "file", path: "src/http/routing.ts" },
        { capabilityId: caps.parsing.id, kind: "file", path: "src/http/parsing.ts" },
        { capabilityId: caps.reader.id, kind: "file", path: "src/persist/reader.ts" },
        { capabilityId: caps.writer.id, kind: "file", path: "src/persist/writer.ts" },
      ],
    });
    const { client, calls } = mockClient([bad, good]);

    const result = await encodeFileStructure(client, rpg, {
      description: "x",
      maxAttempts: 2,
    });
    expect(result.ok, result.error).toBe(true);
    expect(calls).toHaveLength(2);
    const retry = calls[1]!.messages;
    expect(retry.map((m: any) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(retry[2]!.content).toBe(bad);
    expect(retry[3]!.content).toMatch(/validation/i);
  });
});

describe("parseStructureResponse — validation", () => {
  function setup() {
    return withProposal();
  }
  const exts = [".ts", ".tsx", ".mts", ".cts"];

  it("rejects unknown capabilityId", async () => {
    const { rpg } = await setup();
    const mappable: CapabilityNode[] = Object.values(rpg.nodes).filter(
      (n): n is CapabilityNode => isCapability(n) && n.status === "planned",
    );
    const r = parseStructureResponse(
      JSON.stringify({
        mappings: [{ capabilityId: "cap:nope", kind: "folder", path: "src" }],
      }),
      mappable,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown id/);
  });

  it("accepts mapping a leaf to a file (single-function module)", async () => {
    const { rpg } = await setup();
    const leaf = Object.values(rpg.nodes).find(
      (n): n is CapabilityNode => isCapability(n) && n.isLeaf,
    );
    expect(leaf).toBeDefined();
    // The mappable set must include leaves — they're allowed targets
    // even though only non-leaves are *required*.
    const mappable: CapabilityNode[] = Object.values(rpg.nodes).filter(
      (n): n is CapabilityNode => isCapability(n) && n.status === "planned",
    );
    const r = parseStructureResponse(
      JSON.stringify({
        mappings: [{ capabilityId: leaf!.id, kind: "file", path: "src/x.ts" }],
      }),
      mappable,
      exts,
      rpg,
    );
    expect(r.ok, r.ok === false ? r.error : undefined).toBe(true);
    if (!r.ok) return;
    expect(r.plan.mappings).toHaveLength(1);
  });

  it("rejects absolute paths and ..", async () => {
    const { rpg, caps } = await setup();
    const mappable = [caps.http];
    const cases = ["/abs/foo", "../escape", "..\\windowsy"];
    for (const bad of cases) {
      const r = parseStructureResponse(
        JSON.stringify({
          mappings: [{ capabilityId: caps.http.id, kind: "folder", path: bad }],
        }),
        mappable,
        exts,
        rpg,
      );
      expect(r.ok, `should reject ${bad}`).toBe(false);
    }
  });

  it("rejects file paths with unknown extensions", async () => {
    const { rpg, caps } = await setup();
    const mappable = [caps.routing];
    const r = parseStructureResponse(
      JSON.stringify({
        mappings: [
          { capabilityId: caps.routing.id, kind: "file", path: "src/x.exe" },
        ],
      }),
      mappable,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/extension/);
  });

  it("rejects folder paths that look like files", async () => {
    const { rpg, caps } = await setup();
    const mappable = [caps.http];
    const r = parseStructureResponse(
      JSON.stringify({
        mappings: [
          { capabilityId: caps.http.id, kind: "folder", path: "src/oops.ts" },
        ],
      }),
      mappable,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/folder path looks like a file/i);
  });

  it("rejects duplicate file paths", async () => {
    const { rpg, caps } = await setup();
    const mappable = [caps.routing, caps.parsing];
    const r = parseStructureResponse(
      JSON.stringify({
        mappings: [
          { capabilityId: caps.routing.id, kind: "file", path: "src/x.ts" },
          { capabilityId: caps.parsing.id, kind: "file", path: "src/x.ts" },
        ],
      }),
      mappable,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/duplicate/);
  });

  it("rejects path used as both folder and file", async () => {
    const { rpg, caps } = await setup();
    const mappable = [caps.http, caps.routing];
    const r = parseStructureResponse(
      JSON.stringify({
        mappings: [
          { capabilityId: caps.http.id, kind: "folder", path: "src/x" },
          { capabilityId: caps.routing.id, kind: "file", path: "src/x" },
        ],
      }),
      mappable,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/folder|file/);
  });
});

describe("encodeFileStructure — extend mode (idempotent reuse)", () => {
  it("reuses an existing folder when its path matches a mapping", async () => {
    const { rpg, caps } = await withProposal();
    // Pre-create src/http on disk (simulate pre-existing structure).
    const preExisting: FolderNode = {
      id: "folder:src/http",
      kind: "folder",
      name: "http",
      parent: rpg.rootId,
      children: [],
      features: [],
      path: "src/http",
    };
    rpg.nodes[preExisting.id] = preExisting;
    const root = rpg.nodes[rpg.rootId];
    if (!root || !isFolder(root)) throw new Error("bad fixture");

    const planJson = JSON.stringify({
      mappings: [
        { capabilityId: caps.http.id, kind: "folder", path: "src/http" },
        { capabilityId: caps.persistence.id, kind: "folder", path: "src/persist" },
        { capabilityId: caps.routing.id, kind: "file", path: "src/http/routing.ts" },
        { capabilityId: caps.parsing.id, kind: "file", path: "src/http/parsing.ts" },
        { capabilityId: caps.reader.id, kind: "file", path: "src/persist/reader.ts" },
        { capabilityId: caps.writer.id, kind: "file", path: "src/persist/writer.ts" },
      ],
    });
    const { client } = mockClient([planJson]);
    const result = await encodeFileStructure(client, rpg, {
      description: "x",
      mode: "extend",
    });
    expect(result.ok).toBe(true);

    // Same FolderNode id was reused.
    expect(rpg.nodes["folder:src/http"]).toBe(preExisting);
    // The capability points to it.
    const httpUpdated = rpg.nodes[caps.http.id]!;
    if (!isCapability(httpUpdated)) throw new Error("kind drift");
    expect(httpUpdated.mappedToId).toBe("folder:src/http");
  });
});
