import type { Metadata } from "next";
import { LiveHost } from "@/components/live/LiveHost";

export const metadata: Metadata = { title: "Go live (beta) · Meetly" };

export default function GoLivePage() {
  return <LiveHost />;
}
