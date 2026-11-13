import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

class Statement {
  constructor(statement, values = []) {
    this.statement = statement;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.statement, values);
  }

  async first() {
    return this.statement.get(...this.values) ?? null;
  }

  async all() {
    return { results: this.statement.all(...this.values) };
  }

  execute() {
    const { changes, lastInsertRowid } = this.statement.run(...this.values);
    return { meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) } };
  }

  async run() {
    return this.execute();
  }
}

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 5000 });
  const transaction = (operation) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  try {
    db.exec('PRAGMA journal_mode = WAL');
    transaction(() => db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')));
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    prepare: (sql) => new Statement(db.prepare(sql)),
    async batch(statements) {
      return transaction(() => statements.map((statement) => statement.execute()));
    },
    close: () => db.close(),
  };
}
