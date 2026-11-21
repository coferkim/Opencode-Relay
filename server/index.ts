import index from "./frontend/index.html";
import { createApp } from "./app";
import { log } from "./log";

const app = createApp({ index });

log.info("relay.listen", {
  url: `http://127.0.0.1:${app.server.port}`,
  docs: `http://127.0.0.1:${app.server.port}/docs`,
  log_level: process.env.RELAY_LOG_LEVEL ?? "info",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("relay.stop", { signal });
    app.stop();
    process.exit(0);
  });
}
