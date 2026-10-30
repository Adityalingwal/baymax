import type { RefObject } from "react";
import { pillShape, rimLine } from "./outline";
import type { PillState } from "./pill";

const rimBox = { width: 80, height: pillShape.height };

export type VoiceLayers = {
  voice: RefObject<HTMLDivElement | null>; // sized to the drawn shape each frame, so the word and mute follow its edges
  word: RefObject<HTMLDivElement | null>;
  rim: RefObject<HTMLDivElement | null>;
};

type VoicePillProps = {
  pill: PillState;
  windowWidth: number;
  interactive: boolean;
  layers: VoiceLayers;
  onMute: () => void;
};

// One corner line; its path is keyed by the pill's opening, so it draws in once per opening.
function Corner({
  side,
  session,
}: {
  side: "left" | "right";
  session: number;
}) {
  const { x, end, path } = rimLine(side, rimBox.width);
  return (
    <svg
      aria-hidden="true"
      className={`absolute bottom-0 overflow-visible ${side === "left" ? "left-0" : "right-0"}`}
      width={rimBox.width}
      height={rimBox.height}
    >
      <linearGradient
        id={`pill-rim-${side}`}
        gradientUnits="userSpaceOnUse"
        x1={x}
        x2={end}
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
        stroke={`url(#pill-rim-${side})`}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SpeakerIcon({ crossed }: { crossed: boolean }) {
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

const labelClass = (shows: boolean) =>
  `pill-label col-start-1 row-start-1 ${shows ? "" : "pill-label-out"}`;

// All labels share one grid cell, so swapping them moves nothing.
function Word({ pill }: { pill: PillState }) {
  const { clearLabel, word } = pill;
  const thinking = word === "Thinking" && clearLabel === null;
  return (
    <span className="absolute top-0 left-5 grid h-8 items-center text-[12.5px] font-semibold text-[#F5F5F7]">
      <span
        className={`${labelClass(clearLabel === null)} ${thinking ? "shimmer" : ""}`}
      >
        {word}
      </span>
      <span className={labelClass(clearLabel === "Muted")}>Muted</span>
      <span className={labelClass(clearLabel === "Unmuted")}>Unmuted</span>
    </span>
  );
}

function MuteButton({ pill, onMute }: Pick<VoicePillProps, "pill" | "onMute">) {
  const crossed = pill.clearLabel === "Muted";
  return (
    <button
      type="button"
      aria-label={crossed ? "Unmute Baymax" : "Mute Baymax"}
      aria-pressed={crossed}
      className="absolute top-[5px] right-5 grid h-[22px] w-[22px] cursor-pointer place-items-center rounded-full bg-[#1C1C1E]"
      onClick={onMute}
    >
      <span className={labelClass(!crossed)}>
        <SpeakerIcon crossed={false} />
      </span>
      <span className={labelClass(crossed)}>
        <SpeakerIcon crossed />
      </span>
    </button>
  );
}

// The voice pill's strip: the state word on the left, mute on the right while Baymax speaks, the corner lines.
// It is also the answer island's top strip.
export function VoicePill(props: VoicePillProps) {
  const { pill, windowWidth, interactive, layers, onMute } = props;
  const speaking = pill.word === "Speaking" || pill.clearLabel !== null;
  const { width, height } = pillShape;
  return (
    <div
      ref={layers.voice}
      className="absolute top-0"
      style={{ left: (windowWidth - width) / 2, width, height }}
      aria-hidden={!interactive}
      inert={!interactive}
    >
      <div ref={layers.rim} className="absolute inset-0">
        <Corner side="left" session={pill.session} />
        <Corner side="right" session={pill.session} />
      </div>
      <div ref={layers.word} className="absolute inset-0" aria-live="polite">
        <Word pill={pill} />
        {speaking && <MuteButton pill={pill} onMute={onMute} />}
      </div>
    </div>
  );
}
