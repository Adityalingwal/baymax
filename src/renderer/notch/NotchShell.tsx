import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { TaskCard, TaskId } from "../../shared/cards";
import type { VoicePhase } from "../../shared/ipc";
import type { CardActions } from "../actions";
import { Island } from "./Island";
import {
  notchZone,
  openBodyWidth,
  openSilhouette,
  panelShape,
  silhouettePath,
} from "./outline";
import type { OutlineGeometry } from "./outline";
import { RunningRing } from "./RunningRing";
import { useClosedShape } from "./useClosedShape";
import type { ClosedShape } from "./useClosedShape";
import { useShellMotion } from "./useMotion";
import type { Layers } from "./useMotion";
import { usePill } from "./usePill";
import { usePointer } from "./usePointer";
import { useWindowShape } from "./useWindowShape";
import type { WindowGeometry } from "./useWindowShape";
import { isAnswerLine } from "./views";
import { VoicePill } from "./VoicePill";

type NotchShellProps = {
  needsAccess: boolean;
  draft: boolean; // the field holds text, which keeps the panel open when the pointer leaves
  phase: VoicePhase;
  tasks: TaskCard[];
  setMuted: CardActions["setMuted"];
  children: ReactNode;
};

const rowGap = 12;
const sidePadding = 14;

function isTextField(target: EventTarget): target is HTMLElement {
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  );
}

// The content's full height from y = 0, its top padding included.
function useContentHeight(element: HTMLElement | null) {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (element === null) return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [element]);
  return height;
}

function useShapes(frame: WindowGeometry, height: number, closed: ClosedShape) {
  const { width, shape } = frame;
  const { view, shape: collapsed } = closed;
  return useMemo(() => {
    const geometry: OutlineGeometry = {
      width,
      height: frame.height,
      shape,
      contentHeight: height,
    };
    const opened = openSilhouette(geometry);
    const keys = { collapsed, opened, view };
    // Hovering the answer island never opens the panel; only a click on its card does.
    const zones = {
      notch: view === "island" ? null : notchZone(geometry),
      opened: { kind: "path" as const, path: silhouettePath(width, opened) },
    };
    return { keys, zones };
  }, [width, frame.height, shape, height, collapsed, view]);
}

type PanelInput = Pick<NotchShellProps, "needsAccess" | "draft"> & {
  frame: WindowGeometry;
  closed: ClosedShape;
};

// Joins the pointer rules to the motion: the pointer decides open or closed, the motion draws it and reports back.
function usePanel({ needsAccess, draft, frame, closed }: PanelInput) {
  const [content, setContent] = useState<HTMLElement | null>(null);
  const shapes = useShapes(frame, useContentHeight(content), closed);
  const visible = useRef<() => string>(() => "");
  const zones = useMemo(
    () => ({ ...shapes.zones, visible: () => visible.current() }),
    [shapes.zones],
  );
  const pointer = usePointer(zones, {
    needsAccess,
    draft,
    shapeKey: frame.shape,
  });
  const motion = useShellMotion({
    open: pointer.state.open,
    keys: shapes.keys,
    windowWidth: frame.width,
    onFrame: pointer.frameChanged,
    onSettled: (settledOpen) => {
      if (!settledOpen) pointer.dispatch({ kind: "closed" });
    },
  });
  visible.current = motion.visiblePath;
  const contentRef = motion.layers.content;
  const contentElement = useCallback(
    (element: HTMLElement | null) => {
      contentRef.current = element;
      setContent(element);
    },
    [contentRef],
  );
  // Esc closes only from the panel's own field: the window is never active, so other apps' keys never reach it.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !isTextField(event.target)) return;
    pointer.dispatch({ kind: "escape" });
    event.target.blur();
  };
  const { open } = pointer.state;
  const { layers } = motion;
  return {
    open,
    layers,
    contentElement,
    onKeyDown,
    dispatch: pointer.dispatch,
  };
}

// Once the panel is open on a clicked result, that result's card scrolls into view.
function useScrollTo(open: boolean) {
  const [target, setTarget] = useState<TaskId | null>(null);
  useEffect(() => {
    if (!open || target === null) return;
    document
      .getElementById(`card-${target}`)
      ?.scrollIntoView({ block: "nearest" });
    setTarget(null);
  }, [open, target]);
  return setTarget;
}

type ClosedLayersProps = {
  frame: WindowGeometry;
  open: boolean;
  closed: ClosedShape;
  voice: ReturnType<typeof usePill>;
  layers: Layers;
  onMute: () => void;
  onOpenResult: (taskId: TaskId) => void;
};

// What the closed notch draws inside the shape: the running ring, the voice pill's strip and the island's card.
function ClosedLayers(props: ClosedLayersProps) {
  const { frame, open, closed, voice, layers } = props;
  const showing = (view: ClosedShape["view"]) => !open && closed.view === view;
  return (
    <>
      <RunningRing
        count={closed.running}
        shape={frame.shape}
        windowWidth={frame.width}
        ringRef={layers.ring}
      />
      <VoicePill
        pill={voice.pill}
        windowWidth={frame.width}
        interactive={showing("pill") || showing("island")}
        layers={layers}
        onMute={props.onMute}
      />
      <Island
        card={closed.island.card}
        width={closed.island.width}
        windowWidth={frame.width}
        interactive={showing("island")}
        cardRef={layers.card}
        onOpen={props.onOpenResult}
        onSize={closed.onIslandSize}
      />
    </>
  );
}

function Shell(props: NotchShellProps & { frame: WindowGeometry }) {
  const { frame, children, phase, tasks, setMuted } = props;
  const voice = usePill(phase, isAnswerLine(phase, tasks));
  const wide = frame.width - 2 * panelShape.ear;
  const closed = useClosedShape(voice.pill, tasks, {
    shape: frame.shape,
    wide,
  });
  const panel = usePanel({ ...props, closed });
  const { open, layers } = panel;
  const scrollTo = useScrollTo(open);
  const onMute = () => {
    voice.dispatch({ kind: "mute-clicked" });
    setMuted({ muted: true });
  };
  // The explicit open-result event: it ends the island, opens the panel and scrolls to the result.
  const onOpenResult = (taskId: TaskId) => {
    voice.dispatch({ kind: "open-result" });
    panel.dispatch({ kind: "open-result" });
    scrollTo(taskId);
  };
  const bodyWidth = openBodyWidth({ ...frame, contentHeight: 0 });
  return (
    <div
      ref={layers.shape}
      className="fixed inset-0 bg-black text-zinc-100"
      onKeyDown={panel.onKeyDown}
    >
      <ClosedLayers
        {...{ frame, open, closed, voice, layers, onMute, onOpenResult }}
      />
      <main
        ref={panel.contentElement}
        className="panel-type absolute top-0 flex max-h-screen flex-col"
        style={{
          left: (frame.width - bodyWidth) / 2,
          width: bodyWidth,
          gap: rowGap,
          padding: `${panelShape.strip + rowGap}px ${sidePadding}px ${sidePadding}px`,
        }}
        aria-hidden={!open}
        inert={!open}
      >
        {children}
      </main>
    </div>
  );
}

// The one black shape: the bare notch, the running ring, the voice pill, the answer island, or the panel when the pointer rests on the notch.
export function NotchShell(props: NotchShellProps) {
  const frame = useWindowShape();
  if (frame === null) return null;
  return <Shell {...props} frame={frame} />;
}
