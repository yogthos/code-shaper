/**
 * §D.1 localization agent — multi-step tool-using loop tests.
 */

import { describe, it, expect } from "vitest";
import { localize } from "../src/architect/localization.js";
import {
  emptyRPG,
  type FileNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function buildRpgWithStore(): RPG {
  const rpg = emptyRPG();
  const root = rpg.nodes[rpg.rootId] as FolderNode;
  rpg.nodes["folder:src"] = {
    id: "folder:src",
    kind: "folder",
    name: "src",
    parent: rpg.rootId,
    children: [],
    features: [],
    path: "src",
  };
  root.children.push("folder:src");
  const file: FileNode = {
    id: "file:src/store.ts",
    kind: "file",
    name: "store.ts",
    parent: "folder:src",
    children: [],
    features: [],
    path: "src/store.ts",
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    interfacePlan: {
      classes: [
        {
          name: "TodoStore",
          description: "An in-memory todo store.",
          exported: true,
          extendsName: null,
          extendsFromFile: null,
        },
      ],
      entries: [
        {
          leafCapabilityId: "cap:add",
          kind: "method",
          ownerClassName: "TodoStore",
          name: "addTodo",
          signature: {
            params: [{ name: "text", type: "string" }],
            returnType: "Todo",
            isAsync: false,
          },
          description: "Append a new active todo with a fresh id.",
          exported: false,
          isStatic: false,
        },
      ],
    },
  };
  rpg.nodes[file.id] = file;
  (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);
  return rpg;
}

interface Turn {
  toolName: string;
  args: unknown;
}

/**
 * Drive a fixed sequence of tool calls. Each chat() returns the
 * next turn; if the test runs out of turns, returns prose so the
 * agent loop fails out (test assertion catches that).
 */
function scriptedClient(turns: Turn[]): LLMClient {
  let i = 0;
  return {
    async chat(): Promise<LLMResponse> {
      if (i >= turns.length) {
        return { content: "out of script", finishReason: "stop" };
      }
      const turn = turns[i++]!;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: `call_${i}`,
            type: "function",
            function: {
              name: turn.toolName,
              arguments: JSON.stringify(turn.args),
            },
          },
        ],
      };
    },
    async listModels() {
      return ["mock"];
    },
  };
}

describe("localize — happy paths", () => {
  it("terminates with a ranked list when given a single Terminate call", async () => {
    const client = scriptedClient([
      {
        toolName: "Terminate",
        args: {
          result: [
            { file_path: "src/store.ts", interface: "method: TodoStore.addTodo" },
          ],
        },
      },
    ]);
    const r = await localize(client, {
      rpg: buildRpgWithStore(),
      task: "find the addTodo method",
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.result).toEqual([
      { filePath: "src/store.ts", interface: "method: TodoStore.addTodo" },
    ]);
    expect(r.iterations).toBe(1);
  });

  it("threads multi-step exploration before terminating", async () => {
    const client = scriptedClient([
      {
        toolName: "search_interface_by_functionality",
        args: { keywords: ["todo", "add"] },
      },
      {
        toolName: "view_file_interface_feature_map",
        args: { file_path: "src/store.ts" },
      },
      {
        toolName: "Terminate",
        args: {
          result: [
            {
              file_path: "src/store.ts",
              interface: "method: TodoStore.addTodo",
            },
          ],
        },
      },
    ]);
    const r = await localize(client, {
      rpg: buildRpgWithStore(),
      task: "find where new todos get added",
    });
    expect(r.ok).toBe(true);
    expect(r.iterations).toBe(3);
    expect(r.trail.map((t) => t.tool)).toEqual([
      "search_interface_by_functionality",
      "view_file_interface_feature_map",
      "Terminate",
    ]);
  });
});

describe("localize — recoverable errors", () => {
  it("recovers when the agent emits malformed JSON args", async () => {
    let i = 0;
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        i++;
        if (i === 1) {
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "c1",
                type: "function",
                function: {
                  name: "view_file_interface_feature_map",
                  arguments: "{ broken json",
                },
              },
            ],
          };
        }
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "c2",
              type: "function",
              function: {
                name: "Terminate",
                arguments: JSON.stringify({
                  result: [
                    {
                      file_path: "src/store.ts",
                      interface: "method: TodoStore.addTodo",
                    },
                  ],
                }),
              },
            },
          ],
        };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await localize(client, {
      rpg: buildRpgWithStore(),
      task: "x",
    });
    expect(r.ok).toBe(true);
    // First call recorded the parse error in the trail; second
    // terminated successfully.
    expect(r.trail).toHaveLength(2);
    expect(r.trail[0]!.output).toBe("[parse error]");
  });

  it("rejects malformed Terminate.result and lets the agent retry", async () => {
    let i = 0;
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        i++;
        if (i === 1) {
          // Bad: result is not an array.
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "c1",
                type: "function",
                function: {
                  name: "Terminate",
                  arguments: JSON.stringify({ result: "not an array" }),
                },
              },
            ],
          };
        }
        if (i === 2) {
          // Bad: interface doesn't start with one of the prefixes.
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "c2",
                type: "function",
                function: {
                  name: "Terminate",
                  arguments: JSON.stringify({
                    result: [
                      {
                        file_path: "src/store.ts",
                        interface: "addTodo",
                      },
                    ],
                  }),
                },
              },
            ],
          };
        }
        // Good.
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "c3",
              type: "function",
              function: {
                name: "Terminate",
                arguments: JSON.stringify({
                  result: [
                    {
                      file_path: "src/store.ts",
                      interface: "method: TodoStore.addTodo",
                    },
                  ],
                }),
              },
            },
          ],
        };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await localize(client, {
      rpg: buildRpgWithStore(),
      task: "x",
    });
    expect(r.ok).toBe(true);
    // Three iterations: bad result, bad interface format, good.
    expect(r.iterations).toBe(3);
  });
});

describe("localize — terminal failures", () => {
  it("reports failure when the agent doesn't terminate within budget", async () => {
    // Always returns search calls; never terminates.
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "c",
              type: "function",
              function: {
                name: "search_interface_by_functionality",
                arguments: JSON.stringify({ keywords: ["x"] }),
              },
            },
          ],
        };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await localize(client, {
      rpg: buildRpgWithStore(),
      task: "x",
      maxIterations: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exhausted 3 iterations/);
    expect(r.iterations).toBe(3);
  });

  it("reports failure when the agent emits no tool call at all", async () => {
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        return { content: "I don't know how to start", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await localize(client, {
      rpg: buildRpgWithStore(),
      task: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not emit a tool call/);
  });
});

describe("localize — initial prompt", () => {
  it("includes the repo skeleton and the task", async () => {
    let observed: string | undefined;
    const client: LLMClient = {
      async chat(messages): Promise<LLMResponse> {
        observed = messages[1]!.content;
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "c",
              type: "function",
              function: {
                name: "Terminate",
                arguments: JSON.stringify({ result: [] }),
              },
            },
          ],
        };
      },
      async listModels() {
        return ["mock"];
      },
    };
    await localize(client, {
      rpg: buildRpgWithStore(),
      task: "find the addTodo method",
      hint: "the failing test mentioned TodoStore",
    });
    expect(observed).toBeDefined();
    expect(observed!).toContain("find the addTodo method");
    expect(observed!).toContain("the failing test mentioned TodoStore");
    expect(observed!).toContain("src/store.ts");
    expect(observed!).toContain("src/");
  });
});
