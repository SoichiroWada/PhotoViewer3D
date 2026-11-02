"use client";

import { useEffect, useRef, useState } from "react";
import { uploadPhoto } from "@/lib/api/awsApi";

type Item = { name: string; progress: number; status: "waiting" | "uploading" | "done" | "error"; error?: string };
const CONCURRENCY = 3;
/** How long a fully successful upload stays on screen before the panel closes itself. */
const AUTO_DISMISS_MS = 3000;

/** Uploads go straight to S3; a Lambda then catalogs them, so photos appear after a short delay. */
export default function UploadButton({ getAccessToken, onUploaded, unavailable }: {
  getAccessToken: () => Promise<string | null>;
  onUploaded: () => void;
  /** Why uploading is turned off (demo mode); the button is then disabled. */
  unavailable?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const busy = items.some(item => item.status === "waiting" || item.status === "uploading");
  const update = (index: number, change: Partial<Item>) =>
    setItems(current => current.map((item, position) => position === index ? { ...item, ...change } : item));

  async function start(files: File[]) {
    if (!files.length) return;
    setItems(files.map(file => ({ name: file.name, progress: 0, status: "waiting" })));
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const index = next++;
        update(index, { status: "uploading" });
        try {
          await uploadPhoto(files[index]!, getAccessToken, (loaded, total) => update(index, { progress: loaded / total }));
          update(index, { status: "done", progress: 1 });
        } catch (error) {
          update(index, { status: "error", error: error instanceof Error ? error.message : "Upload failed." });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    // Give the processing Lambda a moment before refreshing the catalog.
    window.setTimeout(onUploaded, 5000);
  }

  const done = items.filter(item => item.status === "done").length;
  const failed = items.filter(item => item.status === "error");
  const finished = items.length > 0 && !busy;
  // Failures stay until dismissed so their messages can be read.
  useEffect(() => {
    if (!finished || failed.length) return;
    const timer = window.setTimeout(() => setItems([]), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [finished, failed.length]);
  return (
    <>
      <input ref={input} type="file" multiple hidden accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
        onChange={event => { void start(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <button className="button" onClick={() => input.current?.click()} disabled={busy || !!unavailable} title={unavailable}>
        {busy ? `Uploading ${done}/${items.length}` : "Upload"} <span aria-hidden="true">↑</span>
      </button>
      {items.length > 0 && (
        <div className="upload-panel" role="status" aria-live="polite">
          <div className="upload-panel__header">
            <strong>{busy ? `Uploading ${done}/${items.length} photos…` : failed.length ? `${done}/${items.length} uploaded, ${failed.length} failed` : `${done}/${items.length} uploaded — processing`}</strong>
            {!busy && <button className="icon-button" onClick={() => setItems([])} aria-label="Dismiss upload status">×</button>}
          </div>
          <progress max={items.length} value={items.reduce((sum, item) => sum + item.progress, 0)} />
          {failed.length > 0 && <ul>{failed.map(item => <li key={item.name}>{item.name}: {item.error}</li>)}</ul>}
          {!busy && !failed.length && <p>New photos appear in the corridor shortly.</p>}
        </div>
      )}
    </>
  );
}
