/** Bounded work, coalesced events, and one import at a time per source path. */
export function createImportQueue(concurrency: number, processFile: (filePath: string) => Promise<void>) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency.");
  const pending: string[] = [];
  const queued = new Set<string>();
  const active = new Set<string>();
  const dirty = new Set<string>();
  let closed = false;
  let idleWaiters: (() => void)[] = [];
  const notifyIdle = () => {
    if (!active.size && !pending.length) { for (const resolve of idleWaiters) resolve(); idleWaiters = []; }
  };
  const pump = () => {
    while (!closed && active.size < concurrency && pending.length) {
      const filePath = pending.shift()!;
      queued.delete(filePath); active.add(filePath);
      void Promise.resolve().then(() => processFile(filePath)).catch(error => {
        console.error(`Import failed: ${filePath}`, error);
      }).finally(() => {
        active.delete(filePath);
        if (!closed && dirty.delete(filePath)) { pending.push(filePath); queued.add(filePath); }
        pump(); notifyIdle();
      });
    }
    notifyIdle();
  };
  return {
    enqueue(filePath: string) {
      if (closed || queued.has(filePath)) return;
      if (active.has(filePath)) { dirty.add(filePath); return; }
      pending.push(filePath); queued.add(filePath); pump();
    },
    whenIdle(): Promise<void> {
      if (!active.size && !pending.length) return Promise.resolve();
      return new Promise(resolve => idleWaiters.push(resolve));
    },
    async close() {
      closed = true; pending.length = 0; queued.clear(); dirty.clear();
      notifyIdle();
      if (active.size) await new Promise<void>(resolve => idleWaiters.push(resolve));
    },
  };
}
