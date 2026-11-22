import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { LiveViewer } from "@/components/live/LiveViewer";
import { LiveHeader } from "@/components/live/shared";
import { isValidCode } from "@/lib/code";

export const metadata: Metadata = { title: "Live stream (beta) · Meetly" };

export default function LiveStreamPage(props: PageProps<"/live/[id]">) {
  // The id is only known at request time, so the viewer renders inside Suspense.
  return (
    <Suspense
      fallback={
        <div className="backdrop-glow flex flex-1 flex-col">
          <LiveHeader />
        </div>
      }
    >
      <LiveStream params={props.params} />
    </Suspense>
  );
}

async function LiveStream({ params }: { params: PageProps<"/live/[id]">["params"] }) {
  const { id } = await params;
  if (!isValidCode(id)) notFound();
  return <LiveViewer id={id} />;
}
