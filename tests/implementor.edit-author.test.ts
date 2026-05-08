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
    expect(r.error).toMatch(/must be strings/);
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
