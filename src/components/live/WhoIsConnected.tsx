"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState, type CSSProperties } from "react";
import { audience, layoutTree, type LiveTree, type PlacedNode } from "@/lib/live/tree";
import { Card } from "./shared";

/** A node's radius, in the drawing's own units. */
const R = 15;
/** The "You" ring's extra radius: labels under one move down by it. */
const OWN_RING = 5;
/** Below this many pixels a column, the drawing stops shrinking and scrolls inside the card instead. */
const MIN_COLUMN_PX = 46;

/**
 * "Who’s connected": the overlay's tree as the coordinator last heard it, drawn as a graph. The
 * host at the top; each viewer below the browser it gets the video from, joined to it by a line.
 * Relays are filled, leaves are rings, viewers still connecting are dashed rings on a row of their
 * own, "You" is ringed in the accent colour. The number in a filled node is how many browsers it
 * sends the video to. The same facts are listed for screen readers, since the drawing's tooltips
 * reach only a mouse. Nodes glide to their new place when the tree changes. Plain SVG (layout:
 * `layoutTree` in src/lib/live/tree.ts).
 *
 * `collapsible`: folded behind its heading until opened. A viewer's page keeps it that way under
 * the video: it explains how the video arrives; it is not the show.
 */
export function WhoIsConnected({ tree, ownKey, collapsible = false }: { tree: LiveTree | null; ownKey: string | null; collapsible?: boolean }) {
  const [open, setOpen] = useState(!collapsible);
  const body = useId();
  const { watching, connecting } = audience(tree);
  const count = tree && tree.nodes.length > 0 && (
    <span className="text-sm whitespace-nowrap text-muted tabular-nums" data-testid="tree-count">
      {watching} watching
      {connecting > 0 && ` · ${connecting} connecting`}
    </span>
  );
  return (
    <Card className="flex min-w-0 flex-col gap-4">
      {collapsible ? (
        <h2 className="-my-2">
          <button
            type="button"
            className="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-center justify-between gap-3 rounded-xl px-2 py-2 text-left hover:bg-surface-2"
            aria-expanded={open}
            aria-controls={body}
            onClick={() => setOpen((was) => !was)}
          >
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="font-display text-lg font-semibold tracking-tight whitespace-nowrap">Who’s connected</span>
              {count}
            </span>
            <ChevronDown className={`size-5 shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>
        </h2>
      ) : (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h2 className="font-display text-lg font-semibold tracking-tight whitespace-nowrap">Who’s connected</h2>
          {count}
        </div>
      )}
      {open && (
        <div id={body} className="flex min-w-0 flex-col gap-4">
          <TreeBody tree={tree} ownKey={ownKey} />
        </div>
      )}
    </Card>
  );
}

function TreeBody({ tree, ownKey }: { tree: LiveTree | null; ownKey: string | null }) {
  if (!tree) return <p className="text-sm text-muted">Loading…</p>;
  if (tree.nodes.length === 0)
    return (
      <p className="text-sm text-muted" data-testid="tree-empty">
        {tree.ended ? "The webinar has ended." : "Shows who passes the video to whom, once live."}
      </p>
    );
  const layout = layoutTree(tree.nodes);
  const anyWaiting = layout.nodes.some((node) => node.waiting);
  const labels = new Map(layout.nodes.map((node) => [node.key, node.label]));
  return (
    <>
      <div className="scroll-quiet -mx-2 overflow-x-auto rounded-2xl bg-bg/40 px-2 py-1" data-testid="live-tree">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height + OWN_RING}`}
          className="mx-auto block h-auto w-full"
          style={{ minWidth: layout.columns * MIN_COLUMN_PX, maxWidth: layout.width * 1.15 }}
          aria-hidden="true"
        >
          <g>
            {layout.edges.map((edge) => {
              // From below the parent's name (and its "You"), to the top of the child's circle.
              // An edge's key is "<parent key>-<child key>" (keys are hex).
              const from = edge.y1 + R + 38 + (edge.key.split("-")[0] === ownKey ? OWN_RING : 0);
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
      <ul className="sr-only" aria-label="Who gets the video from whom">
        {layout.nodes.map((node) => (
          <li key={node.key}>
            {node.label}
            {node.key === ownKey ? " (you)" : ""}:{" "}
            {node.source
              ? `the host, sending to ${node.children}`
              : node.waiting
                ? "connecting"
                : `gets the video from ${labels.get(node.parent ?? "") ?? "another browser"}${node.children > 0 ? `, passes it on to ${node.children}` : ""}`}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted" aria-hidden="true">
        <LegendItem label="Host">
          <circle cx="7" cy="7" r="5.5" className="fill-accent" />
        </LegendItem>
        <LegendItem label="Passes it on">
          <circle cx="7" cy="7" r="5.5" className="fill-muted" />
        </LegendItem>
        <LegendItem label="Watches only">
          <circle cx="7" cy="7" r="5" className="fill-surface-3 stroke-muted" strokeWidth={1.5} />
        </LegendItem>
        {anyWaiting && (
          <LegendItem label="Connecting">
            <circle cx="7" cy="7" r="5" className="fill-surface-3 stroke-faint" strokeWidth={1.5} strokeDasharray="2 2" />
          </LegendItem>
        )}
      </div>
      <p className="text-xs leading-relaxed text-faint">
        The number is how many browsers each one sends to. Names are made up.
      </p>
    </>
  );
}

function LegendItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg viewBox="0 0 14 14" className="size-3.5 shrink-0">
        {children}
      </svg>
      {label}
    </span>
  );
}

function Node({ node, own }: { node: PlacedNode; own: boolean }) {
  const relay = !node.source && node.children > 0;
  const depth = node.depth === null ? "depth not known yet" : `depth ${node.depth}`;
  const fill = node.source ? "fill-accent" : relay ? "fill-muted" : "fill-surface-3";
  const stroke = node.waiting ? "stroke-faint" : relay || node.source ? "stroke-transparent" : "stroke-muted";
  const below = own ? OWN_RING : 0;
  return (
    <g
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, transition: "transform var(--dur-slow) var(--ease-move)" }}
      data-testid="tree-node"
      data-label={node.label}
      data-depth={node.depth ?? ""}
      data-children={node.children}
      data-own={own ? "true" : undefined}
    >
      <title>{`${node.label}${own ? " (you)" : ""}: ${node.source ? "the host, " : ""}${node.waiting ? "connecting, " : ""}${depth}, sends to ${node.children}`}</title>
      {own && <circle r={R + OWN_RING} className="fill-none stroke-accent" strokeWidth={2.5} />}
      <circle r={R} className={`${fill} ${stroke}`} strokeWidth={1.75} strokeDasharray={node.waiting ? "3 3" : undefined} />
      {(node.source || relay) && (
        <text textAnchor="middle" dominantBaseline="central" className={`${node.source ? "fill-accent-ink" : "fill-bg"} text-[11px] font-semibold tabular-nums`}>
          {node.children}
        </text>
      )}
      <text y={R + 15 + below} textAnchor="middle" className={`${own ? "fill-accent" : "fill-text"} text-[11.5px] font-medium`}>
        {node.label}
      </text>
      {own && (
        <text y={R + 29 + below} textAnchor="middle" className="fill-accent text-[10.5px] font-semibold tracking-wide uppercase">
          You
        </text>
      )}
    </g>
  );
}
