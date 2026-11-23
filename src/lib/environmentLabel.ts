/**
 * The mark of a deployment that is not production (staging: `env.staging` in wrangler.jsonc).
 *
 * `MEETLY_ENVIRONMENT_LABEL` is a Worker variable, unset in production. Where it is set,
 * custom-worker.ts does three things to what the app answers, and the app itself is the same
 * build as production's:
 *
 * - every response says `X-Robots-Tag: noindex, nofollow`, and /robots.txt disallows everything,
 *   so search engines leave the site out;
 * - every page's <html> carries `data-meetly-env="<label>"`, which globals.css shows as a tab at
 *   the top of the screen, so nobody takes it for production.
 *
 * It is done in the Worker, not in a component: pages are prerendered at build time, when a
 * Worker's variables are not known.
 */

export const LABEL_ATTRIBUTE = "data-meetly-env";
export const NOINDEX = "noindex, nofollow";
export const ROBOTS_DISALLOW_ALL = "User-agent: *\nDisallow: /\n";

/** The label to show, or null in production. Letters, digits, spaces and hyphens; at most 24. */
export function environmentLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.replace(/[^A-Za-z0-9 -]/g, "").trim().slice(0, 24).trim();
  return label.length > 0 ? label : null;
}

/** What a labelled deployment answers for /robots.txt. */
export function robotsResponse(): Response {
  return new Response(ROBOTS_DISALLOW_ALL, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600", "x-robots-tag": NOINDEX },
  });
}

/** The Workers runtime's HTMLRewriter, as much of it as is used here. */
export type HtmlRewriter = {
  on(selector: string, handlers: { element(element: { setAttribute(name: string, value: string): unknown }): void }): HtmlRewriter;
  transform(response: Response): Response;
};

/**
 * The response as a labelled deployment sends it. A WebSocket upgrade is returned as it came:
 * it has no headers a crawler reads, and copying it would drop its socket.
 */
export function labelResponse(response: Response, label: string, rewriter: (() => HtmlRewriter) | null): Response {
  if (response.status === 101) return response;
  const marked = new Response(response.body, response);
  marked.headers.set("x-robots-tag", NOINDEX);
  const html = (marked.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
  if (!html || !rewriter) return marked;
  return rewriter()
    .on("html", {
      element(element) {
        element.setAttribute(LABEL_ATTRIBUTE, label);
      },
    })
    .transform(marked);
}
