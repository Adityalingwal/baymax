const turns = { down: 0, left: 90, up: 180, right: -90 } as const;

export type ChevronDirection = keyof typeof turns;

// The 14 pt white chevron; its turn eases only where the button's class asks for it.
export function Chevron({ direction }: { direction: ChevronDirection }) {
  return (
    <svg
      viewBox="0 0 14 14"
      width={14}
      height={14}
      fill="none"
      aria-hidden="true"
      className="chevron shrink-0"
      style={{ transform: `rotate(${turns[direction]}deg)` }}
    >
      <path
        d="M3.5 5.5 7 9l3.5-3.5"
        stroke="#fff"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type ReportButtonProps = {
  direction: ChevronDirection;
  label: string;
  expanded?: boolean;
  onClick: () => void;
};

// The 24 pt round glass button right of a title, with a 44 pt target.
export function ReportButton(props: ReportButtonProps) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-expanded={props.expanded}
      className="report-button glass"
      onClick={props.onClick}
    >
      <Chevron direction={props.direction} />
    </button>
  );
}
