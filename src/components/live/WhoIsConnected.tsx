"use client";

import type { CSSProperties } from "react";
import { layoutTree, type LiveTree, type PlacedNode } from "@/lib/live/tree";
import { Card } from "./shared";

/** A node's radius, in the drawing's own units. */
const R = 15;
/** Below this many pixels a column, the drawing stops shrinking and scrolls inside the card instead. */
const MIN_COLUMN_PX = 46;

/**
 * "Who's connected": the overlay's tree as the coordinator last heard it, drawn as a graph. The
 * host at the top; each viewer below the browser it gets the stream from, joined to it by a line.
 * Relays are filled, leaves are rings, "You" is ringed in the accent colour. Depth and child count
 * are in each node's tooltip; a relay shows how many it passes the stream on to. Nodes glide to
 * their new place when the tree changes. Plain SVG (layout: `layoutTree` in src/lib/live/tree.ts).
 */
export function WhoIsConnected({ tree, ownKey }: { tree: LiveTree | null; ownKey: string | null }) {
  const layout = layoutTree(tree?.nodes ?? []);
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
        <div className="scroll-quiet -mx-2 overflow-x-auto rounded-2xl bg-bg/40 px-2 py-1" data-testid="live-tree">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="mx-auto block h-auto w-full"
            style={{ minWidth: layout.columns * MIN_COLUMN_PX, maxWidth: layout.width * 1.15 }}
            role="img"
            aria-label={`The stream's tree: ${tree.nodes.map((n) => n.label).join(", ")}`}
          >
            <g>
              {layout.edges.map((edge) => {
                // From below the parent's name (and its "You"), to the top of the child's circle.
                const from = edge.y1 + R + 38;
                const mid = (from + edge.y2 - R) / 2;
                const d = `path("M ${edge.x1} ${from} C ${edge.x1} ${mid}, ${edge.x2} ${mid}, ${edge.x2} ${edge.y2 - R}")`;
                return <path key={edge.key} className="fill-none stroke-border-strong" strokeWidth={1.5} style={{ d, transition: "d var(--dur-slow) var(--ease-move)" } as CSSProperties} />;
              })}
            </g>
            {layout.nodes.map((node) => (
              <Node key={node.key} node={node} own={node.key === ownKey} />
            ))}
          </svg>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
        <Legend>
          <circle cx="7" cy="7" r="5.5" className="fill-accent" />
        </Legend>
        <span className="-ml-3">Host</span>
        <Legend>
          <circle cx="7" cy="7" r="5.5" className="fill-muted" />
        </Legend>
        <span className="-ml-3">Passes it on</span>
        <Legend>
          <circle cx="7" cy="7" r="5" className="fill-surface-3 stroke-muted" strokeWidth={1.5} />
        </Legend>
        <span className="-ml-3">Watches only</span>
      </div>
      <p className="text-xs leading-relaxed text-faint">
        Each viewer gets the stream from the one above it and may pass it on to the ones below. Names are made up for this page.
      </p>
    </Card>
  );
}

function Legend({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 shrink-0" aria-hidden="true">
      {children}
    </svg>
  );
}

function Node({ node, own }: { node: PlacedNode; own: boolean }) {
  const relay = !node.source && node.children > 0;
  const children = `${node.children} ${node.children === 1 ? "child" : "children"}`;
  const depth = node.depth === null ? "depth not known yet" : `depth ${node.depth}`;
  const fill = node.source ? "fill-accent" : relay ? "fill-muted" : "fill-surface-3";
  const stroke = node.waiting ? "stroke-faint" : relay || node.source ? "stroke-transparent" : "stroke-muted";
  return (
    <g
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, transition: "transform var(--dur-slow) var(--ease-move)" }}
      data-testid="tree-node"
      data-label={node.label}
      data-depth={node.depth ?? ""}
      data-children={node.children}
      data-own={own ? "true" : undefined}
    >
      <title>{`${node.label}${own ? " (you)" : ""}: ${node.source ? "the source, " : ""}${node.waiting ? "finding a place, " : ""}${depth}, ${children}`}</title>
      {own && <circle r={R + 5} className="fill-none stroke-accent" strokeWidth={2.5} />}
      <circle r={R} className={`${fill} ${stroke}`} strokeWidth={1.75} strokeDasharray={node.waiting ? "3 3" : undefined} />
      {(node.source || relay) && (
        <text textAnchor="middle" dominantBaseline="central" className={`${node.source ? "fill-accent-ink" : "fill-bg"} text-[11px] font-semibold tabular-nums`}>
          {node.children}
        </text>
      )}
      <text y={R + 15} textAnchor="middle" className={`${own ? "fill-accent" : "fill-text"} text-[11.5px] font-medium`}>
        {node.label}
      </text>
      {own && (
        <text y={R + 29} textAnchor="middle" className="fill-accent text-[10.5px] font-semibold tracking-wide uppercase">
          You
        </text>
      )}
    </g>
  );
}
