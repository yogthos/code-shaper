import { join } from "node:path";

export interface Entry {
  id: string;
  body: string;
}

export class GuestbookDb {
  private path: string;

  constructor(rootDir: string) {
    this.path = join(rootDir, "entries.json");
  }

  async load(): Promise<Entry[]> {
    return [];
  }

  async save(entries: Entry[]): Promise<void> {
    void entries;
  }
}
