import { useEffect, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import CaptureOverlay from "../components/CaptureOverlay";
import { applyAccent } from "../theme";

const CHAT_W = 408;
const CHAT_H = 568;
const GAP    = 16;

interface ChatPlacement {
  x:       number;
  y:       number;
  originX: string; // "0%" or "100%"
  originY: string; // "0%" or "100%"
}

function computeChatPosition(
  selX: number, selY: number, selW: number, selH: number,
  cursorX: number, cursorY: number,
): ChatPlacement {
  const monW = window.innerWidth;
  const monH = window.innerHeight;

  // Four candidates — each anchors a different corner of the chat near the cursor.
  // Preference order: above-right > above-left > below-right > below-left.
  const aLeft = cursorX - CHAT_W - GAP; // chat to the LEFT  of cursor
  const bLeft = cursorX + GAP;          // chat to the RIGHT of cursor
  const aTop  = cursorY - CHAT_H - GAP; // chat ABOVE cursor
  const bTop  = cursorY + GAP;          // chat BELOW cursor

  type Candidate = { left: number; top: number; ox: string; oy: string };
  const candidates: Candidate[] = [
    { left: bLeft, top: aTop, ox: "0%",   oy: "100%" }, // above-right (BL corner near cursor)
    { left: aLeft, top: aTop, ox: "100%", oy: "100%" }, // above-left  (BR corner near cursor)
    { left: bLeft, top: bTop, ox: "0%",   oy: "0%"   }, // below-right (TL corner near cursor)
    { left: aLeft, top: bTop, ox: "100%", oy: "0%"   }, // below-left  (TR corner near cursor)
  ];

  function clear(c: Candidate) {
    const inBounds  = c.left >= GAP && c.top >= GAP && c.left + CHAT_W <= monW - GAP && c.top + CHAT_H <= monH - GAP;
    const noOverlap = c.left + CHAT_W < selX || c.left > selX + selW || c.top + CHAT_H < selY || c.top > selY + selH;
    return inBounds && noOverlap;
  }

  const chosen = candidates.find(clear) ?? candidates[0];

  // Clamp to monitor (origin stays the same — it represents the *intent*)
  const chatLeft = Math.max(GAP, Math.min(chosen.left, monW - CHAT_W - GAP));
  const chatTop  = Math.max(GAP, Math.min(chosen.top,  monH - CHAT_H - GAP));

  return {
    x:       window.screenX + chatLeft,
    y:       window.screenY + chatTop,
    originX: chosen.ox,
    originY: chosen.oy,
  };
}

export interface CapturedImages {
  focus:     string;
  context:   string;
  focusMime: string;
}

const EXIT_MS = 220;

export default function CaptureWindow() {
  const [active,  setActive]  = useState(false);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const p1 = listen("overlay:start", () => {
      setExiting(false);
      setActive(true);
    });
    const p2 = listen<{ hex: string }>("theme:accent", (e) => applyAccent(e.payload.hex));
    return () => {
      p1.then((fn) => fn());
      p2.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!active || exiting) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", dismiss);
    };
  }, [active, exiting]);

  function teardown() {
    setActive(false);
    setExiting(false);
    getCurrentWebviewWindow().hide();
  }

  function dismiss() {
    if (exiting) return;
    setExiting(true);
    setTimeout(teardown, EXIT_MS);
  }

  function handleSelection(
    x: number, y: number, w: number, h: number,
    cursorX: number, cursorY: number,
    fullScreen = false,
  ) {
    if (exiting) return;
    setExiting(true);
    const chatPos = computeChatPosition(x, y, w, h, cursorX, cursorY);
    emit("chat:reset", {
      originX: chatPos.originX,
      originY: chatPos.originY,
      chatX:   chatPos.x,
      chatY:   chatPos.y,
    });
    invoke("capture_and_show", {
      x, y,
      width:       w,
      height:      h,
      scaleFactor: window.devicePixelRatio ?? 1,
      fullScreen,
    }).catch((err) => console.error("Capture failed:", err));
    setTimeout(teardown, EXIT_MS);
  }

  if (!active) return null;
  return <CaptureOverlay onSelect={handleSelection} exiting={exiting} />;
}
