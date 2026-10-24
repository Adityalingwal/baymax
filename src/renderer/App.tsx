import { useEffect, useState } from "react";
import type { HoldState } from "../shared/ipc";

function AccessibilityHint() {
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-xs text-amber-700">
        Grant Accessibility access to the running app, then restart. During{" "}
        <code>npm start</code> macOS may list it as Electron; packaged builds
        show Baymax.
      </p>
      <button
        className="rounded bg-slate-800 px-3 py-1 text-xs text-white"
        onClick={() => window.baymax.openAccessibilitySettings()}
      >
        Open Accessibility settings
      </button>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<HoldState>("idle");
  const [accessibility, setAccessibility] = useState<boolean | null>(null);
  const [holdKeyLabel, setHoldKeyLabel] = useState<string>("");

  useEffect(() => {
    const unsubscribe = window.baymax.onHoldState(setState);
    window.baymax
      .getStartupInfo()
      .then((info) => {
        setAccessibility(info.accessibility);
        setHoldKeyLabel(info.holdKeyLabel);
      })
      .catch((error: unknown) => {
        console.error("[Renderer] Failed to get startup info:", error);
      });
    return unsubscribe;
  }, []);

  const listening = state === "listening";

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-1 p-2 text-center">
      <h1
        className={
          listening
            ? "text-2xl font-semibold text-emerald-600"
            : "text-2xl font-semibold text-slate-500"
        }
      >
        {listening ? "Listening…" : "Idle"}
      </h1>
      {holdKeyLabel && (
        <p className="text-sm text-slate-500">
          Hold {holdKeyLabel} to talk, release to stop.
        </p>
      )}
      {accessibility === false && <AccessibilityHint />}
    </main>
  );
}
