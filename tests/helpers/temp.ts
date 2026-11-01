import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs = [];

/** mkdtemp under the OS temp dir, tracked for cleanup by cleanupTempDirs(). */
export async function tempDir(prefix = "bh-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Best-effort removal of every directory created through tempDir(). */
export async function cleanupTempDirs() {
  const pending = dirs.splice(0, dirs.length);
  for (const dir of pending) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }
}
