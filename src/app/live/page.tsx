import type { Metadata } from "next";
import { LiveHost } from "@/components/live/LiveHost";

// No Referer leaves these pages: browsers never put the link's fragment (the key, #k=…) in one,
// and this keeps the rest of the link (the id, the title) to the page too.
export const metadata: Metadata = { title: "Serverless webinar (beta) · Meetly", referrer: "no-referrer" };

export default function GoLivePage() {
  return <LiveHost />;
}
