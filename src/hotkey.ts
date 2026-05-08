// Global hotkey persistence + Rust sync.
// Stored in localStorage as JSON under "snigma_hotkey".

import { invoke } from "@tauri-apps/api/core";

export interface Hotkey {
  ctrl:  boolean;
  shift: boolean;
  alt:   boolean;
  meta:  boolean;
  code:  string; // KeyboardEvent.code, e.g. "Space", "KeyA"
}

const isMac = navigator.platform.includes("Mac");

export const DEFAULT_HOTKEY: Hotkey = {
  ctrl:  !isMac,
  shift: true,
  alt:   false,
  meta:  isMac,
  code:  "Space",
};

export function loadHotkey(): Hotkey {
  const raw = localStorage.getItem("snigma_hotkey");
  if (!raw) return DEFAULT_HOTKEY;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.code === "string") return { ...DEFAULT_HOTKEY, ...parsed };
  } catch {/* ignore */}
  return DEFAULT_HOTKEY;
}

export function saveHotkey(h: Hotkey) {
  localStorage.setItem("snigma_hotkey", JSON.stringify(h));
}

export async function applyHotkey(h: Hotkey): Promise<void> {
  await invoke("set_hotkey", { ...h });
}

/** Friendly label like "Ctrl + Shift + Space" / "⌘ ⇧ Space". */
export function formatHotkey(h: Hotkey): string {
  const parts: string[] = [];
  if (h.ctrl)  parts.push(isMac ? "⌃" : "Ctrl");
  if (h.alt)   parts.push(isMac ? "⌥" : "Alt");
  if (h.shift) parts.push(isMac ? "⇧" : "Shift");
  if (h.meta)  parts.push(isMac ? "⌘" : "Win");
  parts.push(prettyCode(h.code));
  return parts.join(isMac ? " " : " + ");
}

function prettyCode(code: string): string {
  if (code.startsWith("Key"))   return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5);
  return code;
}
