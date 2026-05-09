/**
 * Phase 5 acceptance — deterministic.
 *
 *   - Plans an interface entry per leaf capability and attaches an
 *     InterfacePlan to each host file.
 *   - Marks each leaf capability mapped to its host file.
 *   - Creates new FileNodes when the architect proposes paths the
 *     RPG didn't have yet.
 *   - Populates rpg.dataFlow from architect-supplied edges, replacing
 *     any prior edge for the same (from, to) pair.
 *   - Validation rejects: missing leaves, unknown leaf ids, duplicate
 *     names per file, non-camelCase identifiers, methods referencing
 *     undeclared classes, within-file extends to a sibling that
 *     doesn't exist, malformed signatures, bad file paths.
 *   - Retry on validation failure replays the assistant turn.
 *   - When there are zero leaf capabilities, returns ok=true without
 *     calling the LLM.
 */

import { describe, it, expect } from "vitest";

import {
  emptyRPG,
  isCapability,
  isFile,
  type CapabilityNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  designInterfaces,
  encodeFileStructure,
  parseInterfaceResponse,
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
  description: "Tiny guestbook.",
  rootCapabilities: [
    {
      name: "HTTP",
      description: "HTTP layer.",
      children: [
        { name: "route get", description: "GET /entries handler." },
        { name: "route post", description: "POST /entries handler." },
      ],
    },
    {
      name: "Persistence",
      description: "Disk I/O.",
      children: [
        { name: "read entries", description: "Load JSON from disk." },
        { name: "write entries", description: "Save JSON to disk." },
      ],
    },
  ],
});

const STRUCTURE_PLAN_TEMPLATE = (
  httpId: string,
  persistenceId: string,
): string =>
  JSON.stringify({
    mappings: [
      { capabilityId: httpId, kind: "folder", path: "src/http" },
      { capabilityId: persistenceId, kind: "folder", path: "src/persist" },
    ],
  });

async function pipelineThroughPhase4(): Promise<{
  rpg: RPG;
  caps: {
    http: CapabilityNode;
    persistence: CapabilityNode;
    routeGet: CapabilityNode;
    routePost: CapabilityNode;
    readEntries: CapabilityNode;
    writeEntries: CapabilityNode;
  };
}> {
  const rpg = emptyRPG();
  const { client: c1 } = mockClient([PROPOSAL_JSON]);
  const p = await proposeFunctionalityGraph(c1, rpg, { description: "x" });
  if (!p.ok) throw new Error("proposal failed");

  const findCap = (name: string): CapabilityNode => {
    for (const n of Object.values(rpg.nodes)) {
      if (isCapability(n) && n.name === name) return n;
    }
    throw new Error(`cap ${name} not found`);
  };
  const http = findCap("HTTP");
  const persistence = findCap("Persistence");
  const { client: c2 } = mockClient([
    STRUCTURE_PLAN_TEMPLATE(http.id, persistence.id),
  ]);
  const s = await encodeFileStructure(c2, rpg, { description: "x" });
  if (!s.ok) throw new Error(`structure failed: ${s.error}`);

  return {
    rpg,
    caps: {
      http,
      persistence,
      routeGet: findCap("route get"),
      routePost: findCap("route post"),
      readEntries: findCap("read entries"),
      writeEntries: findCap("write entries"),
    },
  };
}

function plannedFn(
  leafId: string,
  filePath: string,
  name: string,
  desc: string,
  exported = true,
): any {
  return {
    leafCapabilityId: leafId,
    filePath,
    kind: "function",
    name,
    ownerClassName: null,
    signature: {
      params: [],
      returnType: "void",
      isAsync: false,
    },
    description: desc,
    exported,
    isStatic: false,
  };
}

function plannedMethod(
  leafId: string,
  filePath: string,
  className: string,
  methodName: string,
  desc: string,
): any {
  return {
    leafCapabilityId: leafId,
    filePath,
    kind: "method",
    name: methodName,
    ownerClassName: className,
    signature: { params: [], returnType: "void", isAsync: false },
    description: desc,
    exported: true,
    isStatic: false,
  };
}

describe("designInterfaces (mocked)", () => {
  it("plans every leaf as a function or method, attaches InterfacePlans, and creates files", async () => {
    const { rpg, caps } = await pipelineThroughPhase4();

    const planJson = JSON.stringify({
      interfaces: [
        plannedFn(
          caps.routeGet.id,
          "src/http/handlers.ts",
          "handleGetEntries",
          "GET /entries returns the stored entries as JSON.",
        ),
        plannedMethod(
          caps.routePost.id,
          "src/http/handlers.ts",
          "PostHandler",
          "handlePost",
          "POST /entries accepts a payload and stores it.",
        ),
        plannedFn(
          caps.readEntries.id,
          "src/persist/store.ts",
          "readEntries",
          "Read entries from the JSON store.",
        ),
        plannedFn(
          caps.writeEntries.id,
          "src/persist/store.ts",
          "writeEntries",
          "Write entries to the JSON store.",
        ),
      ],
      classes: [
        {
          filePath: "src/http/handlers.ts",
          name: "PostHandler",
          description: "Handles POST submissions.",
          extendsName: null,
          exported: true,
        },
      ],
      dataFlow: [
        {
          fromLeafId: caps.readEntries.id,
          toLeafId: caps.routeGet.id,
          payload: "Entry[]",
        },
      ],
    });
    const { client } = mockClient([planJson]);

    const result = await designInterfaces(client, rpg, { description: "x" });
    expect(result.ok, result.error).toBe(true);
    expect(result.unplannedLeaves).toEqual([]);
    expect(result.entries).toHaveLength(4);
    expect(result.classes).toHaveLength(1);

    // Files were created and have InterfacePlans.
    const handlersFile = rpg.nodes["file:src/http/handlers.ts"];
    expect(handlersFile && isFile(handlersFile)).toBe(true);
    if (!handlersFile || !isFile(handlersFile)) return;
    expect(handlersFile.interfacePlan).toBeDefined();
    expect(handlersFile.interfacePlan!.entries).toHaveLength(2);
    expect(handlersFile.interfacePlan!.classes).toHaveLength(1);

    const storeFile = rpg.nodes["file:src/persist/store.ts"];
    expect(storeFile && isFile(storeFile)).toBe(true);
    if (!storeFile || !isFile(storeFile)) return;
    expect(storeFile.interfacePlan!.entries).toHaveLength(2);

    // Leaves are now mapped to their host files.
    for (const cap of [
      caps.routeGet,
      caps.routePost,
      caps.readEntries,
      caps.writeEntries,
    ]) {
      const updated = rpg.nodes[cap.id];
      if (!updated || !isCapability(updated)) throw new Error("kind drift");
      expect(updated.status).toBe("mapped");
      expect(updated.mappedToId).toMatch(/^file:/);
    }

    // Data flow edge landed.
    expect(rpg.dataFlow).toHaveLength(1);
    expect(rpg.dataFlow[0]!.payload).toBe("Entry[]");
  });

  it("returns ok=true without LLM call when there are zero leaves", async () => {
    const rpg = emptyRPG();
    const { client, calls } = mockClient([]);
    const result = await designInterfaces(client, rpg, { description: "x" });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(result.attempts).toBe(0);
  });

  it("retries on validation error and replays the assistant turn", async () => {
    const { rpg, caps } = await pipelineThroughPhase4();
    const bad = JSON.stringify({
      // Missing route post — partial coverage.
      interfaces: [
        plannedFn(caps.routeGet.id, "src/http/handlers.ts", "handleGet", "x"),
        plannedFn(caps.readEntries.id, "src/persist/store.ts", "readEntries", "x"),
        plannedFn(caps.writeEntries.id, "src/persist/store.ts", "writeEntries", "x"),
      ],
      classes: [],
      dataFlow: [],
    });
    const good = JSON.stringify({
      interfaces: [
        plannedFn(caps.routeGet.id, "src/http/handlers.ts", "handleGet", "x"),
        plannedFn(caps.routePost.id, "src/http/handlers.ts", "handlePost", "x"),
        plannedFn(caps.readEntries.id, "src/persist/store.ts", "readEntries", "x"),
        plannedFn(caps.writeEntries.id, "src/persist/store.ts", "writeEntries", "x"),
      ],
      classes: [],
      dataFlow: [],
    });
    const { client, calls } = mockClient([bad, good]);
    const result = await designInterfaces(client, rpg, {
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
  });

  it("replaces a prior data-flow edge for the same (from, to) pair", async () => {
    const { rpg, caps } = await pipelineThroughPhase4();
    rpg.dataFlow.push({
      fromNode: caps.readEntries.id,
      toNode: caps.routeGet.id,
      payload: "old payload",
    });
    rpg.dataFlow.push({
      fromNode: caps.writeEntries.id,
      toNode: caps.routePost.id,
      payload: "untouched",
    });
    const planJson = JSON.stringify({
      interfaces: [
        plannedFn(caps.routeGet.id, "src/http/handlers.ts", "handleGet", "x"),
        plannedFn(caps.routePost.id, "src/http/handlers.ts", "handlePost", "x"),
        plannedFn(caps.readEntries.id, "src/persist/store.ts", "readEntries", "x"),
        plannedFn(caps.writeEntries.id, "src/persist/store.ts", "writeEntries", "x"),
      ],
      classes: [],
      dataFlow: [
        {
          fromLeafId: caps.readEntries.id,
          toLeafId: caps.routeGet.id,
          payload: "Entry[]",
        },
      ],
    });
    const { client } = mockClient([planJson]);
    const result = await designInterfaces(client, rpg, { description: "x" });
    expect(result.ok).toBe(true);
    // Old (read→get) edge replaced; (write→post) edge preserved.
    const payloads = rpg.dataFlow.map((e) => e.payload).sort();
    expect(payloads).toEqual(["Entry[]", "untouched"]);
  });

  // Phase 5 used to crash the whole orchestrator when GLM threw
  // a stall abort. Now we catch the chat exception and retry on
  // the SAME interface call (the parse-error retry loop covers
  // it). After all retries exhausted, designInterfaces returns
  // ok=false with a clear error rather than throwing.
  it("returns ok=false with a clear error when the LLM throws on every retry (e.g. stall abort)", async () => {
    const { rpg } = await pipelineThroughPhase4();
    let calls = 0;
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        calls++;
        // Simulate the openai-provider's stall-abort error name
        // and message.
        const e = new Error("[glm/glm-5.1] This operation was aborted");
        e.name = "AbortError";
        throw e;
      },
      async listModels() {
        return ["mock"];
      },
    };
    const result = await designInterfaces(client, rpg, { description: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/LLM call failed|aborted/i);
    // Each retry budget burns at least a couple of calls; the
    // orchestrator gracefully gives up rather than crashing.
    expect(calls).toBeGreaterThan(0);
  });
});

describe("parseInterfaceResponse — validation", () => {
  const exts = [".ts", ".tsx"];

  function makeLeaves(): { rpg: RPG; leaves: CapabilityNode[]; ids: string[] } {
    const rpg = emptyRPG();
    const leaves: CapabilityNode[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = `cap:leaf-${i}`;
      const node: CapabilityNode = {
        id,
        kind: "capability",
        name: `leaf ${i}`,
        parent: rpg.rootId,
        children: [],
        features: [],
        description: "leaf",
        isLeaf: true,
        status: "planned",
        mappedToId: null,
      decompositionDepth: 0,
      };
      rpg.nodes[id] = node;
      const root = rpg.nodes[rpg.rootId] as FolderNode;
      root.children.push(id);
      leaves.push(node);
      ids.push(id);
    }
    return { rpg, leaves, ids };
  }

  it("rejects responses where some leaves are missing", () => {
    const { rpg, leaves, ids } = makeLeaves();
    const r = parseInterfaceResponse(
      JSON.stringify({
        interfaces: [plannedFn(ids[0]!, "src/x.ts", "x", "x")],
        classes: [],
        dataFlow: [],
      }),
      leaves,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing/i);
  });

  it("rejects unknown leafCapabilityId", () => {
    const { rpg, leaves } = makeLeaves();
    const r = parseInterfaceResponse(
      JSON.stringify({
        interfaces: [plannedFn("cap:fake", "src/x.ts", "x", "x")],
        classes: [],
        dataFlow: [],
      }),
      leaves,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not a known leaf/);
  });

  it("rejects duplicate function names in the same file", () => {
    const { rpg, leaves, ids } = makeLeaves();
    const r = parseInterfaceResponse(
      JSON.stringify({
        interfaces: [
          plannedFn(ids[0]!, "src/x.ts", "shared", "x"),
          plannedFn(ids[1]!, "src/x.ts", "shared", "x"),
        ],
        classes: [],
        dataFlow: [],
      }),
      leaves,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/duplicate/i);
  });

  it("rejects non-camelCase function names", () => {
    const { rpg, leaves, ids } = makeLeaves();
    const r = parseInterfaceResponse(
      JSON.stringify({
        interfaces: [
          plannedFn(ids[0]!, "src/x.ts", "BadName", "x"),
          plannedFn(ids[1]!, "src/x.ts", "alsoOk", "x"),
        ],
        classes: [],
        dataFlow: [],
      }),
      leaves,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/camelCase/);
  });

  it("rejects methods referencing undeclared classes", () => {
    const { rpg, leaves, ids } = makeLeaves();
    const r = parseInterfaceResponse(
      JSON.stringify({
        interfaces: [
          plannedMethod(ids[0]!, "src/x.ts", "Ghost", "doStuff", "x"),
          plannedFn(ids[1]!, "src/x.ts", "ok", "x"),
        ],
        classes: [],
        dataFlow: [],
      }),
      leaves,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not declared/);
  });

  it("rejects extends pointing to a class not in the same file", () => {
    const { rpg, leaves, ids } = makeLeaves();
    const r = parseInterfaceResponse(
      JSON.stringify({
        interfaces: [
          plannedFn(ids[0]!, "src/x.ts", "x", "x"),
          plannedFn(ids[1]!, "src/x.ts", "y", "y"),
        ],
        classes: [
          {
            filePath: "src/x.ts",
            name: "Child",
            description: "x",
            extendsName: "Parent",
            exported: true,
          },
        ],
        dataFlow: [],
      }),
      leaves,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/extends.*not declared/);
  });

  it("rejects file paths with bad extensions", () => {
    const { rpg, leaves, ids } = makeLeaves();
    const r = parseInterfaceResponse(
      JSON.stringify({
        interfaces: [
          plannedFn(ids[0]!, "src/x.exe", "x", "x"),
          plannedFn(ids[1]!, "src/x.ts", "y", "y"),
        ],
        classes: [],
        dataFlow: [],
      }),
      leaves,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/extension/);
  });

  it("rejects malformed signatures", () => {
    const { rpg, leaves, ids } = makeLeaves();
    const r = parseInterfaceResponse(
      JSON.stringify({
        interfaces: [
          {
            leafCapabilityId: ids[0],
            filePath: "src/x.ts",
            kind: "function",
            name: "fn",
            ownerClassName: null,
            signature: {
              params: [
                { name: "BadName", type: "string" }, // not camelCase
              ],
              returnType: "void",
              isAsync: false,
            },
            description: "x",
            exported: true,
            isStatic: false,
          },
          plannedFn(ids[1]!, "src/x.ts", "ok", "x"),
        ],
        classes: [],
        dataFlow: [],
      }),
      leaves,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/camelCase/);
  });

  it("accepts containerKind values for paradigm-agnostic outputs", () => {
    const { rpg, leaves, ids } = makeLeaves();
    const r = parseInterfaceResponse(
      JSON.stringify({
        interfaces: [
          plannedMethod(ids[0]!, "src/x.ts", "Trait", "doIt", "a"),
          plannedMethod(ids[1]!, "src/x.ts", "Trait", "doMore", "b"),
        ],
        classes: [
          {
            filePath: "src/x.ts",
            name: "Trait",
            containerKind: "trait",
            description: "Rust-style trait surfaced via the schema.",
            extendsName: null,
            exported: true,
          },
        ],
        dataFlow: [],
      }),
      leaves,
      exts,
      rpg,
    );
    expect(r.ok, r.ok === false ? r.error : undefined).toBe(true);
    if (!r.ok) return;
    expect(r.plan.classes[0]!.containerKind).toBe("trait");
  });

  it("rejects unknown containerKind values", () => {
    const { rpg, leaves, ids } = makeLeaves();
    const r = parseInterfaceResponse(
      JSON.stringify({
        interfaces: [
          plannedFn(ids[0]!, "src/x.ts", "a", "x"),
          plannedFn(ids[1]!, "src/x.ts", "b", "x"),
        ],
        classes: [
          {
            filePath: "src/x.ts",
            name: "Bogus",
            containerKind: "monad", // not in our list
            description: "unknown kind",
            extendsName: null,
            exported: true,
          },
        ],
        dataFlow: [],
      }),
      leaves,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/containerKind/);
  });

  it("rejects self-loop in data flow", () => {
    const { rpg, leaves, ids } = makeLeaves();
    const r = parseInterfaceResponse(
      JSON.stringify({
        interfaces: [
          plannedFn(ids[0]!, "src/x.ts", "a", "x"),
          plannedFn(ids[1]!, "src/x.ts", "b", "x"),
        ],
        classes: [],
        dataFlow: [
          { fromLeafId: ids[0], toLeafId: ids[0], payload: "x" },
        ],
      }),
      leaves,
      exts,
      rpg,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/same id/i);
  });
});
