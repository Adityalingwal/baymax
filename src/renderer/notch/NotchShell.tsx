import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, KeyboardEvent, ReactNode } from "react";
import type { TaskCard, TaskId } from "../../shared/cards";
import type { VoicePhase } from "../../shared/ipc";
import type { CardActions } from "../actions";
import { Island } from "./Island";
import {
  notchZone,
  openSilhouette,
  panelBox,
  panelShape,
  silhouettePath,
} from "./outline";
import type { OutlineGeometry } from "./outline";
import { clickMute } from "./pill";
import { RunningRing } from "./RunningRing";
import type { PanelEvent } from "./shell";
import { useClosedShape } from "./useClosedShape";
import type { ClosedShape } from "./useClosedShape";
import { useShellMotion } from "./useMotion";
import type { Layers } from "./useMotion";
import { usePill } from "./usePill";
import { usePointer } from "./usePointer";
import { useWindowShape } from "./useWindowShape";
import type { WindowGeometry } from "./useWindowShape";
import { islandSpeaks } from "./answer-island";
import type { IslandState } from "./answer-island";
import { useIsland, useIslandFollows } from "./useIsland";
import { islandLayout } from "./views";
import { VoicePill } from "./VoicePill";
import { VoiceRail } from "./VoiceRail";

type NotchShellProps = {
  needsAccess: boolean;
  closeForHold: boolean; // goes true once, on the first hold after setup: the panel closes at once, in spite of needsAccess
  draft: string; // the field's text: with text, the panel closes 3 s after the pointer leaves instead of 300 ms
  phase: VoicePhase;
  tasks: TaskCard[];
  muted: boolean; // main's mute
  setMuted: CardActions["setMuted"];
  openSource: CardActions["openSource"];
  fullReportOpen: boolean; // the panel takes its full-report size
  onOpenResult: () => void; // a click on the answer island's card
  children: (
    closePanel: () => void,
    open: boolean,
    viewClicked: () => void,
  ) => ReactNode;
};

const rowGap = 12;
const sidePadding = 14;

function isTextField(target: EventTarget): target is HTMLElement {
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  );
}

// The content's full height from y = 0, its top padding included.
function useContentHeight(element: HTMLElement | null): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (element === null) return;
    const measure = () => setHeight(element.offsetHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [element]);
  return height;
}

function useShapes(
  frame: WindowGeometry,
  contentHeight: number,
  closed: ClosedShape,
  fullReport: boolean,
) {
  const { width, shape } = frame;
  const { view, shape: collapsed } = closed;
  return useMemo(() => {
    const geometry: OutlineGeometry = {
      width,
      height: frame.height,
      shape,
      contentHeight,
      fullReport,
    };
    const opened = openSilhouette(geometry);
    const keys = { collapsed, opened, view };
    // Hovering the answer island never opens the panel; only a click on its card does.
    const zones = {
      notch:
        view === "island" || view === "report" ? null : notchZone(geometry),
      opened: { kind: "path" as const, path: silhouettePath(width, opened) },
    };
    return { keys, zones };
  }, [width, frame.height, shape, contentHeight, fullReport, collapsed, view]);
}

type PanelInput = Pick<
  NotchShellProps,
  "needsAccess" | "closeForHold" | "draft"
> & {
  frame: WindowGeometry;
  closed: ClosedShape;
  fullReport: boolean;
};

function useCloseForHold(
  closeForHold: boolean,
  dispatch: Dispatch<PanelEvent>,
): void {
  useEffect(() => {
    if (closeForHold) dispatch({ kind: "setup-done" });
  }, [closeForHold, dispatch]);
}

// Joins the pointer rules to the motion: the pointer decides open or closed, the motion draws it and reports back.
function usePanel(input: PanelInput) {
  const { needsAccess, closeForHold, draft, frame, closed, fullReport } = input;
  const [content, setContent] = useState<HTMLElement | null>(null);
  const contentHeight = useContentHeight(content);
  const shapes = useShapes(frame, contentHeight, closed, fullReport);
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
  useCloseForHold(closeForHold, pointer.dispatch);
  const motion = useShellMotion({
    open: pointer.state.open,
    keys: shapes.keys,
    pillClose: closed.pillClose,
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
  return {
    open: pointer.state.open,
    hovering: pointer.state.hovering,
    layers: motion.layers,
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
  island: IslandState;
  openSource: CardActions["openSource"];
  onMute: () => void;
  onOpenResult: (taskId: TaskId) => void;
  onToggleReport: () => void;
};

// What the closed notch draws inside the shape: the running ring, the voice pill's strip and the island's card.
function ClosedLayers(props: ClosedLayersProps) {
  const { frame, open, closed, voice, layers } = props;
  const showing = (view: ClosedShape["view"]) => !open && closed.view === view;
  const onIsland = showing("island") || showing("report");
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
        interactive={showing("pill") || onIsland}
        quiet={props.island.line !== null && !voice.pill.shown}
        layers={layers}
        onMute={props.onMute}
      />
      <Island
        card={closed.island.card}
        width={closed.island.width}
        windowWidth={frame.width}
        windowHeight={frame.height}
        interactive={onIsland}
        reportOpen={props.island.reportOpen}
        cardRef={layers.card}
        onOpen={props.onOpenResult}
        onToggleReport={props.onToggleReport}
        openSource={props.openSource}
        onSize={closed.onIslandSize}
      />
    </>
  );
}

type PanelLayerProps = {
  panel: ReturnType<typeof usePanel>;
  frame: WindowGeometry;
  fullReport: boolean;
  children: NotchShellProps["children"];
};

// The panel's content inside the shape; it hands its children the close control's action.
function PanelLayer(props: PanelLayerProps) {
  const { panel, frame, fullReport, children } = props;
  return (
    <main
      ref={panel.contentElement}
      className="panel-type absolute inset-x-0 top-0 mx-auto flex flex-col"
      style={{
        ...panelBox(frame.height, fullReport, frame.shape.notchWidth),
        gap: rowGap,
        padding: `${panelShape.strip + rowGap}px ${sidePadding}px ${sidePadding}px`,
      }}
      aria-hidden={!panel.open}
      inert={!panel.open}
    >
      {children(
        () => panel.dispatch({ kind: "close-control" }),
        panel.open,
        () => panel.dispatch({ kind: "view-clicked" }),
      )}
    </main>
  );
}

function Shell(props: NotchShellProps & { frame: WindowGeometry }) {
  const { frame, phase, tasks, setMuted } = props;
  const fullReport = props.fullReportOpen;
  const { island, dispatch } = useIsland(tasks);
  const voice = usePill(phase, islandSpeaks(island, phase), props.muted);
  const closed = useClosedShape(voice.pill, island, tasks, {
    shape: frame.shape,
    wide: islandLayout.wideWidth,
  });
  const panel = usePanel({ ...props, closed, fullReport });
  const { open, layers } = panel;
  useIslandFollows(dispatch, panel);
  const scrollTo = useScrollTo(open);
  const onMute = () =>
    clickMute(voice.pill, { dispatch: voice.dispatch, setMuted });
  const onOpenResult = (taskId: TaskId) => {
    panel.dispatch({ kind: "open-result" });
    props.onOpenResult();
    scrollTo(taskId);
  };
  return (
    <div
      ref={layers.shape}
      className="fixed inset-0 bg-black text-zinc-100"
      onKeyDown={panel.onKeyDown}
    >
      <ClosedLayers
        frame={frame}
        open={open}
        closed={closed}
        voice={voice}
        layers={layers}
        island={island}
        onMute={onMute}
        onOpenResult={onOpenResult}
        openSource={props.openSource}
        onToggleReport={() => dispatch({ kind: "toggle-report" })}
      />
      <PanelLayer panel={panel} frame={frame} fullReport={fullReport}>
        {props.children}
      </PanelLayer>
      {open && <VoiceRail phase={phase.phase} muted={props.muted} />}
    </div>
  );
}

// The one black shape: the bare notch, the running ring, the voice pill, the answer island, or the panel when the pointer rests on the notch.
export function NotchShell(props: NotchShellProps) {
  const frame = useWindowShape();
  if (frame === null) return null;
  return <Shell {...props} frame={frame} />;
}
