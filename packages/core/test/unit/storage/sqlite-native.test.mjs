import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBetterSqliteDatabase } from "@ccr/core/storage/sqlite-native.ts";

// Zamykamy tylko otwarte połączenia i nie tłumimy błędów z close().
function closeIfOpen(database) {
  if (database?.open) {
    database.close();
  }
}

test("persists a local database across reopen", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-native-"));
  const filename = path.join(directory, "state.db");
  let database;

  try {
    database = createBetterSqliteDatabase(filename);
    database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO entries (value) VALUES (?)").run("saved");
    database.close();
    database = createBetterSqliteDatabase(filename, { fileMustExist: true });

    const row = database.prepare("SELECT id, value FROM entries").get();
    assert.equal(row.id, 1);
    assert.equal(row.value, "saved");
  } finally {
    closeIfOpen(database);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fileMustExist rejects a missing file without creating it", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-native-"));
  const filename = path.join(directory, "missing.db");
  let database;

  try {
    assert.throws(() => {
      database = createBetterSqliteDatabase(filename, { fileMustExist: true });
    });
    assert.equal(existsSync(filename), false);
  } finally {
    closeIfOpen(database);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fileMustExist still allows writes to an existing file", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-native-"));
  const filename = path.join(directory, "state.db");
  let database;

  try {
    database = createBetterSqliteDatabase(filename);
    database.exec("CREATE TABLE entries (value TEXT NOT NULL)");
    database.close();

    database = createBetterSqliteDatabase(filename, { fileMustExist: true });
    database.prepare("INSERT INTO entries (value) VALUES (?)").run("written");
    assert.equal(database.prepare("SELECT value FROM entries").get().value, "written");
  } finally {
    closeIfOpen(database);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readonly reads existing rows, blocks writes, and does not create a missing file", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-native-"));
  const filename = path.join(directory, "existing.db");
  const missingFilename = path.join(directory, "missing.db");
  let database;

  try {
    database = createBetterSqliteDatabase(filename);
    database.exec("CREATE TABLE entries (value TEXT NOT NULL)");
    database.prepare("INSERT INTO entries (value) VALUES (?)").run("saved");
    database.close();

    database = createBetterSqliteDatabase(filename, { readonly: true });
    assert.equal(database.prepare("SELECT value FROM entries").get().value, "saved");
    assert.equal(database.readonly, true);
    assert.throws(() => {
      database.prepare("INSERT INTO entries (value) VALUES (?)").run("blocked");
    });
    database.close();
    database = undefined;

    assert.throws(() => {
      database = createBetterSqliteDatabase(missingFilename, { readonly: true });
    });
    assert.equal(existsSync(missingFilename), false);
  } finally {
    closeIfOpen(database);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves literal paths containing URL-reserved and Unicode characters", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-native-"));
  const filename = path.join(directory, "stan #? żółć.db");
  let database;

  try {
    database = createBetterSqliteDatabase(filename);
    database.exec("CREATE TABLE entries (value TEXT NOT NULL)");
    database.prepare("INSERT INTO entries (value) VALUES (?)").run("źródło");
    database.close();
    assert.equal(existsSync(filename), true);
    database = createBetterSqliteDatabase(filename, { fileMustExist: true });

    assert.equal(database.prepare("SELECT value FROM entries").get().value, "źródło");
  } finally {
    closeIfOpen(database);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses the default and explicit busy timeouts", () => {
  let defaultDatabase;
  let explicitDatabase;

  try {
    defaultDatabase = createBetterSqliteDatabase(":memory:");
    explicitDatabase = createBetterSqliteDatabase(":memory:", { timeout: 35 });

    assert.deepEqual(defaultDatabase.pragma("busy_timeout", { simple: false }), [
      { timeout: 5000 }
    ]);
    assert.deepEqual(explicitDatabase.pragma("busy_timeout", { simple: false }), [
      { timeout: 35 }
    ]);
  } finally {
    closeIfOpen(explicitDatabase);
    closeIfOpen(defaultDatabase);
  }
});

test("allows normal and fileMustExist memory databases but rejects readonly memory", () => {
  let database;
  let requiredDatabase;
  let readonlyDatabase;

  try {
    database = createBetterSqliteDatabase(":memory:");
    assert.equal(database.prepare("SELECT 1 AS value").get().value, 1);

    requiredDatabase = createBetterSqliteDatabase(":memory:", { fileMustExist: true });
    assert.equal(requiredDatabase.prepare("SELECT 2 AS value").get().value, 2);

    assert.throws(() => {
      readonlyDatabase = createBetterSqliteDatabase(":memory:", { readonly: true });
    });
  } finally {
    closeIfOpen(readonlyDatabase);
    closeIfOpen(requiredDatabase);
    closeIfOpen(database);
  }
});

test("rolls back failures and commits object-returning transactions", () => {
  const database = createBetterSqliteDatabase(":memory:");

  try {
    database.exec("CREATE TABLE entries (value TEXT NOT NULL)");
    const writeEntry = database.transaction((value, rollback) => {
      database.prepare("INSERT INTO entries (value) VALUES (?)").run(value);
      if (rollback) {
        throw new Error("rollback");
      }
      return { value, committed: true };
    });

    assert.throws(() => writeEntry("discarded", true));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 0);
    assert.deepEqual(writeEntry("kept", false), { value: "kept", committed: true });
    assert.equal(database.prepare("SELECT value FROM entries").get().value, "kept");
  } finally {
    closeIfOpen(database);
  }
});

test("exposes run metadata and statement reader, columns, and iterator", () => {
  const database = createBetterSqliteDatabase(":memory:");

  try {
    database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const insert = database.prepare("INSERT INTO entries (value) VALUES (?)");
    const result = insert.run("first");
    insert.run("second");
    const statement = database.prepare("SELECT id, value FROM entries ORDER BY id");

    assert.equal(result.changes, 1);
    assert.equal(result.lastInsertRowid, 1);
    assert.equal(statement.reader, true);
    assert.deepEqual(statement.columns(), [
      { name: "id", column: "id", table: "entries", database: "main", type: "INTEGER" },
      { name: "value", column: "value", table: "entries", database: "main", type: "TEXT" }
    ]);
    assert.deepEqual(
      [...statement.iterate()].map((row) => ({ id: row.id, value: row.value })),
      [{ id: 1, value: "first" }, { id: 2, value: "second" }]
    );
  } finally {
    closeIfOpen(database);
  }
});

test("accepts a BLOB among multiple run parameters", () => {
  const database = createBetterSqliteDatabase(":memory:");
  const payload = Buffer.from([0, 255, 5]);

  try {
    database.exec(
      "CREATE TABLE archive (source_path TEXT NOT NULL, payload BLOB NOT NULL, archived_at INTEGER NOT NULL)"
    );
    const result = database
      .prepare("INSERT INTO archive (source_path, payload, archived_at) VALUES (?, ?, ?)")
      .run("/profiles/źródło.db", payload, 42);
    const row = database.prepare("SELECT source_path, payload, archived_at FROM archive").get();

    assert.equal(result.changes, 1);
    assert.equal(result.lastInsertRowid, 1);
    assert.equal(row.source_path, "/profiles/źródło.db");
    assert.deepEqual(Buffer.from(row.payload), payload);
    assert.equal(row.archived_at, 42);
  } finally {
    closeIfOpen(database);
  }
});
