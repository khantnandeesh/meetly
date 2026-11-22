/**
 * Bundles the harness's page (./main.ts and everything of the package it uses) into one script
 * with esbuild, and serves it. Each page that loads it is one peer.
 *
 * Owner: E-harness.
 */
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { build } from "esbuild";

/** The page's script, as text. Nothing is written to disk. */
export async function bundlePage(): Promise<string> {
  const result = await build({
    entryPoints: [join(import.meta.dirname, "main.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    write: false,
    sourcemap: "inline",
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

const HTML = `<!doctype html><meta charset="utf-8"><title>overlay peer</title><body><script src="/peer.js"></script></body>`;

export type PageServer = { url: string; port: number; close(): Promise<void> };

/** Serves the page on 127.0.0.1 (a secure context, which WebCodecs and the camera need). */
export async function servePage(port: number, script?: string): Promise<PageServer> {
  const js = script ?? (await bundlePage());
  const server: Server = createServer((request, response) => {
    if (request.url === "/peer.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(js);
    } else {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(HTML);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const bound = address && typeof address === "object" ? address.port : port;
  return {
    url: `http://127.0.0.1:${bound}/`,
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
