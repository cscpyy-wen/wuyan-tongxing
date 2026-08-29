import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({ config });
let closePromise: Promise<void> | null = null;

const stop = (signal: string) => {
  if (closePromise) return closePromise;
  app.log.info({ signal }, "shutting down");
  closePromise = app.close().then(() => { process.exitCode = 0; });
  return closePromise;
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "server failed to listen");
  process.exitCode = 1;
  await app.close();
}
