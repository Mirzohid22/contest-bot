import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";

// Telegram ids and our bigserial ids fit in a double (Telegram guarantees at most 52 bits).
pg.types.setTypeParser(20, Number);

export type Db = Kysely<any>;
export type Trx = Transaction<any>;
/** Anything a query can run on: the pool or an open transaction. */
export type Executor = Db | Trx;

export function createDb(url: string, poolSize: number): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max: poolSize });
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

/**
 * Applies migrations/*.sql in name order, each in its own transaction, once.
 * Files are plain SQL so the schema can be read and reviewed without tooling.
 */
export async function migrate(pool: pg.Pool, dir: string): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (done.rowCount) continue;
      const body = await readFile(join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(body);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
  return applied;
}
