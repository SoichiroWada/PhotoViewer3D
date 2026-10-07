import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { SourceChangedError, type ImportOptions } from "./photoImportTypes";

export function sameFileState(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export async function assertSourceUnchanged(filePath: string, original: Stats) {
  const current = await lstat(filePath);
  if (!current.isFile() || !sameFileState(original, current)) throw new SourceChangedError();
}

/** Also covers initial files: awaitWriteFinish alone may bypass startup adds. */
export async function waitForStableFile(filePath: string, options: ImportOptions = {}): Promise<Stats> {
  const stabilityMs = options.stabilityMs ?? 3000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (stabilityMs < 0 || pollIntervalMs <= 0) throw new Error("Invalid stability interval.");
  let previous = await lstat(filePath);
  if (!previous.isFile()) throw new Error("Only regular files may be imported; symlinks are not followed.");
  let stableSince = performance.now();
  while (performance.now() - stableSince < stabilityMs) {
    await setTimeout(Math.min(pollIntervalMs, Math.max(1, stabilityMs - (performance.now() - stableSince))), undefined, { signal: options.signal });
    const current = await lstat(filePath);
    if (!current.isFile()) throw new SourceChangedError();
    if (!sameFileState(previous, current)) stableSince = performance.now();
    previous = current;
  }
  options.signal?.throwIfAborted();
  return previous;
}
