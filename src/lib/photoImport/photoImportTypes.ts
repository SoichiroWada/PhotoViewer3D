import type { FileHandle } from "node:fs/promises";

export type ImportResult =
  | { status: "imported" | "renamed" | "duplicate"; sourcePath: string; destinationPath: string }
  | { status: "ignored"; sourcePath: string; reason: string };
export type ImportOptions = { stabilityMs?: number; pollIntervalMs?: number; signal?: AbortSignal };
export type ImportDependencies = {
  hash: (file: string | FileHandle) => Promise<string>;
  copy: (source: FileHandle, destination: FileHandle) => Promise<void>;
};
export type WatcherConfig = {
  incomingDirectory: string; photoDirectory: string; concurrency: number;
  stabilityMs: number; pollIntervalMs: number;
};
export class SourceChangedError extends Error {
  constructor() { super("The source changed during processing; it was retained for a later attempt."); }
}
