/**
 * Phase 3 acceptance — deterministic.
 *
 * Drive `proposeFunctionalityGraph` with a mock LLM client and assert:
 *   - Validates a well-formed JSON plan and attaches it to the RPG.
 *   - Retries with a corrective prompt on the first attempt's parse
 *     error and succeeds on the second.
 *   - Hard-rejects malformed input after exhausting retries; RPG
 *     remains unchanged.
 *   - Extend mode includes an existing-RPG summary in the user prompt.
 *   - Attached nodes have the expected shape: capability kind, leaf
 *     flag matches plan, parent linkage correct, status "planned".
 *
 * The real-LLM smoke test lives in a sibling file — both gating and
 * cost vary per provider, so we keep the deterministic case isolated.
 */

import { describe, it, expect } from "vitest";

import {
  emptyRPG,
  isCapability,
  isFolder,
  type CapabilityNode,
} from "../src/rpg/index.js";
import {
  proposeFunctionalityGraph,
  parsePlanResponse,
} from "../src/architect/index.js";
import {
  buildProposalUserPrompt,
  summarizeExistingRPG,
} from "../src/architect/prompts.js";
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

const VALID_PLAN_JSON = JSON.stringify({
  projectName: "guestbook",
  description: "A minimal HTTP guestbook with file-backed entries.",
  rootCapabilities: [
    {
      name: "HTTP Server",
      description: "Listens on a port, routes requests to handlers.",
      children: [
        {
          name: "Server bootstrap",
          description: "Bind a TCP port and start accepting requests.",
        },
        {
          name: "Request routing",
          description: "Dispatch GET/POST to per-route handlers.",
        },
      ],
    },
    {
      name: "Persistence",
      description: "Read and write guestbook entries to a JSON file.",
      children: [
        {
          name: "Entry serialization",
          description: "Encode/decode entries as JSON.",
        },
        {
          name: "Disk I/O",
          description: "Append-only writes; full-file reads.",
        },
      ],
    },
    {
      name: "Validation",
      description: "Reject malformed entries before they reach storage.",
    },
  ],
});

describe("proposeFunctionalityGraph (mocked)", () => {
  it("validates and attaches a well-formed plan to an empty RPG", async () => {
    const rpg = emptyRPG();
    const { client, calls } = mockClient([VALID_PLAN_JSON]);

    const result = await proposeFunctionalityGraph(client, rpg, {
      description: "Build a tiny HTTP guestbook in TypeScript.",
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.attachedRootIds).toHaveLength(3);
    // 3 roots × (1 + their children): HTTP (3), Persistence (3), Validation (1) = 7
    expect(result.totalNodesAdded).toBe(7);

    // Root folder now has those 3 capability children.
    const root = rpg.nodes[rpg.rootId];
    expect(root && isFolder(root)).toBe(true);
    if (!root || !isFolder(root)) return;
    expect(root.children).toEqual(result.attachedRootIds);

    // Each capability has the right shape.
    for (const id of result.attachedRootIds) {
      const node = rpg.nodes[id];
      expect(node && isCapability(node)).toBe(true);
      if (!node || !isCapability(node)) continue;
      expect(node.parent).toBe(rpg.rootId);
      expect(node.status).toBe("planned");
      expect(node.mappedToId).toBeNull();
    }

    const findCapByName = (name: string): CapabilityNode | undefined =>
      Object.values(rpg.nodes).find(
        (n): n is CapabilityNode => isCapability(n) && n.name === name,
      );

    // The third root ("Validation") is a leaf — no children.
    const validation = findCapByName("Validation");
    expect(validation?.isLeaf).toBe(true);
    expect(validation?.children).toEqual([]);

    // The first root ("HTTP Server") is non-leaf with 2 children.
    const http = findCapByName("HTTP Server");
    expect(http?.isLeaf).toBe(false);
    expect(http?.children).toHaveLength(2);

    // Provider was asked for json_object output.
    expect(calls[0]!.options?.responseFormat).toEqual({ type: "json_object" });
  });

  it("retries with the previous error and succeeds on attempt 2", async () => {
    const rpg = emptyRPG();
    const { client, calls } = mockClient([
      // First attempt: missing description on a leaf — fails validation.
      JSON.stringify({
        projectName: "x",
        description: "y",
        rootCapabilities: [{ name: "Module", description: "" }],
      }),
      // Second attempt: corrected.
      VALID_PLAN_JSON,
    ]);

    const result = await proposeFunctionalityGraph(client, rpg, {
      description: "anything",
      maxAttempts: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);

    // The retry prompt includes the prior error.
    const retryUser = calls[1]!.messages.find(
      (m: any, idx: number) =>
        m.role === "user" && idx === calls[1]!.messages.length - 1,
    );
    expect(retryUser?.content).toMatch(/previous response failed validation/i);
    expect(retryUser?.content).toMatch(/description/);
  });

  it("returns a typed error and leaves the RPG untouched on exhausted retries", async () => {
    const rpg = emptyRPG();
    const root = rpg.nodes[rpg.rootId]!;
    const childrenBefore = [...root.children];

    const { client } = mockClient([
      // Both attempts return malformed JSON.
      "not json",
      "{}",
    ]);
    const result = await proposeFunctionalityGraph(client, rpg, {
      description: "x",
      maxAttempts: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.attachedRootIds).toEqual([]);
    expect(result.totalNodesAdded).toBe(0);
    // Root folder children unchanged.
    expect(root.children).toEqual(childrenBefore);
  });

  it("extend mode includes the existing-RPG summary in the prompt", async () => {
    const rpg = emptyRPG();
    // Inject a fake existing capability so the summary has content.
    const folderRoot = rpg.nodes[rpg.rootId];
    if (!folderRoot || !isFolder(folderRoot)) throw new Error("bad fixture");
    rpg.nodes["cap:existing"] = {
      id: "cap:existing",
      kind: "capability",
      name: "Existing Auth",
      parent: rpg.rootId,
      children: [],
      features: [],
      description: "Already-implemented OAuth flow.",
      isLeaf: true,
      status: "planned",
      mappedToId: null,
      decompositionDepth: 0,
    };
    folderRoot.children.push("cap:existing");

    const summary = summarizeExistingRPG(rpg);
    expect(summary).toMatch(/Existing Auth/);

    const { client, calls } = mockClient([VALID_PLAN_JSON]);
    const result = await proposeFunctionalityGraph(client, rpg, {
      description: "Add a guestbook capability to the existing app.",
      mode: "extend",
    });

    expect(result.ok).toBe(true);
    const userMsg = calls[0]!.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toMatch(/Existing repository structure/);
    expect(userMsg.content).toMatch(/Existing Auth/);
  });
});

describe("parsePlanResponse", () => {
  it("strips a fenced JSON block when present", () => {
    const fenced = "```json\n" + VALID_PLAN_JSON + "\n```";
    const r = parsePlanResponse(fenced);
    expect(r.ok).toBe(true);
  });

  it("rejects empty body", () => {
    const r = parsePlanResponse("   ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/empty/i);
  });

  it("rejects missing rootCapabilities", () => {
    const r = parsePlanResponse(
      JSON.stringify({ projectName: "x", description: "y" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/rootCapabilities/);
  });

  it("rejects empty rootCapabilities", () => {
    const r = parsePlanResponse(
      JSON.stringify({
        projectName: "x",
        description: "y",
        rootCapabilities: [],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/rootCapabilities/);
  });
});

describe("prompt rendering", () => {
  it("greenfield omits the existing-structure section", () => {
    const text = buildProposalUserPrompt({
      description: "build x",
      mode: "greenfield",
    });
    expect(text).not.toMatch(/Existing repository structure/);
    expect(text).toMatch(/build x/);
  });

  it("extend includes the supplied summary", () => {
    const text = buildProposalUserPrompt({
      description: "extend",
      mode: "extend",
      existingSummary: "## Folders\n- src/auth/",
    });
    expect(text).toMatch(/Existing repository structure/);
    expect(text).toMatch(/src\/auth/);
  });
});

