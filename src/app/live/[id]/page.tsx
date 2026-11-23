import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { LiveViewer } from "@/components/live/LiveViewer";
import { LiveHeader } from "@/components/live/shared";
import { isValidCode } from "@/lib/code";
import { verifiedTitle } from "@/lib/live/title.server";

// No Referer leaves these pages: browsers never put the link's fragment (the key, #k=…) in one,
// and this keeps the rest of the link (the id, the title) to the page too.
export const metadata: Metadata = { title: "Serverless webinar (beta) · Meetly", referrer: "no-referrer" };

export default function LiveStreamPage(props: PageProps<"/live/[id]">) {
  // The id is only known at request time, so the viewer renders inside Suspense.
  return (
    <Suspense
      fallback={
        <div className="backdrop-glow flex flex-1 flex-col">
          <LiveHeader narrow />
        </div>
      }
    >
      <LiveStream params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

async function LiveStream({ params, searchParams }: { params: PageProps<"/live/[id]">["params"]; searchParams: PageProps<"/live/[id]">["searchParams"] }) {
  const { id } = await params;
  if (!isValidCode(id)) notFound();
  // The title travels in the link (`?title=…&ts=…`), since Meetly stores nothing about a webinar,
  // and is shown only when its signature is the server's.
  const { title, ts } = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return <LiveViewer id={id} title={await verifiedTitle(id, first(title), first(ts))} />;
}
