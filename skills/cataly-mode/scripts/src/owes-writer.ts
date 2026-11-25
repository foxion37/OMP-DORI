import { Database } from "bun:sqlite";
import { closeSync, lstatSync, openSync } from "node:fs";

const openReservation = (path: string): Database => {
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0)))
    throw new Error("owes writer reservation is not a private regular file");
  return new Database(path, { readwrite: true, create: false });
};

/** Serialize inspection, recovery and release of the owner lock file without storing message data in SQLite. */
export const tryOwesWriter = <T>(path: string, write: () => T): T | undefined => {
  const reservation = openReservation(`${path}.writer.sqlite`);
  try {
    try {
      reservation.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_BUSY") return undefined;
      throw error;
    }
    try {
      return write();
    } finally {
      reservation.exec("ROLLBACK");
    }
  } finally {
    reservation.close();
  }
};
