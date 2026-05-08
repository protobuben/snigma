import { useCallback, useRef, useState } from "react";

interface Props {
  onSelect: (x: number, y: number, w: number, h: number, cursorX: number, cursorY: number, fullScreen?: boolean) => void;
  exiting?: boolean;
}

interface Drag {
  startX: number;
  startY: number;
  curX:   number;
  curY:   number;
  active: boolean;
}

const IDLE: Drag = { startX: 0, startY: 0, curX: 0, curY: 0, active: false };

export default function CaptureOverlay({ onSelect, exiting = false }: Props) {
  const lowPerf = localStorage.getItem("snigma_low_perf") === "true";

  const [drag,    setDrag]    = useState<Drag>(IDLE);
  const [lastSel, setLastSel] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const layerRef    = useRef<HTMLDivElement>(null);
  // Idle pill is always mounted — its position is updated directly via DOM ref
  // to avoid React re-renders on every pointer move.
  const idlePillRef = useRef<HTMLDivElement>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    layerRef.current?.setPointerCapture(e.pointerId);
    setDrag({ startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY, active: true });
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    // Update idle pill position directly — no state update, no React re-render.
    if (idlePillRef.current) {
      idlePillRef.current.style.transform =
        `translate3d(${e.clientX}px, ${e.clientY - 22}px, 0) translate(-50%, -100%)`;
    }
    if (!drag.active) return;
    setDrag((d) => ({ ...d, curX: e.clientX, curY: e.clientY }));
  }, [drag.active]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!drag.active) return;
    const x = Math.min(drag.startX, e.clientX);
    const y = Math.min(drag.startY, e.clientY);
    const w = Math.abs(e.clientX - drag.startX);
    const h = Math.abs(e.clientY - drag.startY);
    setDrag(IDLE);
    if (w > 10 && h > 10) {
      setLastSel({ left: x, top: y, width: w, height: h });
      onSelect(x, y, w, h, e.clientX, e.clientY);
    } else {
      // Plain click — capture the full screen at higher resolution.
      onSelect(0, 0, window.innerWidth, window.innerHeight, e.clientX, e.clientY, true);
    }
  }, [drag, onSelect]);

  const sel = drag.active
    ? {
        left:   Math.min(drag.startX, drag.curX),
        top:    Math.min(drag.startY, drag.curY),
        width:  Math.abs(drag.curX - drag.startX),
        height: Math.abs(drag.curY - drag.startY),
      }
    : null;

  // During exit keep the confirmed selection visible so the flash plays.
  const displaySel = sel ?? (exiting ? lastSel : null);

  // Drag pill: anchored above the selection center, shown only while dragging.
  const dragPill = !exiting && drag.active && sel
    ? { x: sel.left + sel.width / 2, y: sel.top - 14 }
    : null;

  return (
    <div
      ref={layerRef}
      className="fixed inset-0 select-none"
      style={{
        cursor:        exiting ? "default" : "crosshair",
        pointerEvents: exiting ? "none" : "auto",
        animation:     exiting ? "ts-fade-out 220ms ease-out forwards" : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <style>{`
        @keyframes ts-fade-in {
          from { opacity: 0; transform: scale(0.92); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes ts-fade-in-soft {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes ts-glow {
          0%, 100% { opacity: 0.55; }
          50%      { opacity: 1; }
        }
        @keyframes ts-vignette-glow {
          0%, 100% { opacity: 0.7; }
          50%      { opacity: 1; }
        }
        @keyframes ts-float {
          0%, 100% { transform: translateY(0px); }
          50%      { transform: translateY(-3px); }
        }
        @keyframes ts-fade-out {
          from { opacity: 1; filter: blur(0px); }
          to   { opacity: 0; filter: blur(4px); }
        }
        @keyframes ts-confirm-flash {
          0%   { box-shadow: 0 0 0 3px rgba(255,255,255,0.9), 0 0 32px rgba(255,255,255,0.5); border-color: white; }
          60%  { box-shadow: 0 0 0 2px rgba(var(--accent-light-rgb), 0.6), 0 0 12px rgba(var(--accent-light-rgb), 0.3); border-color: rgba(var(--accent-light-rgb), 0.8); }
          100% { box-shadow: none; border-color: rgba(var(--accent-rgb), 0.2); }
        }
        @keyframes ts-pill-float {
          0%, 100% { transform: translateY(0px) rotate(-1deg); }
          50%      { transform: translateY(-3px) rotate(1deg); }
        }
      `}</style>

      {/* Colorful vignette border — breathes while idle, settles during drag.
          Box-shadow is static; opacity animates (GPU-composited, zero repaint). */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          boxShadow:
            "inset 0 0 0 3px rgba(var(--accent-rgb), 1), inset 0 0 130px rgba(var(--accent-rgb), 0.22), inset 0 0 220px rgba(var(--accent-light-rgb), 0.12)",
          willChange: lowPerf ? undefined : "opacity",
          animation: (drag.active || lowPerf)
            ? "ts-fade-in-soft 280ms ease-out"
            : "ts-fade-in-soft 280ms ease-out, ts-vignette-glow 2.8s ease-in-out infinite",
        }}
      />

      {/* Center hint — fades out when dragging starts */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{
          opacity:    drag.active ? 0 : 1,
          transition: "opacity 180ms ease-out",
          animation:  "ts-fade-in-soft 380ms ease-out 80ms backwards",
        }}
      >
        <span
          className="text-white/60 text-sm font-medium tracking-wide px-4 py-2 rounded-lg"
          style={{
            background:     "rgba(15,15,16,0.6)",
            backdropFilter: lowPerf ? undefined : "blur(8px)",
            animation:      lowPerf ? undefined : "ts-float 4s ease-in-out infinite",
          }}
        >
          Drag to select · Esc to cancel
        </span>
      </div>

      {/* Idle pill — always mounted, position driven directly via DOM ref (zero re-renders).
          Hidden while dragging or exiting so the drag pill can take over. */}
      <div
        ref={idlePillRef}
        className="absolute pointer-events-none z-10"
        style={{
          left:       0,
          top:        0,
          transform:  "translate3d(-200px, -200px, 0) translate(-50%, -100%)",
          transition: lowPerf ? undefined : "transform 110ms cubic-bezier(0.22, 1, 0.36, 1)",
          willChange: "transform",
          visibility: (drag.active || exiting) ? "hidden" : "visible",
        }}
      >
        <div
          className="px-3 py-1 rounded-full text-sm whitespace-nowrap flex items-center gap-2"
          style={{
            fontFamily:     '"Fredoka", system-ui, sans-serif',
            fontWeight:     700,
            letterSpacing:  "0.02em",
            color:          "rgba(255,255,255,0.95)",
            background:     "rgba(var(--accent-rgb), 0.85)",
            boxShadow:      "0 6px 18px rgba(var(--accent-rgb), 0.5), inset 0 0 0 1px rgba(255,255,255,0.14)",
            backdropFilter: lowPerf ? undefined : "blur(8px)",
            animation:      lowPerf
              ? "ts-fade-in-soft 220ms cubic-bezier(0.22, 1, 0.36, 1)"
              : "ts-fade-in-soft 220ms cubic-bezier(0.22, 1, 0.36, 1), ts-pill-float 2.8s ease-in-out infinite",
          }}
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: "rgba(255,255,255,0.95)", boxShadow: "0 0 6px rgba(255,255,255,0.7)" }}
          />
          <span>focus</span>
        </div>
      </div>

      {/* Drag pill — React-driven, only mounted while dragging. Shows live dimensions. */}
      {dragPill && (
        <div
          className="absolute pointer-events-none z-10"
          style={{
            left:       0,
            top:        0,
            transform:  `translate3d(${dragPill.x}px, ${dragPill.y}px, 0) translate(-50%, -100%)`,
            transition: "transform 110ms cubic-bezier(0.22, 1, 0.36, 1)",
            willChange: "transform",
          }}
        >
          <div
            className="px-3 py-1 rounded-full text-sm whitespace-nowrap flex items-center gap-2 tabular-nums"
            style={{
              fontFamily:     '"Fredoka", system-ui, sans-serif',
              fontWeight:     700,
              letterSpacing:  "0.02em",
              color:          "rgba(255,255,255,0.95)",
              background:     "rgba(var(--accent-rgb), 0.85)",
              boxShadow:      "0 6px 18px rgba(var(--accent-rgb), 0.5), inset 0 0 0 1px rgba(255,255,255,0.14)",
              backdropFilter: lowPerf ? undefined : "blur(8px)",
            }}
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: "rgba(255,255,255,0.95)", boxShadow: "0 0 6px rgba(255,255,255,0.7)" }}
            />
            <span>focus</span>
            {sel && (
              <span style={{ color: "rgba(255,255,255,0.7)" }}>
                · {Math.round(sel.width)} × {Math.round(sel.height)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Dimmed mask + selection box */}
      {displaySel && (
        <>
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ overflow: "visible" }}
          >
            <defs>
              <mask id="cutout">
                <rect x="0" y="0" width="100%" height="100%" fill="white" />
                <rect x={displaySel.left} y={displaySel.top} width={displaySel.width} height={displaySel.height} fill="black" />
              </mask>
            </defs>
            <rect
              x="0" y="0" width="100%" height="100%"
              fill="rgba(0,0,0,0.45)"
              mask="url(#cutout)"
            />
          </svg>

          <div
            className="absolute pointer-events-none"
            style={{
              left:         displaySel.left,
              top:          displaySel.top,
              width:        displaySel.width,
              height:       displaySel.height,
              border:       "2px solid rgba(var(--accent-rgb), 0.95)",
              borderRadius: "2px",
              boxShadow:    "0 0 28px rgba(var(--accent-rgb), 0.7), 0 0 0 1px rgba(var(--accent-rgb), 0.6)",
              willChange:   (exiting || lowPerf) ? undefined : "opacity",
              animation:    exiting
                ? "ts-confirm-flash 220ms ease-out forwards"
                : lowPerf ? undefined : "ts-glow 2.4s ease-in-out infinite",
            }}
          />
        </>
      )}
    </div>
  );
}
