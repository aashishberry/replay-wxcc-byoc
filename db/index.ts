import { Pool, types } from "pg";
import { newDb } from "pg-mem";

let initialized: Promise<void> | null = null;
let pool: Pool | null = null;

// pg normally returns BIGINT values as strings. Timestamps in this app are
// millisecond integers that remain safely inside JavaScript's integer range.
types.setTypeParser(20, Number);

type QueryResult = { results: Record<string, unknown>[] };

class PreparedStatement {
  constructor(
    private readonly database: Pool,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new PreparedStatement(this.database, this.sql, params);
  }

  queryText() {
    let index = 0;
    let text = this.sql.replace(/\?/g, () => `$${++index}`);
    if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(text)) {
      text = text.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
      text = `${text.trim().replace(/;$/, "")} ON CONFLICT DO NOTHING`;
    }
    return text;
  }

  queryParams() {
    return this.params;
  }

  async all(): Promise<QueryResult> {
    const result = await this.database.query(this.queryText(), this.params);
    return { results: result.rows };
  }

  async first<T>(): Promise<T | null> {
    const result = await this.database.query(this.queryText(), this.params);
    return (result.rows[0] as T | undefined) ?? null;
  }

  async run() {
    const result = await this.database.query(this.queryText(), this.params);
    return { success: true, rowCount: result.rowCount ?? 0 };
  }
}

class Database {
  constructor(private readonly database: Pool) {}

  prepare(sql: string) {
    return new PreparedStatement(this.database, sql);
  }

  async batch(statements: PreparedStatement[]) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      for (const statement of statements) {
        await client.query(statement.queryText(), statement.queryParams());
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

let database: Database | null = null;

export function getDb(): Database {
  const connectionString = process.env.DATABASE_URL;
  if (!pool) {
    if (connectionString) {
      pool = new Pool({
        connectionString,
        max: Number(process.env.DATABASE_POOL_SIZE ?? 5),
        ssl:
          process.env.DATABASE_SSL === "true"
            ? { rejectUnauthorized: false }
            : false,
      });
    } else if (
      process.env.NODE_ENV !== "production" ||
      process.env.ALLOW_IN_MEMORY_DB === "true"
    ) {
      const memory = newDb();
      const adapter = memory.adapters.createPg();
      pool = new adapter.Pool() as unknown as Pool;
    } else {
      throw new Error("DATABASE_URL is unavailable.");
    }
    database = new Database(pool);
  }
  return database!;
}

export function ensureSchema() {
  if (!initialized) {
    const db = getDb();
    initialized = db
      .batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, origin_id TEXT NOT NULL, origin_name TEXT NOT NULL DEFAULT '',
        destination_id TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'accepted',
        last_event TEXT NOT NULL DEFAULT 'middleware:task-submitted', initial_text TEXT NOT NULL,
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, direction TEXT NOT NULL, sender_type TEXT,
        text TEXT NOT NULL DEFAULT '', attachments_json TEXT NOT NULL DEFAULT '[]',
        delivery_status TEXT NOT NULL DEFAULT 'recorded', created_at BIGINT NOT NULL)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, task_id TEXT, type TEXT NOT NULL, direction TEXT, reason TEXT,
        error_message TEXT, payload_json TEXT NOT NULL, created_at BIGINT NOT NULL)`),
        db.prepare(
          "CREATE INDEX IF NOT EXISTS tasks_updated_idx ON tasks(updated_at DESC)",
        ),
        db.prepare(
          "CREATE INDEX IF NOT EXISTS messages_task_idx ON messages(task_id, created_at ASC)",
        ),
        db.prepare(
          "CREATE INDEX IF NOT EXISTS events_task_idx ON events(task_id, created_at DESC)",
        ),
      ])
      .then(() => undefined);
  }
  return initialized;
}
