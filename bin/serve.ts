#!/usr/bin/env tsx
/**
 * MCP stdio server entry point.
 *
 * Exposes the five task tools (submit_task, task_status,
 * task_log_tail, task_result, cancel_task) over a stdio MCP
 * transport. Run from Claude Code or any MCP client.
 *
 * State (task table + log files + result files) lives under
 * `~/.code-shaper/server-state` by default; override with
 * CODE_SHAPER_STATE_DIR.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { homedir } from "node:os";

import { createTaskTable } from "../src/server/task-table.js";
import {
  createServerContext,
  handleSubmitTask,
  handleTaskStatus,
  handleLogTail,
  handleTaskResult,
  handleCancelTask,
} from "../src/server/mcp.js";

const stateDir =
  process.env.CODE_SHAPER_STATE_DIR ??
  path.join(homedir(), ".code-shaper", "server-state");

const table = await createTaskTable({ stateDir });
const ctx = createServerContext(table);

const server = new McpServer(
  { name: "code-shaper", version: "0.0.1" },
  {
    capabilities: { tools: {} },
  },
);

server.tool(
  "submit_task",
  "Start a new task in the background. Returns a taskId immediately; the task runs in a child process you can poll with task_status / task_log_tail / task_result. Set projectDir to the absolute path the task should work in. Free-form `task` describes what to do.",
  {
    projectDir: z
      .string()
      .describe("Absolute path to the project directory the task works in."),
    task: z
      .string()
      .describe("Free-form description of what to do (build, fix, extend, etc.)."),
    mode: z
      .enum(["auto", "greenfield", "extend", "fix", "feature"])
      .optional()
      .describe(
        "Task type. `auto` picks greenfield (empty dir) or extend (non-empty). Default: auto.",
      ),
    diskQuotaMb: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max disk usage allowed under projectDir, in MB. Default 1024."),
  },
  async (args) => {
    const result = await handleSubmitTask(ctx, args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  "task_status",
  "Get the current phase and metadata of a task. Phase advances as the child reports progress: queued → starting → proposal → structure → interfaces → refactor → implementation → integration → done|failed|cancelled.",
  {
    taskId: z.string().describe("Task id returned by submit_task."),
  },
  async (args) => {
    const result = handleTaskStatus(ctx, args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  "task_log_tail",
  "Read new log lines emitted by the task since the byte offset you pass back. The first call should omit `since`; subsequent calls pass the `nextSince` from the prior response.",
  {
    taskId: z.string().describe("Task id."),
    since: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Byte offset returned by the previous call. Omit for the full log."),
  },
  async (args) => {
    const result = await handleLogTail(ctx, args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  "task_result",
  "Read the final TaskResult once the task is done|failed|cancelled. Returns a stub result if the task is still in flight.",
  {
    taskId: z.string().describe("Task id."),
  },
  async (args) => {
    const result = await handleTaskResult(ctx, args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  "cancel_task",
  "SIGTERM the task's child process. The task transitions to phase=failed; partial materialized files stay on disk.",
  {
    taskId: z.string().describe("Task id."),
  },
  async (args) => {
    const result = await handleCancelTask(ctx, args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`code-shaper MCP server up; stateDir=${stateDir}\n`);
