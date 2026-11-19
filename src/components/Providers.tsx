"use client";

import { TooltipProvider } from "@radix-ui/react-tooltip";
import { Toaster } from "./ui/Toaster";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={200} disableHoverableContent>
      <Toaster>{children}</Toaster>
    </TooltipProvider>
  );
}
