import { useEffect, useRef, useState } from "react";
import { ArrowRight, Download } from "../ui/icons.tsx";
import { buttonClass } from "../ui/Button.tsx";
import chapters from "./video-chapters.json";

function timestamp(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export default function VideoPage() {
  const player = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [position, setPosition] = useState(0);
  const active = chapters.findLast((chapter) => position >= chapter.start);

  useEffect(() => {
    document.title = "CLAUSE walkthrough · Ola";
    return () => { document.title = "CLAUSE"; };
  }, []);

  function jump(seconds: number) {
    if (!player.current || state !== "ready") return;
    player.current.currentTime = seconds;
    setPosition(seconds);
    player.current.focus();
  }

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <a href="/#/" className="flex min-h-11 items-center gap-2 text-lg font-semibold" aria-label="CLAUSE workspace">
            <span className="grid size-8 place-items-center rounded-lg bg-ink text-paper" aria-hidden>C</span>
            CLAUSE
          </a>
          <a href="/#/" className={`${buttonClass({ variant: "secondary" })} min-h-11`}>Open the app <ArrowRight size={16} aria-hidden /></a>
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] px-5 pb-[max(32px,env(safe-area-inset-bottom))] pt-7 sm:px-8 sm:pt-10">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold sm:text-3xl">CLAUSE walkthrough</h1>
            <p className="mt-1 text-sm text-muted">Ola walks through a contract change, from request to saved revision.</p>
          </div>
          <span className="tnum text-sm text-muted">8 min 50 sec</span>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_264px]">
          <section aria-label="Walkthrough video" className="min-w-0">
            <div className="overflow-hidden rounded-2xl bg-black shadow-soft">
              <video
                ref={player}
                src="/video/walkthrough.mp4"
                controls
                playsInline
                preload="metadata"
                poster="/video/poster.jpg"
                aria-label="CLAUSE product and engineering walkthrough, narrated by Ola"
                className="aspect-video w-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                onLoadedMetadata={() => setState("ready")}
                onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
                onError={() => setState("error")}
              >
                <track kind="captions" src="/video/captions.vtt" srcLang="en" label="English" />
                Your browser cannot play this video. <a href="/video/walkthrough.mp4">Download the walkthrough.</a>
              </video>
            </div>
            {state === "error" && (
              <div role="alert" className="mt-4 rounded-control border border-line-strong bg-paper p-4">
                <p>The video couldn’t load. Check your connection and try again.</p>
                <button type="button" className={`${buttonClass()} mt-3`} onClick={() => { setState("loading"); player.current?.load(); }}>Retry video</button>
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
              <a href="/video/walkthrough.mp4" download className="inline-flex min-h-11 items-center gap-2 text-accent hover:underline"><Download size={16} aria-hidden /> Download video</a>
              <a href="/video/transcript.txt" className="inline-flex min-h-11 items-center text-accent hover:underline">Read transcript</a>
              <a href="https://github.com/olanotolu/clause-take-home" className="inline-flex min-h-11 items-center text-accent hover:underline">View the code <ArrowRight size={14} className="ml-1" aria-hidden /></a>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">Fictional contract data. AI-generated narration using Ola’s voice. Recorded against release b7ff832.</p>
          </section>

          <nav aria-label="Video chapters" className="rounded-2xl border border-line bg-paper p-3">
            <h2 className="px-3 pb-2 pt-1 text-sm font-semibold">In this walkthrough</h2>
            <ol className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
              {chapters.map((chapter) => (
                <li key={chapter.start}>
                  <button
                    type="button"
                    onClick={() => jump(chapter.start)}
                    disabled={state !== "ready"}
                    aria-current={active?.start === chapter.start ? "step" : undefined}
                    aria-label={`Jump to ${chapter.title} at ${timestamp(chapter.start)}`}
                    className="group flex min-h-11 w-full items-center gap-3 rounded-control px-3 py-2 text-left text-sm transition-colors hover:bg-canvas disabled:cursor-wait disabled:opacity-50 aria-current:bg-accent-soft aria-current:text-accent"
                  >
                    <span className="tnum w-9 shrink-0 text-xs text-muted">{timestamp(chapter.start)}</span>
                    <span className="flex-1">{chapter.title}</span>
                    <ArrowRight size={13} className="shrink-0 opacity-0 group-hover:opacity-100" aria-hidden />
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </main>
    </div>
  );
}
