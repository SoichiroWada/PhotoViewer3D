import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { sameFileState } from "./fileState";
import { readHandleStream } from "./fileStreams";
import { SourceChangedError } from "./photoImportTypes";

/** Stream at most 64 KiB at a time; never read a whole photo into memory. */
export async function hashFile(file: string | FileHandle, createStream = readHandleStream): Promise<string> {
  const owned = typeof file === "string";
  const handle = owned ? await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) : file;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Cannot hash a non-regular file.");
    const hash = createHash("sha256");
    const stream = createStream(handle);
    for await (const chunk of stream) hash.update(chunk);
    if (!sameFileState(before, await handle.stat())) throw new SourceChangedError();
    return hash.digest("hex");
  } finally { if (owned) await handle.close(); }
}
