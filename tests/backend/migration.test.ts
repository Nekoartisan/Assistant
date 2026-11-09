import { it, expect } from "vitest";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
it.skipIf(!process.env.TEST_DATABASE_URL)(
  "explicit migration command applies transactionally and is repeatable",
  async () => {
    const exec = promisify(execFile);
    const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL };
    const a = await exec(process.execPath, ["scripts/migrate.mjs"], { env });
    const b = await exec(process.execPath, ["scripts/migrate.mjs"], { env });
    expect(a.stdout).toContain("Migration");
    expect(b.stdout).toContain("up to date");
  },
);
