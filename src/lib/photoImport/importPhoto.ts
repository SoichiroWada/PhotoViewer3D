import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";
import { assertSourceUnchanged, sameFileState, waitForStableFile } from "./fileState";
import { readHandleStream, writeHandleStream } from "./fileStreams";
import { hashFile } from "./hashFile";
import { destinationCandidate, publishExclusive } from "./uniqueFilename";
import { supportedImage, validateImage } from "./validateImage";
import { SourceChangedError, type ImportDependencies, type ImportOptions, type ImportResult } from "./photoImportTypes";

async function copyBytes(source: FileHandle, destination: FileHandle) {
  await pipeline(
    readHandleStream(source),
    writeHandleStream(destination),
  );
}

/** Sizes first, hashing only an occupied, equally-sized regular candidate. */
export async function compareFiles(destinationPath: string, sourceInfo: Stats, sourceHash: () => Promise<string>, hash = hashFile): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let destination: FileHandle;
    try { destination = await open(destinationPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (["ENOENT", "ELOOP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
    try {
      const before = await destination.stat();
      if (!before.isFile() || before.size !== sourceInfo.size) return false;
      const incomingHash = await sourceHash();
      let destinationHash: string;
      try { destinationHash = await hash(destination); }
      catch (error) {
        // Removing the publishing temp link changes ctime without altering bytes.
        // Re-open and re-hash a racing destination instead of dropping the job.
        if (error instanceof SourceChangedError && attempt < 3) { await setTimeout(20); continue; }
        throw error;
      }
      if (!sameFileState(before, await destination.stat()) || !sameFileState(before, await lstat(destinationPath))) {
        if (attempt < 3) { await setTimeout(20); continue; }
        throw new Error("Destination changed during duplicate comparison; incoming file retained.");
      }
      return incomingHash === destinationHash;
    } finally { await destination.close(); }
  }
  throw new Error("Destination did not become stable for comparison.");
}

export async function importPhoto(sourcePath: string, photoDirectory: string, options: ImportOptions = {}, dependencies: Partial<ImportDependencies> = {}): Promise<ImportResult> {
  const filename = path.basename(sourcePath);
  if (!supportedImage(filename)) return { status: "ignored", sourcePath, reason: "Unsupported extension" };
  const original = await waitForStableFile(sourcePath, options);
  const directory = await realpath(photoDirectory);
  if (path.dirname(await realpath(sourcePath)) === directory) throw new Error("Incoming and destination directories must differ.");
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const hash = dependencies.hash ?? hashFile;
  let incomingHash: Promise<string> | undefined;
  const sourceHash = () => incomingHash ??= hash(source);
  let temporaryPath: string | undefined;
  let temporary: FileHandle | undefined;
  try {
    if (!sameFileState(original, await source.stat())) throw new SourceChangedError();
    await validateImage(source, filename);
    for (let index = 0; ; index++) {
      options.signal?.throwIfAborted();
      const destinationPath = destinationCandidate(directory, filename, index);
      if (await compareFiles(destinationPath, original, sourceHash, hash)) {
        await assertSourceUnchanged(sourcePath, original);
        await unlink(sourcePath);
        return { status: "duplicate", sourcePath, destinationPath };
      }
      // Occupied names need no copy; skip directly to the next candidate.
      try { await lstat(destinationPath); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!temporaryPath) {
        const candidate = path.join(directory, `.photo-import-${randomUUID()}.importing`);
        temporary = await open(candidate, "wx", 0o600);
        temporaryPath = candidate;
        await (dependencies.copy ?? copyBytes)(source, temporary);
        if ((await temporary.stat()).size !== original.size) throw new SourceChangedError();
        await assertSourceUnchanged(sourcePath, original);
        // Only ordinary permission bits; preserve mtime and pre-read atime.
        await temporary.chmod(original.mode & 0o777);
        await temporary.utimes(original.atime, original.mtime);
        await temporary.sync();
        await temporary.close();
        temporary = undefined;
      }
      await assertSourceUnchanged(sourcePath, original);
      if (!await publishExclusive(temporaryPath, destinationPath)) { index--; continue; }
      // Persist the directory entry before deleting the only incoming copy.
      const destinationDirectory = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await destinationDirectory.sync(); } finally { await destinationDirectory.close(); }
      await assertSourceUnchanged(sourcePath, original);
      await unlink(temporaryPath);
      temporaryPath = undefined;
      await unlink(sourcePath);
      return { status: index ? "renamed" : "imported", sourcePath, destinationPath };
    }
  } finally {
    await source.close();
    if (temporary) await temporary.close();
    if (temporaryPath) {
      try { await unlink(temporaryPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Temporary cleanup failed: ${temporaryPath}`, error); }
    }
  }
}
