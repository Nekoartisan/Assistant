import postgres from "postgres";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const host = new URL(url).hostname;
const sql = postgres(url, {
  ssl: ["localhost", "127.0.0.1", "[::1]"].includes(host) ? false : "require",
  max: 1,
  prepare: false,
  onnotice: () => {},
});
try {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('bao-assistant-migration'))`;
    await tx`create table if not exists schema_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())`;
    const directory = new URL("../db/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((n) => /^\d+_.*\.sql$/.test(n))
      .sort()) {
      const body = await readFile(new URL(name, directory), "utf8");
      const hash = createHash("sha256").update(body).digest("hex");
      const rows =
        await tx`select checksum from schema_migrations where name=${name}`;
      if (rows.length) {
        if (rows[0].checksum !== hash)
          throw new Error("Applied migration checksum changed");
        continue;
      }
      await tx.unsafe(body);
      await tx`insert into schema_migrations(name,checksum) values(${name},${hash})`;
      console.log(`Migration applied: ${name}`);
    }
  });
  console.log("Migrations up to date.");
} catch {
  console.error(
    "Migration failed. Check database connectivity and applied migration checksums.",
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
