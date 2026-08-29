import { setTimeout as delay } from "node:timers/promises";
import { loadWorkerConfig } from "./config.js";
import { Worker } from "./worker.js";

const config = loadWorkerConfig();
const worker = new Worker(config);
const once = process.argv.includes("--once");
let stopping = false;
const wakeController = new AbortController();

const requestStop = () => {
  if (stopping) return;
  stopping = true;
  wakeController.abort();
};
process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

try {
  if (once) {
    const processed = await worker.runOnce();
    process.stdout.write(`${processed ? "processed" : "idle"}\n`);
  } else {
    process.stdout.write("worker started (PGlite durable queue; no Redis)\n");
    while (!stopping) {
      const processed = await worker.runOnce();
      if (!processed && !stopping) {
        try {
          await delay(config.pollIntervalMs, undefined, { signal: wakeController.signal });
        } catch (error) {
          if (!stopping) throw error;
        }
      }
    }
  }
} finally {
  await worker.close();
}

export { Worker } from "./worker.js";
export { loadWorkerConfig } from "./config.js";
