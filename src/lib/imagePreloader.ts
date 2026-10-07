type Priority = "high" | "low";
type Job = {
  url: string; priority: Priority; subscribers: number; started: boolean; settled: boolean;
  image?: HTMLImageElement; promise: Promise<HTMLImageElement>;
  resolve: (image: HTMLImageElement) => void; reject: (error: unknown) => void;
};

/** Shares in-flight decodes, caps requests, and cancels abandoned preloads. */
export function createImagePreloader(limit = 3, factory: () => HTMLImageElement = () => new Image()) {
  const jobs = new Map<string, Job>();
  const waiting: Job[] = [];
  let active = 0;
  function finish(job: Job, error?: unknown) {
    if (job.settled) return;
    job.settled = true;
    if (job.started) active--;
    const index = waiting.indexOf(job);
    if (index >= 0) waiting.splice(index, 1);
    if (jobs.get(job.url) === job) jobs.delete(job.url);
    if (error) job.reject(error); else job.resolve(job.image!);
    pump();
  }
  function pump() {
    while (active < limit && waiting.length) {
      const index = waiting.findIndex(job => job.priority === "high");
      const job = waiting.splice(index < 0 ? 0 : index, 1)[0];
      job.started = true; active++;
      try {
        const image = factory();
        job.image = image;
        image.decoding = "async";
        image.fetchPriority = job.priority;
        image.src = job.url;
        void image.decode().then(() => finish(job), error => finish(job, error));
      } catch (error) { finish(job, error); }
    }
  }
  return {
    request(url: string, priority: Priority = "low") {
      let job = jobs.get(url);
      if (!job) {
        let resolve!: Job["resolve"]; let reject!: Job["reject"];
        const promise = new Promise<HTMLImageElement>((yes, no) => { resolve = yes; reject = no; });
        void promise.catch(() => {}); // cancellation can precede a caller's handler
        job = { url, priority, promise, resolve, reject, subscribers: 0, started: false, settled: false };
        jobs.set(url, job); waiting.push(job);
      } else if (priority === "high") job.priority = "high";
      job.subscribers++;
      pump();
      const requested = job;
      let cancelled = false;
      return {
        promise: requested.promise,
        cancel() {
          if (cancelled || requested.settled) return;
          cancelled = true;
          requested.subscribers--;
          // Effect cleanup and setup can transfer a preload into an upgrade.
          // Let that subscriber attach before aborting the shared request.
          queueMicrotask(() => {
            if (requested.settled || requested.subscribers > 0) return;
            // Detached preload only; the displayed <img> is untouched.
            if (requested.image) requested.image.src = "";
            finish(requested, new Error("Image preload cancelled."));
          });
        },
      };
    },
  };
}

export const imagePreloader = createImagePreloader();
