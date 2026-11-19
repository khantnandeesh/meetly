import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { JoinForm } from "@/components/JoinForm";
import { Logo } from "@/components/ui/Logo";

export default function NotFound() {
  return (
    <div className="backdrop-glow flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-6xl px-5 py-5 sm:px-8">
        <Logo />
      </header>
      <main className="anim-rise mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-8 px-5 pb-24">
        <p
          className="font-mono text-[clamp(1.75rem,8vw,2.75rem)] font-medium tracking-tight text-surface-3"
          aria-hidden="true"
        >
          <span className="text-border-strong">abc</span>-<span className="text-danger-text">????</span>-
          <span className="text-border-strong">hij</span>
        </p>
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            That meeting link doesn&apos;t look right
          </h1>
          <p className="text-lg leading-relaxed text-muted">
            Meeting codes are ten letters, like <span className="font-mono text-[0.9em] text-text">abc-defg-hij</span>.
            Check the link you were sent, or enter the code again.
          </p>
        </div>
        <div className="flex">
          <JoinForm autoFocus />
        </div>
        <Link href="/" className="inline-flex min-h-11 items-center gap-2 self-start rounded-lg text-sm font-medium text-muted hover:text-text">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to home
        </Link>
      </main>
    </div>
  );
}
