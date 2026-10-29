import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { VoicePhase } from "../../shared/ipc";
import type { CardActions } from "../actions";
import {
  notchSilhouette,
  notchZone,
  openBodyWidth,
  openSilhouette,
  panelShape,
  silhouettePath,
} from "./outline";
import type { OutlineGeometry } from "./outline";
import type { PillState } from "./pill";
import { useShellMotion } from "./useMotion";
import { usePill } from "./usePill";
import { usePointer } from "./usePointer";
import { useWindowShape } from "./useWindowShape";
import type { WindowGeometry } from "./useWindowShape";
import { pillShape, VoicePill } from "./VoicePill";

type NotchShellProps = {
  needsAccess: boolean;
  draft: boolean; // the field holds text, which keeps the panel open when the pointer leaves
  phase: VoicePhase;
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

function useShapes(
  frame: WindowGeometry,
  contentHeight: number,
  pill: boolean,
) {
  const { width, height, shape } = frame;
  return useMemo(() => {
    const geometry: OutlineGeometry = { width, height, shape, contentHeight };
    const opened = openSilhouette(geometry);
    const notch = notchSilhouette(shape);
    const collapsed = pill ? pillShape : notch;
    const keys = { collapsed, opened, pill };
    const zones = {
      notch: notchZone(geometry),
      opened: { kind: "path" as const, path: silhouettePath(width, opened) },
    };
    return { geometry, keys, notch, zones };
  }, [width, height, shape, contentHeight, pill]);
}

type PanelInput = Omit<NotchShellProps, "children" | "phase" | "setMuted"> & {
  frame: WindowGeometry;
  pill: PillState;
};

// Joins the pointer rules to the motion: the pointer decides open or closed, the motion draws it and reports back.
function usePanel({ needsAccess, draft, frame, pill }: PanelInput) {
  const [content, setContent] = useState<HTMLElement | null>(null);
  const shapes = useShapes(frame, useContentHeight(content), pill.shown);
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
  const { open } = pointer.state;
  const motion = useShellMotion({
    open,
    keys: shapes.keys,
    notch: shapes.notch,
    pill: pillShape,
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
  const bodyWidth = openBodyWidth(shapes.geometry);
  return { open, layers: motion.layers, contentElement, onKeyDown, bodyWidth };
}

function Shell(props: NotchShellProps & { frame: WindowGeometry }) {
  const { frame, children, phase, setMuted } = props;
  const { pill, dispatch } = usePill(phase);
  const panel = usePanel({ ...props, pill });
  const { open, layers, bodyWidth } = panel;
  const mute = () => {
    dispatch({ kind: "mute-clicked" });
    setMuted({ muted: true });
  };
  return (
    <div
      ref={layers.shape}
      className="fixed inset-0 bg-black text-zinc-100"
      onKeyDown={panel.onKeyDown}
    >
      <VoicePill
        pill={pill}
        windowWidth={frame.width}
        interactive={!open && pill.shown}
        wordRef={layers.word}
        rimRef={layers.rim}
        onMute={mute}
      />
      <main
        ref={panel.contentElement}
        className="absolute top-0 flex max-h-screen flex-col"
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

// The one black shape: the bare notch, the voice pill, or the panel when the pointer rests on the notch.
export function NotchShell(props: NotchShellProps) {
  const frame = useWindowShape();
  if (frame === null) return null;
  return <Shell {...props} frame={frame} />;
}
