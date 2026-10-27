import { useEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, ReactNode } from "react";
import type { DisplayState } from "../../shared/cards";
import type { HoldState } from "../../shared/ipc";
import type { CardActions } from "../actions";
import { dotColors } from "../cards/CardFrame";
import { dotButtonRect, shellOutline } from "./outline";
import type { OutlineGeometry } from "./outline";
import { lastFoldedCard } from "./shell";
import { usePointer } from "./usePointer";
import { useVoice } from "./useVoice";
import { useWindowShape } from "./useWindowShape";
import type { WindowGeometry } from "./useWindowShape";

type NotchShellProps = {
  state: DisplayState;
  hold: HoldState;
  needsAccess: boolean;
  actions: CardActions;
  children: ReactNode;
};

const contentGap = 12;

function isTextField(target: EventTarget): target is HTMLElement {
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  );
}

// The content's full height from y = 0, its top padding included.
function useContentHeight() {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, []);
  return { ref, height };
}

// Only the user's own click or key press moves focus; Escape gives it back from a text field.
function useTyping() {
  const [typing, setTyping] = useState(false);
  return {
    typing,
    onFocus: (event: FocusEvent) => setTyping(isTextField(event.target)),
    onBlur: () => setTyping(false),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape" && isTextField(event.target)) {
        event.target.blur();
      }
    },
  };
}

type DotProps = {
  geometry: OutlineGeometry;
  tasks: DisplayState["tasks"];
  setCardFolded: CardActions["setCardFolded"];
};

function ReopenDot({ geometry, tasks, setCardFolded }: DotProps) {
  const card = lastFoldedCard(tasks);
  if (card === null) return null;
  const rect = dotButtonRect(geometry);
  return (
    <button
      type="button"
      aria-label="Reopen the last answer"
      className="absolute flex cursor-pointer items-center justify-center rounded-full"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      }}
      onClick={() => setCardFolded({ taskId: card.taskId, folded: false })}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${dotColors[card.state]}`}
      />
    </button>
  );
}

const shapeClass =
  "fixed inset-0 bg-black text-zinc-100 transition-[clip-path] duration-[160ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none";
// Fades in after the outline has started to open; disappears at once when closing, so nothing flashes.
const contentShown =
  "opacity-100 transition-opacity delay-[80ms] duration-[85ms] motion-reduce:transition-none";
const contentHidden = "opacity-0 transition-none";

function Shell(props: NotchShellProps & { frame: WindowGeometry }) {
  const { state, hold, needsAccess, actions, children, frame } = props;
  const voice = useVoice(hold);
  const { typing, ...focusEvents } = useTyping();
  const content = useContentHeight();
  const geometry = { ...frame, contentHeight: content.height };
  const { notice, tasks } = state;
  const reasons = { needsAccess, typing, voice, notice, tasks };
  const mode = usePointer(geometry, reasons);
  const open = mode === "open";
  return (
    <div
      className={shapeClass}
      style={{ clipPath: `path("${shellOutline(geometry, mode)}")` }}
      {...focusEvents}
    >
      <main
        ref={content.ref}
        className={`flex max-h-screen flex-col ${open ? contentShown : contentHidden}`}
        style={{ paddingTop: frame.shape.notchHeight + contentGap }}
        aria-hidden={!open}
        inert={!open}
      >
        {children}
      </main>
      {mode === "dot" && (
        <ReopenDot
          geometry={geometry}
          tasks={state.tasks}
          setCardFolded={actions.setCardFolded}
        />
      )}
    </div>
  );
}

// The one dark shape: on the notch when there is nothing to show, unfolded into the cards when there is.
export function NotchShell(props: NotchShellProps) {
  const frame = useWindowShape();
  if (frame === null) return null;
  return <Shell {...props} frame={frame} />;
}
