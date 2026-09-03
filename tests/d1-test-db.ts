import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function testDb() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  const prepare = (
    sql: string,
    values: Array<string | number | null> = [],
  ): D1PreparedStatement =>
    ({
      bind: (...args: Array<string | number | null>) => prepare(sql, args),
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes) },
        };
      },
      async all() {
        return {
          success: true,
          results: sqlite.prepare(sql).all(...values),
          meta: {},
        };
      },
      async first(column?: string) {
        const row = sqlite.prepare(sql).get(...values);
        return row ? (column ? row[column] : row) : null;
      },
    }) as unknown as D1PreparedStatement;
  const db = {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite, close: () => sqlite.close() };
}
