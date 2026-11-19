import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests never hit the network: they run against the bundled snapshot.
    env: { REVERSIM_OFFLINE: "1", METRICS_LOG: "off" },
  },
});
