import type { Metadata } from "next";
import { LiveHost } from "@/components/live/LiveHost";

export const metadata: Metadata = { title: "Serverless webinar (beta) · Meetly" };

export default function GoLivePage() {
  return <LiveHost />;
}
