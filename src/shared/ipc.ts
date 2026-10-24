export const ipcChannels = {
  holdState: "hold-state",
  getHoldState: "get-hold-state",
  getStartupInfo: "get-startup-info",
  openAccessibilitySettings: "open-accessibility-settings",
} as const;

export type HoldState = "idle" | "listening";

export type StartupInfo = {
  accessibility: boolean | null;
  holdKeyLabel: string;
};

export type BaymaxApi = {
  onHoldState: (callback: (state: HoldState) => void) => () => void;
  getStartupInfo: () => Promise<StartupInfo>;
  openAccessibilitySettings: () => void;
};
