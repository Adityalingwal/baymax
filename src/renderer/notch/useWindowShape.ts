import { useEffect, useMemo, useState } from "react";
import type { WindowShape } from "../../shared/ipc";

export type WindowGeometry = {
  shape: WindowShape;
  width: number;
  height: number;
};

// Main sizes the window; the page reads that size instead of keeping its own copy.
function readSize() {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function useWindowShape(): WindowGeometry | null {
  const [shape, setShape] = useState<WindowShape | null>(null);
  const [size, setSize] = useState(readSize);

  useEffect(() => window.baymax.onWindowShape(setShape), []);
  useEffect(() => {
    const resize = () => setSize(readSize());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  return useMemo(
    () => (shape === null ? null : { shape, ...size }),
    [shape, size],
  );
}
