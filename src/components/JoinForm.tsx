"use client";

import { ArrowRight, Keyboard } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { parseCode } from "@/lib/code";

/** Code-or-link field with a Join button. Shared by the home and not-found screens. */
export function JoinForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const errorId = useId();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  function join(event: React.FormEvent) {
    event.preventDefault();
    const code = parseCode(input);
    if (!code) {
      setError("That doesn't look like a meeting code. Try abc-defg-hij or paste the full link.");
      return;
    }
    router.push(`/${code}`);
  }

  return (
    <form onSubmit={join} className="flex min-w-0 flex-1 flex-col gap-2" noValidate>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Keyboard
            className="pointer-events-none absolute top-1/2 left-4 size-[1.125rem] -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            placeholder="Enter a code or link"
            aria-label="Meeting code or link"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            autoFocus={autoFocus}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="field pl-11"
          />
        </div>
        <button type="submit" className="btn btn-secondary" disabled={!input.trim()}>
          Join
          <ArrowRight className="size-4" aria-hidden="true" />
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="anim-fade px-1 text-sm text-danger-text">
          {error}
        </p>
      )}
    </form>
  );
}
