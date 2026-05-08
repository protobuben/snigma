// Theme accent — persisted in localStorage as "snigma_accent" (hex).
// Each webview applies it on mount so all windows share the same color.

export const DEFAULT_ACCENT = "#6c63ff";

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

export function applyAccent(hex: string) {
  const rgb = hexToRgb(hex);
  if (!rgb) return;
  const root = document.documentElement;
  root.style.setProperty("--accent-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  // Lighter variant — clamp each channel toward white by ~32.
  const lr = Math.min(255, rgb.r + 32);
  const lg = Math.min(255, rgb.g + 32);
  const lb = Math.min(255, rgb.b + 32);
  root.style.setProperty("--accent-light-rgb", `${lr}, ${lg}, ${lb}`);
}

export function applyStoredAccent() {
  const hex = localStorage.getItem("snigma_accent") ?? DEFAULT_ACCENT;
  applyAccent(hex);
}
