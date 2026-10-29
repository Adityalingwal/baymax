import type { RefObject } from "react";
import type { PillState } from "./pill";

// Sizes from the locked design: notch-design-locked.md, "Voice pill".
export const pillShape = { width: 360, height: 32, ear: 6, rx: 24, ry: 26 };

type VoicePillProps = {
  pill: PillState;
  windowWidth: number;
  interactive: boolean;
  wordRef: RefObject<HTMLDivElement | null>;
  rimRef: RefObject<SVGSVGElement | null>;
  onMute: () => void;
};

const { width, height } = pillShape;
// The corner lines, as in the locked preview: from under the ear, round the corner, then along the bottom.
// The paths are keyed by the pill's opening, so they draw in once per opening; the svg stays, keeping its opacity.
const rimLines = [
  { id: "left", path: `M1,6 V8 Q1,${height - 1} 25,${height - 1} H79`, x2: 79 },
  {
    id: "right",
    path: `M${width - 1},6 V8 Q${width - 1},${height - 1} ${width - 25},${height - 1} H${width - 79}`,
    x2: width - 79,
  },
];

function Rim({
  session,
  rimRef,
}: {
  session: number;
  rimRef: VoicePillProps["rimRef"];
}) {
  return (
    <svg
      ref={rimRef}
      aria-hidden="true"
      className="absolute inset-0 overflow-visible"
      width={width}
      height={height}
    >
      {rimLines.map(({ id, path, x2 }) => (
        <g key={id}>
          <linearGradient
            id={`pill-rim-${id}`}
            gradientUnits="userSpaceOnUse"
            x1={id === "left" ? 1 : width - 1}
            x2={x2}
            y1={0}
            y2={0}
          >
            <stop offset="0" stopColor="#fff" stopOpacity={0.95} />
            <stop offset="0.35" stopColor="#fff" stopOpacity={0.95} />
            <stop offset="1" stopColor="#fff" stopOpacity={0} />
          </linearGradient>
          <path
            key={session}
            className="pill-rim-draw"
            d={path}
            pathLength={1}
            fill="none"
            stroke={`url(#pill-rim-${id})`}
            strokeWidth={2}
            strokeLinecap="round"
          />
        </g>
      ))}
    </svg>
  );
}

function SpeakerIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true">
      <path d="M1.5 4.5h2l3-2.5v8l-3-2.5h-2z" fill="#fff" />
      {crossed ? (
        <path
          d="M8.5 4.5l3 3m0-3l-3 3"
          stroke="#fff"
          strokeWidth={1.2}
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M8.5 4.2a2.5 2.5 0 0 1 0 3.6"
          stroke="#fff"
          strokeWidth={1.2}
          fill="none"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

// Both labels share one grid cell, so swapping them moves nothing.
function Word({ pill }: { pill: PillState }) {
  const thinking = pill.word === "Thinking" && !pill.muted;
  return (
    <span className="absolute top-0 left-5 grid h-8 items-center text-[12.5px] font-semibold text-[#F5F5F7]">
      <span
        className={`pill-label col-start-1 row-start-1 ${pill.muted ? "pill-label-out" : ""} ${thinking ? "pill-shimmer" : ""}`}
      >
        {pill.word}
      </span>
      <span
        className={`pill-label col-start-1 row-start-1 ${pill.muted ? "" : "pill-label-out"}`}
      >
        Muted
      </span>
    </span>
  );
}

// The closed-panel voice pill: the state word on the left, mute on the right while Baymax speaks, the corner lines.
export function VoicePill(props: VoicePillProps) {
  const { pill, windowWidth, interactive, wordRef, rimRef, onMute } = props;
  const speaking = pill.word === "Speaking" || pill.muted;
  return (
    <div
      className="absolute top-0"
      style={{ left: (windowWidth - width) / 2, width, height }}
      aria-hidden={!interactive}
      inert={!interactive}
    >
      <Rim session={pill.session} rimRef={rimRef} />
      <div ref={wordRef} className="absolute inset-0" aria-live="polite">
        <Word pill={pill} />
        {speaking && (
          <button
            type="button"
            aria-label={pill.muted ? "Muted" : "Mute Baymax"}
            aria-disabled={pill.muted}
            className="absolute top-[5px] right-5 grid h-[22px] w-[22px] cursor-pointer place-items-center rounded-full bg-[#1C1C1E]"
            onClick={() => {
              if (!pill.muted) onMute();
            }}
          >
            <span
              className={`pill-label col-start-1 row-start-1 ${pill.muted ? "pill-label-out" : ""}`}
            >
              <SpeakerIcon crossed={false} />
            </span>
            <span
              className={`pill-label col-start-1 row-start-1 ${pill.muted ? "" : "pill-label-out"}`}
            >
              <SpeakerIcon crossed />
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
