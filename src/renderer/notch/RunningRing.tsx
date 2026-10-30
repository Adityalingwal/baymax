import type { RefObject } from "react";
import type { WindowShape } from "../../shared/ipc";
import { ringLayout, ringSilhouette } from "./outline";

// The count mirrors the ring: its centre is as far from the left edge as the ring's is from the right.
const countCentre = ringLayout.edge + ringLayout.size / 2;

type RunningRingProps = {
  count: number;
  shape: WindowShape;
  windowWidth: number;
  ringRef: RefObject<HTMLDivElement | null>;
};

function Count({ count, height }: { count: number; height: number }) {
  return (
    <span
      className="panel-type absolute flex -translate-x-1/2 items-center text-[11px] font-bold"
      style={{
        left: countCentre,
        height,
        color: "rgb(255 255 255 / 75%)",
      }}
    >
      {count}
    </span>
  );
}

// An 11 pt ring in the right wing, a white quarter arc turning once every 1.6 s; with two or more tasks, the count on the left.
export function RunningRing({
  count,
  shape,
  windowWidth,
  ringRef,
}: RunningRingProps) {
  const { width, height } = ringSilhouette(shape);
  return (
    <div
      ref={ringRef}
      aria-hidden="true"
      className="absolute top-0"
      style={{ left: (windowWidth - width) / 2, width, height }}
    >
      {count >= 2 && <Count count={count} height={height} />}
      <svg
        className="absolute"
        style={{ right: ringLayout.edge, top: (height - ringLayout.size) / 2 }}
        width={ringLayout.size}
        height={ringLayout.size}
        viewBox="0 0 11 11"
      >
        <circle
          cx={5.5}
          cy={5.5}
          r={4.7}
          fill="none"
          stroke="rgb(255 255 255 / 22%)"
          strokeWidth={1.6}
        />
        <path
          className="ring-spin"
          d="M5.5,0.8 A4.7,4.7 0 0 1 10.2,5.5"
          fill="none"
          stroke="#fff"
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
