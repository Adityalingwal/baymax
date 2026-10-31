import type { CSSProperties } from "react";
import type { VoicePhase } from "../../shared/ipc";

const barHeights = [2, 3, 4, 5, 4, 3, 4, 5, 4, 3, 2, 3, 4, 5, 3] as const;

const words = {
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
} as const;

type VoiceRailProps = { phase: VoicePhase["phase"]; muted: boolean };

// The voice state under the notch while the panel is open. The bars do not follow real audio.
export function VoiceRail({ phase, muted }: VoiceRailProps) {
  if (phase === "idle") return null;
  const silent = phase === "speaking" && muted;
  return (
    <div
      className="wave-rail-anchor"
      data-state={words[phase]}
      data-muted={silent}
    >
      <div className="wave-rail-pill" role="status" aria-live="polite">
        <span>{silent ? "Muted" : words[phase]}</span>
        <span className="wave-rail-bars" aria-hidden="true">
          {barHeights.map((height, index) => (
            <span
              key={index}
              style={{ "--height": height, "--index": index } as CSSProperties}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
