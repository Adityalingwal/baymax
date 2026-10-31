import { useLayoutEffect, useRef } from "react";
import type { ReactNode, RefObject, UIEventHandler } from "react";
import { prefersReducedMotion } from "./notch/useMotion";

const centreInset = 33;
const restAfterMs = 1600;
const glideShare = 0.12;
const dragGlideShare = 0.4;
const settledWithin = 0.1;

type PillParts = {
  scroller: HTMLElement;
  content: HTMLElement;
  pill: HTMLElement;
};

function scrollRange(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.clientHeight;
}

function centreTravel(scroller: HTMLElement): number {
  return scroller.clientHeight - 2 * centreInset;
}

function pillCentre(scroller: HTMLElement): number {
  const track = centreTravel(scroller);
  if (track < 0) return scroller.clientHeight / 2;
  const share = scroller.scrollTop / scrollRange(scroller);
  return centreInset + Math.min(1, Math.max(0, share)) * track;
}

// Written straight to the element: a React render per frame would be too slow.
function startGlide(pill: HTMLElement) {
  let shown = 0;
  let target = 0;
  let share = glideShare;
  let frame: number | null = null;
  const write = () => {
    pill.style.top = `${shown}px`;
  };
  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const jump = (top: number) => {
    stop();
    shown = top;
    target = top;
    write();
  };
  const step = () => {
    shown += (target - shown) * share;
    if (Math.abs(target - shown) <= settledWithin) shown = target;
    write();
    frame = shown === target ? null : requestAnimationFrame(step);
  };
  const glideTo = (top: number, nextShare: number) => {
    if (prefersReducedMotion()) {
      jump(top);
      return;
    }
    target = top;
    share = nextShare;
    if (frame === null && shown !== target) {
      frame = requestAnimationFrame(step);
    }
  };
  return { jump, glideTo, stop };
}

function listenForDrag(
  { scroller, pill }: PillParts,
  signal: AbortSignal,
  onDragging: (dragging: boolean) => void,
): void {
  let start: { y: number; scrollTop: number } | null = null;
  const end = () => {
    if (start === null) return;
    start = null;
    onDragging(false);
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pill.setPointerCapture(event.pointerId);
    start = { y: event.clientY, scrollTop: scroller.scrollTop };
    onDragging(true);
  };
  const move = (event: PointerEvent) => {
    if (start === null) return;
    // A release that happened where this window could not see it.
    if (event.buttons === 0) {
      end();
      return;
    }
    const track = centreTravel(scroller);
    if (track <= 0) return;
    const moved = (event.clientY - start.y) / track;
    scroller.scrollTop = start.scrollTop + moved * scrollRange(scroller);
  };
  pill.addEventListener("pointerdown", down, { signal });
  pill.addEventListener("pointermove", move, { signal });
  pill.addEventListener("pointerup", end, { signal });
  pill.addEventListener("pointercancel", end, { signal });
}

type PillLookInput = {
  hovering: boolean;
  dragging: boolean;
  scrolling: boolean;
};

function pillLook({ hovering, dragging, scrolling }: PillLookInput): string {
  if (dragging) return "drag";
  if (hovering) return "hover";
  return scrolling ? "scrolling" : "rest";
}

function startLook(pill: HTMLElement) {
  const now: PillLookInput = {
    hovering: false,
    dragging: false,
    scrolling: false,
  };
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  const set = (change: Partial<PillLookInput>) => {
    Object.assign(now, change);
    pill.dataset.look = pillLook(now);
  };
  const scrolled = () => {
    set({ scrolling: true });
    clearTimeout(restTimer);
    restTimer = setTimeout(() => set({ scrolling: false }), restAfterMs);
  };
  const dragging = () => now.dragging;
  const stop = () => clearTimeout(restTimer);
  return { set, scrolled, dragging, stop };
}

function startPill(parts: PillParts): () => void {
  const { scroller, content, pill } = parts;
  const glide = startGlide(pill);
  const look = startLook(pill);
  let placed = false;
  const place = () => {
    const scrollable = scrollRange(scroller) > 0;
    pill.hidden = !scrollable;
    if (!scrollable) {
      placed = false;
      look.set({ hovering: false });
      return;
    }
    const centre = pillCentre(scroller);
    if (placed) {
      glide.glideTo(centre, look.dragging() ? dragGlideShare : glideShare);
    } else {
      glide.jump(centre);
    }
    placed = true;
  };
  const onScroll = () => {
    // A scroll set while mounting arrives before the first placement, and is not the user scrolling.
    if (!placed) return;
    look.scrolled();
    place();
  };
  const listening = new AbortController();
  const { signal } = listening;
  scroller.addEventListener("scroll", onScroll, { passive: true, signal });
  const hover = (hovering: boolean) => () => look.set({ hovering });
  pill.addEventListener("pointerenter", hover(true), { signal });
  pill.addEventListener("pointerleave", hover(false), { signal });
  listenForDrag(parts, signal, (dragging) => look.set({ dragging }));
  // Its first report comes after every layout effect, so a parent's own scroll position is already set.
  const observer = new ResizeObserver(place);
  observer.observe(scroller);
  observer.observe(content);
  return () => {
    listening.abort();
    observer.disconnect();
    look.stop();
    glide.stop();
  };
}

type PillScrollProps = {
  children: ReactNode;
  ref?: RefObject<HTMLDivElement | null>; // the scrolling element
  onScroll?: UIEventHandler<HTMLDivElement>;
  className?: string; // on the wrapper
  contentClassName?: string; // on the element inside the scroller
  pillRight?: number; // from the content box's right edge
};

// A vertical scroller with the glass pill beside it in place of the native scrollbar. The pill is outside the scroller, or the scroller would clip it.
export function PillScroll(props: PillScrollProps) {
  const { children, ref, onScroll, className = "" } = props;
  const { contentClassName, pillRight = -10 } = props;
  const ownScroller = useRef<HTMLDivElement>(null);
  const scroller = ref ?? ownScroller;
  const content = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (
      scroller.current === null ||
      content.current === null ||
      pill.current === null
    )
      return;
    return startPill({
      scroller: scroller.current,
      content: content.current,
      pill: pill.current,
    });
  }, [scroller]);
  return (
    <div className={`relative flex min-h-0 shrink flex-col ${className}`}>
      <div
        ref={scroller}
        className="pill-scroller min-h-0 overflow-y-auto"
        onScroll={onScroll}
      >
        <div ref={content} className={contentClassName}>
          {children}
        </div>
      </div>
      <div
        ref={pill}
        className="scroll-pill"
        style={{ right: pillRight }}
        aria-hidden="true"
        hidden
      />
    </div>
  );
}
