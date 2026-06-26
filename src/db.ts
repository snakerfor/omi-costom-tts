import * as fs from 'fs';
import * as path from 'path';
import SyncMysql = require('sync-mysql');
import { dbPathDefault } from './runtime-paths';

export const dbPath = path.resolve(process.env.DB_PATH ?? dbPathDefault);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

function normalizeRows(rows: any): Array<Record<string, unknown>> {
  if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  if (rows == null) return [];
  if (typeof rows === 'object' && 'rows' in rows && Array.isArray((rows as any).rows)) {
    return (rows as any).rows as Array<Record<string, unknown>>;
  }
  return [];
}

function toMySqlIdentifier(sql: string): string {
  return sql.replace(/sqlite_master/g, 'information_schema.tables');
}

class MySqlPreparedStatement {
  constructor(private readonly inner: any, private readonly sql: string) {}

  all(...params: unknown[]) {
    const rows = this.inner.query(this.sql, params);
    return normalizeRows(rows);
  }

  get(...params: unknown[]) {
    const rows = this.all(...params);
    return rows[0] ?? undefined;
  }

  run(...params: unknown[]) {
    const result = this.inner.query(this.sql, params);
    return {
      changes: Number((result as any)?.affectedRows ?? (result as any)?.changes ?? 0),
    };
  }
}

class MySqlDb {
  private readonly inner: any;

  constructor() {
    const host = process.env.MYSQL_HOST || '127.0.0.1';
    const port = Number(process.env.MYSQL_PORT || 3306);
    const user = process.env.MYSQL_USER || 'root';
    const password = process.env.MYSQL_PASSWORD || '';
    const database = process.env.MYSQL_DATABASE || 'omi_custom_tts';
    const socketPath = process.env.MYSQL_SOCKET_PATH || '/var/lib/mysql/mysql.sock';

    this.inner = new SyncMysql({
      host,
      port,
      user,
      password,
      database,
      socketPath,
    });
  }

  prepare(sql: string) {
    return new MySqlPreparedStatement(this.inner, sql);
  }

  exec(sql: string) {
    return this.inner.query(toMySqlIdentifier(sql));
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return fn;
  }

  close(): void {
    this.inner.dispose?.();
  }
}

export const db: any = new MySqlDb();

export function initDb(): void {
  return;
}
