import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Meeting } from "@/components/Meeting";
import { PreJoinSkeleton } from "@/components/PreJoin";
import { isValidCode } from "@/lib/code";

type Params = PageProps<"/[code]">["params"];

export async function generateMetadata(props: PageProps<"/[code]">): Promise<Metadata> {
  const { code } = await props.params;
  return { title: `${code} · Meetly` };
}

export default function MeetingPage(props: PageProps<"/[code]">) {
  // The code is only known at request time, so the room renders inside Suspense.
  return (
    <Suspense fallback={<PreJoinSkeleton />}>
      <MeetingForCode params={props.params} />
    </Suspense>
  );
}

async function MeetingForCode({ params }: { params: Params }) {
  const { code } = await params;
  if (!isValidCode(code)) notFound();
  return <Meeting code={code} />;
}
