/**
 * Tool-using edit author — end-to-end with mocked LLM tool calls.
 *
 * The agent receives a file source + task; it picks ONE §D.2 tool
 * and emits structured args; the harness applies the tool and
 * returns the new file source.
 */

import { describe, it, expect } from "vitest";
import {
  editLeafViaTools,
  type EditAuthorInput,
} from "../src/implementor/edit-author.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function toolCallClient(
  toolName: string,
  args: Record<string, unknown>,
): { client: LLMClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const client: LLMClient = {
    async chat(messages, opts): Promise<LLMResponse> {
      calls.push({ messages, opts });
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: toolName,
              arguments: JSON.stringify(args),
            },
          },
        ],
      };
    },
    async listModels() {
      return ["mock"];
    },
  };
  return { client, calls };
}

interface ScriptedCall {
  toolName: string;
  args: Record<string, unknown>;
  /** Override JSON.stringify(args) for malformed-JSON tests. */
  rawArgs?: string;
}

/** Multi-turn (audit issue #4): script a sequence of tool calls
 *  the model will return on consecutive turns. After the script
 *  runs out the client returns prose (forces termination). */
function scriptedClient(
  calls: ScriptedCall[],
): { client: LLMClient; calls: unknown[] } {
  const recorded: unknown[] = [];
  let i = 0;
  const client: LLMClient = {
    async chat(messages, opts): Promise<LLMResponse> {
      recorded.push({ messages, opts });
      const c = calls[i++];
      if (!c) {
        return { content: "no more script", finishReason: "stop" };
      }
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: `call_${i}`,
            type: "function",
            function: {
              name: c.toolName,
              arguments: c.rawArgs ?? JSON.stringify(c.args),
            },
          },
        ],
      };
    },
    async listModels() {
      return ["mock"];
    },
  };
  return { client, calls: recorded };
}

const sampleFile = `function add(a: number, b: number): number {
  throw new Error("not implemented");
}
`;

const baseInput: EditAuthorInput = {
  fileSource: sampleFile,
  filePath: "src/add.ts",
  taskDescription: "Implement add to return a + b.",
};

describe("editLeafViaTools — happy paths", () => {
  it("applies edit_function_in_file when the agent picks it", async () => {
    const { client } = toolCallClient("edit_function_in_file", {
      function_name: "add",
      new_source: `function add(a: number, b: number): number {
  return a + b;
}`,
    });
    const r = await editLeafViaTools(client, baseInput);
    expect(r.ok, r.error).toBe(true);
    expect(r.tool).toBe("edit_function_in_file");
    expect(r.source).toContain("return a + b;");
    expect(r.source).not.toContain('throw new Error("not implemented")');
  });

  it("applies edit_method_of_class_in_file with class block", async () => {
    const fileWithClass = `class Counter {
  inc(): number {
    throw new Error("not implemented");
  }
  get(): number {
    return this.value;
  }
  value = 0;
}
`;
    const { client } = toolCallClient("edit_method_of_class_in_file", {
      class_name: "Counter",
      method_name: "inc",
      new_source: `class Counter {
  inc(): number {
    this.value += 1;
    return this.value;
  }
}`,
    });
    const r = await editLeafViaTools(client, {
      ...baseInput,
      fileSource: fileWithClass,
      taskDescription: "Implement Counter.inc.",
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.source).toContain("this.value += 1;");
    // Sibling method preserved.
    expect(r.source).toContain("get(): number");
    expect(r.source).toContain("return this.value;");
  });

  it("applies edit_imports_and_assignments_in_file", async () => {
    const fileWithImports = `import { x } from "./old";

function f(): void {}
`;
    const { client } = toolCallClient(
      "edit_imports_and_assignments_in_file",
      {
        new_source: `import { x } from "./new";
import path from "node:path";`,
      },
    );
    const r = await editLeafViaTools(client, {
      ...baseInput,
      fileSource: fileWithImports,
      taskDescription: "Switch the import path.",
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.source).toContain('import { x } from "./new"');
    expect(r.source).toContain('import path from "node:path"');
    expect(r.source).toContain("function f(): void {}");
  });
});

describe("editLeafViaTools — agent error paths", () => {
  it("rejects when the agent picks no tool", async () => {
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        return { content: "I don't know", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await editLeafViaTools(client, baseInput);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not emit a tool call/);
  });

  it("rejects an unknown tool name", async () => {
    const { client } = toolCallClient("totally_made_up", {});
    const r = await editLeafViaTools(client, baseInput);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown or disallowed/);
  });

  it("rejects a tool the caller didn't allow", async () => {
    const { client } = toolCallClient("edit_whole_class_in_file", {
      class_name: "Foo",
      new_source: "class Foo {}",
    });
    const r = await editLeafViaTools(client, {
      ...baseInput,
      allowedTools: ["edit_function_in_file"],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/disallowed/);
  });

  it("rejects malformed JSON arguments", async () => {
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "x",
              type: "function",
              function: {
                name: "edit_function_in_file",
                arguments: "{ this is not json",
              },
            },
          ],
        };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await editLeafViaTools(client, baseInput);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not parse as JSON/);
  });

  it("rejects missing required string args", async () => {
    const { client } = toolCallClient("edit_function_in_file", {
      function_name: "add",
      // new_source missing → must be string
    });
    const r = await editLeafViaTools(client, baseInput);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/new_source/);
    expect(r.error).toMatch(/must be a string/);
  });

  // Audit issue #13: type-error messages must echo the offending
  // arg's actual type and a snippet of the value, otherwise the
  // model can't see what it sent and tends to repeat the same
  // mistake. "function_name and new_source must be strings"
  // doesn't tell the model whether function_name was the offender
  // or new_source.
  it("type-error message names the offending arg, its type, and a value snippet", async () => {
    const { client } = toolCallClient("edit_function_in_file", {
      // function_name is null — must be string
      function_name: null,
      new_source: `function add() { return 1; }`,
    });
    const r = await editLeafViaTools(client, baseInput);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/function_name/);
    expect(r.error).toMatch(/object|null/i);
  });

  it("type-error message handles object args by showing the offending JSON", async () => {
    const { client } = toolCallClient("edit_function_in_file", {
      // function_name is an object — must be string
      function_name: { name: "add" },
      new_source: `function add() { return 1; }`,
    });
    const r = await editLeafViaTools(client, baseInput);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/function_name/);
    // The JSON body should appear in some form so the model can
    // see what it sent.
    expect(r.error).toMatch(/"add"/);
  });

  it("propagates underlying edit-tool errors (e.g., wrong function name)", async () => {
    const { client } = toolCallClient("edit_function_in_file", {
      function_name: "add",
      new_source: `function notAdd(): void {}`,
    });
    const r = await editLeafViaTools(client, baseInput);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must declare a function named "add"/);
  });

  // Audit issue #1: localize / applyEnvFixViaTools both wrap their
  // chat() call in try/catch. editLeafViaTools previously did not —
  // a transient API error fataled the entire leaf loop and
  // orchestrator. Here we assert the exception is captured into the
  // result so the caller can fall through to retry.
  it("captures client.chat exceptions into the result instead of fataling", async () => {
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        throw new Error("upstream 503: request timed out");
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await editLeafViaTools(client, baseInput);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/edit chat failed/);
    expect(r.error).toMatch(/upstream 503/);
  });
});

// Audit issue #4: editLeafViaTools is now multi-turn. When
// tree-sitter or arg-validation rejects an edit, the rejection is
// pushed back to the model as a tool message and the loop
// continues — the model can correct itself within the same chat
// session instead of waiting for the next body-author attempt
// (which is a fresh chat with no record of what was tried).
describe("editLeafViaTools — multi-turn recovery (audit issue #4)", () => {
  it("recovers from a wrong-name rejection on the second turn", async () => {
    const goodSrc = `function add(a: number, b: number): number { return a + b; }`;
    const { client, calls } = scriptedClient([
      // First turn: wrong function name → tree-sitter rejects.
      {
        toolName: "edit_function_in_file",
        args: {
          function_name: "add",
          new_source: `function notAdd(): void {}`,
        },
      },
      // Second turn: correct name.
      {
        toolName: "edit_function_in_file",
        args: { function_name: "add", new_source: goodSrc },
      },
    ]);
    const r = await editLeafViaTools(client, baseInput);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.source).toContain("return a + b");
    // Two chat calls = the loop ran twice.
    expect(calls).toHaveLength(2);
  });

  it("sends the underlying tool error back as a tool message", async () => {
    const goodSrc = `function add(a: number, b: number): number { return a + b; }`;
    const { client, calls } = scriptedClient([
      // First turn: wrong name.
      {
        toolName: "edit_function_in_file",
        args: {
          function_name: "add",
          new_source: `function notAdd(): void {}`,
        },
      },
      {
        toolName: "edit_function_in_file",
        args: { function_name: "add", new_source: goodSrc },
      },
    ]);
    await editLeafViaTools(client, baseInput);
    // The second turn's messages must contain a tool message with
    // the rejection reason — that's the proof the model got
    // actionable feedback within the session.
    const secondTurn = calls[1] as { messages: Array<{ role: string; content: string }> };
    const toolMsg = secondTurn.messages.find((m) => m.role === "tool");
    expect(toolMsg, "expected a tool message on turn 2").toBeDefined();
    expect(toolMsg!.content).toMatch(/must declare a function named/);
  });

  it("recovers from malformed JSON args on the second turn", async () => {
    const goodSrc = `function add(a: number, b: number): number { return a + b; }`;
    const { client } = scriptedClient([
      {
        toolName: "edit_function_in_file",
        args: {},
        rawArgs: "{ broken json",
      },
      {
        toolName: "edit_function_in_file",
        args: { function_name: "add", new_source: goodSrc },
      },
    ]);
    const r = await editLeafViaTools(client, baseInput);
    expect(r.ok).toBe(true);
    expect(r.source).toContain("return a + b");
  });

  it("recovers from a disallowed tool pick", async () => {
    const goodSrc = `function add(a: number, b: number): number { return a + b; }`;
    const { client } = scriptedClient([
      {
        toolName: "edit_whole_class_in_file",
        args: { class_name: "Foo", new_source: "class Foo {}" },
      },
      {
        toolName: "edit_function_in_file",
        args: { function_name: "add", new_source: goodSrc },
      },
    ]);
    const r = await editLeafViaTools(client, {
      ...baseInput,
      allowedTools: ["edit_function_in_file"],
    });
    expect(r.ok).toBe(true);
  });

  it("returns failure with full trail when budget exhausted", async () => {
    // Always wrong name → never recovers within the budget.
    const { client } = scriptedClient([
      {
        toolName: "edit_function_in_file",
        args: { function_name: "add", new_source: "function bad() {}" },
      },
      {
        toolName: "edit_function_in_file",
        args: { function_name: "add", new_source: "function bad2() {}" },
      },
    ]);
    const r = await editLeafViaTools(client, {
      ...baseInput,
      maxIterations: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.iterations).toBe(2);
    // Last error reflects the most recent rejection.
    expect(r.error).toMatch(/declare a function named/);
  });
});

describe("editLeafViaTools — request shape", () => {
  it("sends only the allowed tools to the LLM", async () => {
    const { client, calls } = toolCallClient("edit_function_in_file", {
      function_name: "add",
      new_source: `function add(a: number, b: number): number { return a + b; }`,
    });
    await editLeafViaTools(client, {
      ...baseInput,
      allowedTools: ["edit_function_in_file"],
    });
    const { opts } = calls[0]! as {
      opts: { tools: Array<{ function: { name: string } }> };
    };
    expect(opts.tools).toHaveLength(1);
    expect(opts.tools[0]!.function.name).toBe("edit_function_in_file");
  });

  // Audit issue #7: when the caller narrows allowedTools, the
  // system prompt must reflect that narrowing. Otherwise the
  // model reads a description of all four tools, picks one that's
  // blocked, and burns an iteration on the rejection.
  it("narrows the system prompt to describe ONLY the allowed tools", async () => {
    const { client, calls } = toolCallClient("edit_function_in_file", {
      function_name: "add",
      new_source: `function add(a: number, b: number): number { return a + b; }`,
    });
    await editLeafViaTools(client, {
      ...baseInput,
      allowedTools: ["edit_function_in_file"],
    });
    const { messages } = calls[0]! as {
      messages: Array<{ role: string; content: string }>;
    };
    const sys = messages[0]!.content;
    expect(sys).toContain("edit_function_in_file");
    // Other three tools must NOT appear in the prompt — otherwise
    // the model will sometimes pick them and get refused.
    expect(sys).not.toContain("edit_whole_class_in_file");
    expect(sys).not.toContain("edit_method_of_class_in_file");
    expect(sys).not.toContain("edit_imports_and_assignments_in_file");
  });

  it("includes all four tool descriptions when allowedTools is unset", async () => {
    const { client, calls } = toolCallClient("edit_function_in_file", {
      function_name: "add",
      new_source: `function add(a: number, b: number): number { return a + b; }`,
    });
    await editLeafViaTools(client, baseInput);
    const { messages } = calls[0]! as {
      messages: Array<{ role: string; content: string }>;
    };
    const sys = messages[0]!.content;
    expect(sys).toContain("edit_function_in_file");
    expect(sys).toContain("edit_whole_class_in_file");
    expect(sys).toContain("edit_method_of_class_in_file");
    expect(sys).toContain("edit_imports_and_assignments_in_file");
  });

  it("sets toolChoice=required so models don't return prose", async () => {
    const { client, calls } = toolCallClient("edit_function_in_file", {
      function_name: "add",
      new_source: `function add(a: number, b: number): number { return a + b; }`,
    });
    await editLeafViaTools(client, baseInput);
    const { opts } = calls[0]! as {
      opts: { toolChoice: string };
    };
    expect(opts.toolChoice).toBe("required");
  });

  it("includes failureMessage in retry calls", async () => {
    const { client, calls } = toolCallClient("edit_function_in_file", {
      function_name: "add",
      new_source: `function add(a: number, b: number): number { return a + b; }`,
    });
    await editLeafViaTools(client, {
      ...baseInput,
      failureMessage:
        "AssertionError: expected 4 to equal 5 at add.test.ts:5:10",
    });
    const { messages } = calls[0]! as { messages: Array<{ content: string }> };
    const userPrompt = messages[1]!.content;
    expect(userPrompt).toContain("Previous failure");
    expect(userPrompt).toContain("expected 4 to equal 5");
  });

  it("includes testSource in the prompt when provided", async () => {
    const { client, calls } = toolCallClient("edit_function_in_file", {
      function_name: "add",
      new_source: `function add(a: number, b: number): number { return a + b; }`,
    });
    await editLeafViaTools(client, {
      ...baseInput,
      testSource: `expect(add(2, 3)).toBe(5);`,
    });
    const { messages } = calls[0]! as { messages: Array<{ content: string }> };
    const userPrompt = messages[1]!.content;
    expect(userPrompt).toContain("Test that must pass");
    expect(userPrompt).toContain("expect(add(2, 3)).toBe(5)");
  });
});
