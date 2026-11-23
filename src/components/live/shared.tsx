"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/ui/Logo";
import type { LiveTree } from "@/lib/live/tree";

/** The "Beta" tag both Live pages carry. */
export function BetaTag() {
  return (
    <span className="inline-flex h-6 items-center rounded-md px-2 text-xs font-semibold tracking-wide text-accent uppercase ring-1 ring-accent/40 ring-inset">
      Beta
    </span>
  );
}

export function LiveHeader() {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-5 sm:px-8">
      <Logo />
      <BetaTag />
    </header>
  );
}

/** The coordinator's WebSocket, through the app's own Worker (custom-worker.ts). */
export const coordinatorUrl = (id: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live/${encodeURIComponent(id)}`;

export class LiveRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new LiveRequestError(data.error ?? `Request failed (${response.status}).`, response.status);
  return data;
}

export async function fetchTree(id: string): Promise<LiveTree> {
  const response = await fetch(`/api/live/${encodeURIComponent(id)}/tree`, { cache: "no-store" });
  const data = (await response.json().catch(() => ({}))) as LiveTree & { error?: string };
  if (!response.ok) throw new LiveRequestError(data.error ?? `Request failed (${response.status}).`, response.status);
  return data;
}

/** How often "Who's connected" asks again. */
const TREE_EVERY_MS = 2000;

/** The stream's tree, asked for every two seconds while `id` is set and the page is visible. */
export function useLiveTree(id: string | null): LiveTree | null {
  const [tree, setTree] = useState<LiveTree | null>(null);
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const next = await fetchTree(id);
          if (!stopped) setTree(next);
        } catch {
          // Kept as it was; the next poll tries again.
        }
      }
      if (!stopped) timer = setTimeout(poll, TREE_EVERY_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);
  return tree;
}

/** This browser's own node in the tree: its PeerId, hashed as the server hashes it. */
export function useOwnKey(peer: string | null): string | null {
  const [key, setKey] = useState<{ peer: string; key: string } | null>(null);
  useEffect(() => {
    if (!peer) return;
    let stale = false;
    void import("@/lib/live/tree").then(({ viewKey }) =>
      viewKey(peer).then((k) => {
        if (!stale) setKey({ peer, key: k });
      }),
    );
    return () => {
      stale = true;
    };
  }, [peer]);
  return peer && key?.peer === peer ? key.key : null;
}

/** A card in the Live pages' language: the app's surface, a hairline border, generous corners. */
export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-3xl bg-surface p-5 ring-1 ring-border sm:p-6 ${className}`}>{children}</section>;
}
