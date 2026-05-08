import { GuestbookDb } from "./db.js";
import type { Entry } from "./db.js";

export async function startServer(port: number): Promise<void> {
  const db = new GuestbookDb(".");
  await db.load();
  void port;
}

export const formatEntry = (entry: Entry): string => `${entry.id}: ${entry.body}`;

function internalHelper(): number {
  return 42;
}

void internalHelper;
