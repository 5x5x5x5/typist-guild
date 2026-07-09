import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env extends import("../src/auth").Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
