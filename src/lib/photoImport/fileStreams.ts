import { createReadStream, createWriteStream, read, write } from "node:fs";
import type { FileHandle } from "node:fs/promises";

// The importer owns FileHandles until verification and fsync finish. Streams
// use numeric descriptors without taking ownership or holding FileHandle refs.
const retainDescriptor = (_fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => callback(null);
export function readHandleStream(handle: FileHandle) {
  return createReadStream("", {
    fd: handle.fd, start: 0, highWaterMark: 64 * 1024,
    fs: { read, close: retainDescriptor },
  });
}
export function writeHandleStream(handle: FileHandle) {
  return createWriteStream("", {
    fd: handle.fd, start: 0,
    fs: { write, close: retainDescriptor },
  });
}
