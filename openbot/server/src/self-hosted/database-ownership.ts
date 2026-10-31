import { Database } from "bun:sqlite";
import { chmodSync, existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { LocalError } from "./errors";

/** Share the OS guard across application/maintenance and equivalent symbolic paths. */
export function ownDatabase(path: string) {
  const locks: Database[] = [];
  try {
    const lexical = resolve(path);
    if (existsSync(lexical)) {
      const info = statSync(lexical);
      // Hard links have no single canonical path for a sidecar ownership protocol.
      if (!info.isFile() || info.nlink !== 1)
        throw new Error("Unsupported target");
    }
    const canonical = existsSync(lexical)
      ? realpathSync.native(lexical)
      : join(realpathSync.native(dirname(lexical)), basename(lexical));
    const paths = new Map(
      [lexical, canonical].map((value) => {
        // Directory aliases share one physical sidecar; do not lock it twice.
        // File aliases retain their lexical sidecar as well as the target guard.
        const guard = join(
          realpathSync.native(dirname(value)),
          `${basename(value)}.lock.sqlite`,
        );
        return [
          process.platform === "win32" ? guard.toLowerCase() : guard,
          guard,
        ];
      }),
    );
    // Keep the lexical guard for compatibility with existing normal-path servers.
    for (const value of [...paths.values()].sort()) {
      const lock = new Database(value, { create: true });
      locks.push(lock);
      chmodSync(value, 0o600);
      lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    }
  } catch {
    for (const lock of locks.reverse()) lock.close();
    throw new LocalError(
      "This local database already has a server or cannot be locked.",
      503,
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const lock of locks.reverse()) lock.close();
  };
}
