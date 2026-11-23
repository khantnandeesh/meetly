import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// Prerendered output (the home page, the not-found page and the static shell of /[code]) is
// served read-only from the Worker's static assets. Nothing in the app revalidates, so no R2/KV
// cache, queue or tag cache is needed.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});
