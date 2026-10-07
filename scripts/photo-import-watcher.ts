import { loadEnvConfig } from "@next/env";
import { startPhotoImportWatcher } from "../src/lib/photoImport/watcher";

// Use the project's existing .env.local/.env configuration; Next need not run.
loadEnvConfig(process.cwd(), true);
function positiveInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

async function main() {
  const incomingDirectory = process.env.PHOTO_INCOMING_DIRECTORY;
  const photoDirectory = process.env.PHOTO_DIRECTORY;
  if (!incomingDirectory || !photoDirectory) throw new Error("Set PHOTO_INCOMING_DIRECTORY and PHOTO_DIRECTORY in .env.local.");
  const watcher = await startPhotoImportWatcher({
    incomingDirectory, photoDirectory,
    concurrency: positiveInteger("PHOTO_IMPORT_CONCURRENCY", 4, 1, 16),
    stabilityMs: positiveInteger("PHOTO_IMPORT_STABILITY_MS", 3000, 500, 60000),
    pollIntervalMs: positiveInteger("PHOTO_IMPORT_POLL_MS", 250, 50, 5000),
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("Stopping watcher; finishing active imports. Queued sources remain in incoming.");
    await watcher.close();
  };
  process.once("SIGINT", () => { void stop().catch(error => { console.error(error); process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void stop().catch(error => { console.error(error); process.exitCode = 1; }); });
  await watcher.ready;
}
void main().catch(error => { console.error(`Watcher startup failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
