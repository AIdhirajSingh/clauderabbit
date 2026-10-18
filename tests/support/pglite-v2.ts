/**
 * An in-process Postgres with every migration applied (1.0 history plus the
 * 2.0 v2 set) and a `SqlExecutor` that runs each statement as the 2.0 server
 * role `cr_v2_server`, so store tests exercise the real SQL under the real
 * grants and RLS policies.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { SqlExecutor } from "../../lib/engine/db.ts";
import { PRELUDE } from "./supabase-prelude.ts";

const UP_DIR = path.resolve(import.meta.dirname, "..", "..", "supabase", "migrations");

export interface V2Database {
  /** Superuser handle for fixtures and assertions. */
  pg: PGlite;
  /** Every statement runs as cr_v2_server inside its own transaction. */
  server: SqlExecutor;
  close(): Promise<void>;
}

export async function openV2Database(): Promise<V2Database> {
  const pg = new PGlite({ extensions: { pgcrypto } });
  await pg.exec(PRELUDE);
  for (const f of readdirSync(UP_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(path.join(UP_DIR, f), "utf8").replace(/create extension if not exists "pg_stat_statements";/g, ""));
  }
  const server: SqlExecutor = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return pg.transaction(async (tx) => {
        await tx.exec("set local role cr_v2_server");
        const r = await tx.query<T>(text, params as unknown[]);
        return r.rows;
      });
    },
  };
  return { pg, server, close: () => pg.close() };
}
