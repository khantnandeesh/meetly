"use client";

import { branches, type LiveBranch, type LiveNode, type LiveTree } from "@/lib/live/tree";
import { Card } from "./shared";

/**
 * "Who's connected": the overlay's tree as the coordinator last heard it. The host at the top,
 * each viewer under the browser it gets the stream from, with its depth and how many it passes
 * the stream on to. Plain nested lists; the connecting lines are their borders.
 */
export function WhoIsConnected({ tree, ownKey }: { tree: LiveTree | null; ownKey: string | null }) {
  const { roots, waiting } = branches(tree?.nodes ?? []);
  return (
    <Card className="flex min-w-0 flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg font-semibold tracking-tight">Who&apos;s connected</h2>
        {tree && (
          <span className="text-sm text-muted tabular-nums" data-testid="tree-count">
            {tree.viewers} of {tree.cap} viewers
          </span>
        )}
      </div>
      {!tree ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : tree.nodes.length === 0 ? (
        <p className="text-sm text-muted">{tree.ended ? "The stream has ended." : "Nobody is connected yet."}</p>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1" data-testid="live-tree">
          <ul className="flex flex-col gap-1.5">
            {roots.map((node) => (
              <Branch key={node.key} node={node} ownKey={ownKey} />
            ))}
          </ul>
          {waiting.length > 0 && (
            <div className="mt-4 flex flex-col gap-1.5">
              <p className="eyebrow">Finding a place</p>
              <ul className="flex flex-col gap-1.5">
                {waiting.map((node) => (
                  <li key={node.key}>
                    <Row node={node} ownKey={ownKey} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <p className="text-xs leading-relaxed text-faint">
        Each viewer gets the stream from the browser above it and may pass it on to the ones below. Names are made up for this page.
      </p>
    </Card>
  );
}

function Branch({ node, ownKey }: { node: LiveBranch; ownKey: string | null }) {
  return (
    <li className="flex flex-col gap-1.5">
      <Row node={node} ownKey={ownKey} />
      {node.below.length > 0 && (
        <ul className="ml-3 flex flex-col gap-1.5 border-l border-border-strong pl-3 sm:ml-4 sm:pl-4">
          {node.below.map((child) => (
            <Branch key={child.key} node={child} ownKey={ownKey} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Row({ node, ownKey }: { node: LiveNode; ownKey: string | null }) {
  const own = node.key === ownKey;
  const children = `${node.children} ${node.children === 1 ? "child" : "children"}`;
  return (
    <div
      className={`flex min-h-11 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-xl px-3 py-2 ${own ? "bg-surface-3 ring-1 ring-accent/50 ring-inset" : "bg-surface-2"}`}
      data-testid="tree-node"
      data-label={node.label}
      data-depth={node.depth ?? ""}
      data-children={node.children}
      data-own={own ? "true" : undefined}
    >
      <span className={`size-2 shrink-0 rounded-full ${node.source ? "bg-accent" : "bg-muted"}`} aria-hidden="true" />
      <span className="font-medium">{node.label}</span>
      {own && <span className="rounded-md bg-accent px-1.5 text-xs leading-5 font-semibold text-accent-ink">You</span>}
      <span className="ml-auto text-xs text-muted tabular-nums">
        {node.source ? "Source · " : ""}
        {node.depth === null ? "Depth …" : `Depth ${node.depth}`} · {children}
      </span>
    </div>
  );
}
