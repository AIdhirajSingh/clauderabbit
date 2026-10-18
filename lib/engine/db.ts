/**
 * The 2.0 server's database connection (DESIGN.md section 7).
 *
 * 2.0 data lives in schema `v2` of the production project and is reached only
 * as the login role `cr_v2_server` through the Supavisor pooler in transaction
 * mode (`CR_V2_DATABASE_URL`, port 6543). That role has DML on v2 tables and
 * EXECUTE on v2 functions, no grant on any 1.0 table, and cannot bypass RLS.
 * No Supabase secret or service key is read anywhere in the 2.0 server.
 *
 * Everything above this file talks to `SqlExecutor`, so the same queries run
 * against PGlite in tests.
 */

import postgres from "postgres";

export interface SqlExecutor {
  /** Run one parameterised statement ($1, $2, ...) and return its rows. */
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

/** A database error with its SQLSTATE when the driver reported one. */
export interface SqlError extends Error {
  code?: string;
}

export function sqlState(err: unknown): string | undefined {
  return err && typeof err === "object" && typeof (err as SqlError).code === "string" ? (err as SqlError).code : undefined;
}

/** Host part of a connection URL for error messages; credentials never appear. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}

/**
 * Checks a v2 connection URL without echoing it: postgres scheme, the pooler
 * user `cr_v2_server.<project ref>` (or plain `cr_v2_server`), and a password.
 */
export function validateDatabaseUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "CR_V2_DATABASE_URL is not a URL";
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return "CR_V2_DATABASE_URL must use the postgres scheme";
  const user = decodeURIComponent(u.username);
  if (user !== "cr_v2_server" && !/^cr_v2_server\.[a-z0-9]{20}$/.test(user)) return "CR_V2_DATABASE_URL must log in as cr_v2_server";
  if (!u.password) return "CR_V2_DATABASE_URL has no password";
  return null;
}

let shared: { url: string; sql: postgres.Sql } | null = null;

/**
 * One small pool per function instance. Supavisor transaction mode does not
 * keep prepared statements across transactions, so `prepare: false`.
 */
export function postgresExecutor(url: string): SqlExecutor {
  if (!shared || shared.url !== url) {
    const sql = postgres(url, {
      prepare: false,
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      max_lifetime: 60 * 10,
      ssl: "require",
      connection: { application_name: "clauderabbit-2.0" },
      onnotice: () => {},
    });
    shared = { url, sql };
  }
  const sql = shared.sql;
  return {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
  };
}
