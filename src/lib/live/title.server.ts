import { cleanTitle } from "./webinar";

/**
 * A serverless webinar's title travels in its link (`?title=…&ts=…`), since nothing is stored.
 * So that an edited link cannot put any headline it likes under Meetly's logo, the server signs
 * the title when the host goes live (HMAC-SHA-256 of the id and the title, under the admission
 * secret in its own domain), and the viewer's page shows the title only if the signature holds.
 * Without the secret nothing is signed and no title is shown.
 */

const utf8 = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sign(id: string, title: string): Promise<string | null> {
  const secret = process.env.OVERLAY_ADMISSION_SECRET ?? "";
  if (secret.length < 16) return null;
  const key = await crypto.subtle.importKey("raw", utf8.encode(`meetly-live-title:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // 128 bits is plenty for a link that only decides whether a title is shown.
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(`${id}\n${title}`))).slice(0, 16));
}

/** The title as it will be shown, and its signature; null when there is no title or nothing to sign with. */
export async function signTitle(id: string, raw: unknown): Promise<{ title: string; sig: string } | null> {
  const title = cleanTitle(raw);
  if (!title) return null;
  const sig = await sign(id, title);
  return sig ? { title, sig } : null;
}

/** The title from a viewer's link, if its signature is the server's; "" otherwise. */
export async function verifiedTitle(id: string, raw: unknown, presented: unknown): Promise<string> {
  const title = cleanTitle(raw);
  if (!title || typeof presented !== "string" || presented.length === 0 || presented.length > 64) return "";
  const expected = await sign(id, title);
  if (!expected || expected.length !== presented.length) return "";
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0 ? title : "";
}
