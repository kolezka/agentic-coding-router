import { pathToFileURL } from "node:url";
import DatabaseConstructor, { type Database as BetterSqliteDatabase } from "libsql";

export type {
  Database as BetterSqliteDatabase,
  Statement as BetterSqliteStatement
} from "libsql";

export type BetterSqliteDatabaseOptions = {
  fileMustExist?: boolean;
  readonly?: boolean;
  timeout?: number;
};

// Domyślny busy_timeout starego drivera. libsql bez tej opcji ustawia 0.
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const MAX_BUSY_TIMEOUT_MS = 2147483647;

export function createBetterSqliteDatabase(
  filename: string,
  options: BetterSqliteDatabaseOptions = {}
): BetterSqliteDatabase {
  const readonly = options.readonly === true;
  const database = new DatabaseConstructor(resolveDatabaseLocation(filename, options), {
    timeout: resolveBusyTimeout(options.timeout)
  });
  // libsql zawsze zwraca name "" i readonly false, więc uzupełniamy je po otwarciu.
  database.name = filename;
  database.readonly = readonly;
  return database;
}

// libsql ignoruje opcje readonly i fileMustExist, jedyne wejście to tryb w URI pliku.
// Dlatego realne ścieżki idą jako file: URI, co przy okazji chroni znaki "?" i "#"
// przed potraktowaniem ich jako składni URI i nie włącza zdalnego drivera.
function resolveDatabaseLocation(filename: string, options: BetterSqliteDatabaseOptions): string {
  if (isTransientDatabaseFilename(filename)) {
    if (options.readonly === true) {
      throw new TypeError(`Cannot open ${filename || "a temporary database"} in readonly mode`);
    }
    return filename;
  }

  const location = pathToFileURL(filename);
  if (options.readonly === true) {
    location.searchParams.set("mode", "ro");
  } else if (options.fileMustExist === true) {
    location.searchParams.set("mode", "rw");
  }
  return location.href;
}

function isTransientDatabaseFilename(filename: string): boolean {
  return filename === ":memory:" || filename === "";
}

function resolveBusyTimeout(timeout: number | undefined): number {
  if (timeout === undefined) {
    return DEFAULT_BUSY_TIMEOUT_MS;
  }
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > MAX_BUSY_TIMEOUT_MS) {
    throw new TypeError(
      `Expected the timeout option to be an integer between 0 and ${MAX_BUSY_TIMEOUT_MS}`
    );
  }
  return timeout;
}
