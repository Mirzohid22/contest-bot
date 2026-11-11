import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const app = await createApp(loadConfig());
await app.start();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.deps.log.info({ signal }, "shutting down");
  // Docker sends SIGKILL after stop_grace_period; do not hang past it.
  const force = setTimeout(() => process.exit(1), 25_000);
  force.unref();
  try {
    await app.stop();
  } catch (err) {
    app.deps.log.error({ err }, "error during shutdown");
    process.exitCode = 1;
  }
  process.exit();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => app.deps.log.error({ err }, "unhandled rejection"));
