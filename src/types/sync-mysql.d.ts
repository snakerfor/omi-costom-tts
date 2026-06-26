declare module 'sync-mysql' {
  interface SyncMysqlOptions {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    socketPath?: string;
  }

  class SyncMysql {
    constructor(options: SyncMysqlOptions);
    query(sql: string, params?: unknown[]): any;
    dispose(): void;
  }

  export = SyncMysql;
}
