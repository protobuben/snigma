import { useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CapturedImages } from "../windows/CaptureWindow";
import type { Message, StoredSession } from "../types";

const TIPS = [
  "Click without dragging to capture your full screen",
  "Drag the corners to resize this window",
  "Drag the header to reposition",
  "Press the capture shortcut again to recrop",
  "Follow-up questions remember the full conversation",
  "Pick a theme color in Settings",
];

interface Props {
  captured:                CapturedImages;
  onClose:                 () => void;
  sessionId:               string;
  initialMessages?:        Message[];
  initialSummary?:         string | null;
  initialSummarizedCount?: number;
  origin?:                 string;
  exiting?:                boolean;
}

const lowPerf = () => localStorage.getItem("snigma_low_perf") === "true";

export default function ChatWidget({
  captured,
  onClose,
  sessionId,
  initialMessages        = [],
  initialSummary         = null,
  initialSummarizedCount = 0,
  origin                 = "50% 50%",
  exiting                = false,
}: Props) {
  const [messages,         setMessages]         = useState<Message[]>(initialMessages);
  const [summary,          setSummary]          = useState<string | null>(initialSummary);
  const [summarizedCount,  setSummarizedCount]  = useState<number>(initialSummarizedCount);
  const [input,            setInput]            = useState("");
  const [loading,          setLoading]          = useState(false);
  const [streaming,        setStreaming]        = useState("");
  const [tipIdx,           setTipIdx]           = useState(() => Math.floor(Math.random() * TIPS.length));
  const [tipVisible,       setTipVisible]       = useState(true);
  const [listening,        setListening]        = useState(false);
  const scrollRef      = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLInputElement>(null);
  const charQueueRef   = useRef<string[]>([]);
  const typewriterRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const recognitionRef = useRef<any>(null);

  function stopTypewriter() {
    if (typewriterRef.current !== null) {
      clearInterval(typewriterRef.current);
      typewriterRef.current = null;
    }
  }

  function drainQueue() {
    const remaining = charQueueRef.current.join("");
    charQueueRef.current = [];
    if (remaining) setStreaming((prev) => prev + remaining);
  }

  useEffect(() => {
    const unlisten = listen<{ chunk: string }>("chat:stream", (e) => {
      // Push incoming chars to the queue — don't update streaming directly.
      charQueueRef.current.push(...e.payload.chunk.split(""));

      // Start the typewriter interval if it isn't already running.
      if (typewriterRef.current !== null) return;
      typewriterRef.current = setInterval(() => {
        const queue = charQueueRef.current;
        if (queue.length === 0) return;
        // Adaptive release: catch up when chunks arrive faster than we type.
        const batch = queue.length > 300 ? 8
                    : queue.length > 100 ? 3
                    : 1;
        const chars = queue.splice(0, batch).join("");
        setStreaming((prev) => prev + chars);
      }, 12);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    if (messages.length === 0) return;
    const sessions: StoredSession[] = JSON.parse(localStorage.getItem("tutor_sessions") ?? "[]");
    const entry: StoredSession = {
      id:        sessionId,
      timestamp: Date.now(),
      focusB64:  captured.focus,
      focusMime: captured.focusMime,
      messages,
      summary,
      summarizedCount,
    };
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx >= 0) sessions[idx] = entry;
    else sessions.unshift(entry);
    localStorage.setItem("tutor_sessions", JSON.stringify(sessions.slice(0, 10)));
  }, [messages, summary, summarizedCount]);

  // Auto-focus input on mount so the user can start typing immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Stop recognition if it's somehow running when loading starts.
  useEffect(() => {
    if (loading) recognitionRef.current?.stop();
  }, [loading]);

  // Clean up on unmount.
  useEffect(() => () => recognitionRef.current?.stop(), []);

  // Cycle tips with a brief fade between each.
  useEffect(() => {
    const id = setInterval(() => {
      setTipVisible(false);
      setTimeout(() => {
        setTipIdx((i) => (i + 1) % TIPS.length);
        setTipVisible(true);
      }, 350);
    }, 7000);
    return () => clearInterval(id);
  }, []);

  function toggleVoice() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) return;

    const rec = new SR();
    rec.continuous     = false;
    rec.interimResults = true;
    rec.lang           = localStorage.getItem("snigma_stt_lang") ?? "en-US";

    rec.onresult = (e: any) => {
      const transcript = Array.from(e.results as any[])
        .map((r: any) => r[0].transcript)
        .join("");
      setInput(transcript);
    };
    rec.onend   = () => setListening(false);
    rec.onerror = () => setListening(false);

    recognitionRef.current = rec;

    const micId = localStorage.getItem("snigma_mic_id") ?? "";
    if (micId) {
      // Activate the chosen device first — WebView2 tends to route SR to it.
      navigator.mediaDevices
        .getUserMedia({ audio: { deviceId: { exact: micId } } })
        .then((stream) => {
          rec.start();
          setTimeout(() => stream.getTracks().forEach((t) => t.stop()), 500);
        })
        .catch(() => rec.start());
    } else {
      rec.start();
    }

    setListening(true);
    inputRef.current?.focus();
  }

  async function submit() {
    if (loading) return;
    const text    = input.trim();
    const userMsg: Message = {
      role:    "user",
      content: text || "What is this?",
    };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");

    // Reset typewriter state before starting a new request.
    stopTypewriter();
    charQueueRef.current = [];
    setLoading(true);
    setStreaming("");

    const licenseKey = localStorage.getItem("snigma_license_key") ?? "";

    try {
      const res = await invoke<{
        text:                 string;
        newSummary:           string | null;
        newSummarizedCount:   number;
      }>("send_to_ai", {
        licenseKey,
        focusB64:        captured.focus,
        focusMime:       captured.focusMime ?? "image/png",
        contextB64:      captured.context,
        history:         messages,
        prompt:          text,
        summary,
        summarizedCount,
      });
      // Stream finished — stop the typewriter and flush any queued chars instantly
      // so the transition to the committed bubble feels seamless.
      stopTypewriter();
      drainQueue();
      setMessages([...next, { role: "assistant", content: res.text }]);
      setSummary(res.newSummary);
      setSummarizedCount(res.newSummarizedCount);
    } catch (err) {
      stopTypewriter();
      charQueueRef.current = [];
      setMessages([...next, { role: "assistant", content: `**Error:** ${err}` }]);
    } finally {
      setLoading(false);
      setStreaming("");
    }
  }

  // Auto-scroll to bottom on every new message, loading state change, or stream chunk
  useEffect(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  }, [messages, loading, streaming]);

  return (
    <div
      className="relative w-screen h-screen"
      style={{
        transformOrigin: origin,
        animation: exiting
          ? "ts-chat-out 200ms cubic-bezier(0.4, 0, 1, 1) forwards"
          : "ts-chat-in 240ms cubic-bezier(0.22, 1, 0.36, 1) backwards",
      }}
    >
    <style>{`
      @keyframes ts-handle-float {
        0%, 100% { transform: translateY(0px); }
        50%      { transform: translateY(-2.5px); }
      }
      @keyframes ts-msg-in {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes ts-typing-dot {
        0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
        30%           { opacity: 1;   transform: translateY(-3px); }
      }
      @keyframes ts-cursor-blink {
        0%, 49%   { opacity: 1; }
        50%, 100% { opacity: 0; }
      }
      @keyframes ts-chat-in {
        from { opacity: 0; transform: scale(0); }
        to   { opacity: 1; transform: scale(1); }
      }
      @keyframes ts-chat-out {
        from { opacity: 1; transform: scale(1); }
        to   { opacity: 0; transform: scale(0); }
      }
      @keyframes ts-mic-pulse {
        0%, 100% { opacity: 0.7; }
        50%      { opacity: 1; }
      }
      .ts-tw-cursor {
        display:        inline-block;
        width:          7px;
        height:         1em;
        margin-left:    2px;
        vertical-align: text-bottom;
        background:     rgba(var(--accent-light-rgb), 0.95);
        border-radius:  1px;
        animation:      ts-cursor-blink 1s steps(1) infinite;
      }
    `}</style>
    <div
      className="absolute inset-1 flex flex-col rounded-2xl overflow-hidden"
      style={{
        background:     "rgba(15,15,16,0.92)",
        backdropFilter: "blur(20px)",
        border:         "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}
      >
        <div
          className="flex items-center gap-2 flex-1 cursor-grab active:cursor-grabbing select-none"
          onMouseDown={(e) => { if (e.button === 0) getCurrentWebviewWindow().startDragging(); }}
        >
          <img
            src={`data:image/png;base64,${captured.focus}`}
            alt="Focus"
            className="h-8 rounded-md object-cover pointer-events-none"
            style={{ maxWidth: 64 }}
          />
          <span className="text-white/80 text-sm font-semibold pointer-events-none">Snigma</span>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center text-white/40 hover:text-white/80 text-lg transition-colors rounded-lg"
        >
          ✕
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && !loading && (
          <p className="text-white/30 text-sm text-center mt-8">
            Ask about the selected problem, or just press Send.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className="max-w-[88%] rounded-xl px-3 py-2 text-sm leading-relaxed"
              style={{
                background: m.role === "user"
                  ? "rgba(var(--accent-rgb), 0.35)"
                  : "rgba(255,255,255,0.06)",
                color:     "rgba(255,255,255,0.9)",
                animation: "ts-msg-in 240ms cubic-bezier(0.22, 1, 0.36, 1)",
              }}
            >
              <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                {m.content}
              </ReactMarkdown>
            </div>
          </div>
        ))}
        {/* Typing — render plain text so characters flow without markdown snap-ins.
            The committed message below will format it once streaming is done. */}
        {loading && streaming && (
          <div className="flex justify-start">
            <div
              className="max-w-[88%] rounded-xl px-3 py-2 text-sm leading-relaxed"
              style={{
                background: "rgba(255,255,255,0.06)",
                color:      "rgba(255,255,255,0.9)",
                animation:  "ts-msg-in 240ms cubic-bezier(0.22, 1, 0.36, 1)",
                whiteSpace: "pre-wrap",
                wordBreak:  "break-word",
              }}
            >
              {streaming}<span className="ts-tw-cursor" />
            </div>
          </div>
        )}

        {/* Thinking — request out, no chunks yet */}
        {loading && !streaming && (
          <div className="flex justify-start">
            <div
              className="px-4 py-3 rounded-xl flex items-center gap-1.5"
              style={{
                background: "rgba(255,255,255,0.06)",
                animation:  "ts-msg-in 240ms cubic-bezier(0.22, 1, 0.36, 1)",
              }}
            >
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  style={{
                    display:        "inline-block",
                    width:          6,
                    height:         6,
                    borderRadius:   "50%",
                    background:     "rgba(255,255,255,0.7)",
                    animation:      "ts-typing-dot 1.2s ease-in-out infinite",
                    animationDelay: `${delay}ms`,
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div
        className="flex flex-col shrink-0"
        style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}
      >
        <p
          className="text-center px-4 pt-2 pb-0 text-xs select-none pointer-events-none"
          style={{
            color:      "rgba(255,255,255,0.18)",
            opacity:    tipVisible ? 1 : 0,
            transition: "opacity 350ms ease",
          }}
        >
          {TIPS[tipIdx]}
        </p>
        <div className="flex items-center gap-2 px-3 py-3">
        <input
          ref={inputRef}
          className="flex-1 bg-transparent text-white/90 text-sm outline-none placeholder:text-white/25"
          placeholder={listening ? "Listening…" : "Ask a follow-up…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          disabled={loading}
        />
        <button
          onClick={toggleVoice}
          disabled={loading}
          title={listening ? "Stop recording" : "Speak"}
          className="w-8 h-8 flex items-center justify-center rounded-lg transition-all disabled:opacity-40"
          style={{
            background: listening ? "rgba(var(--accent-rgb), 0.25)" : "transparent",
            color:      listening ? "rgba(var(--accent-light-rgb), 1)" : "rgba(255,255,255,0.35)",
            animation:  listening ? "ts-mic-pulse 1.2s ease-in-out infinite" : undefined,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="8"  y1="22" x2="16" y2="22" />
          </svg>
        </button>
        <button
          onClick={submit}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg text-sm font-medium text-white transition-opacity disabled:opacity-40"
          style={{ background: "rgba(var(--accent-rgb), 0.8)" }}
        >
          Send
        </button>
        </div>
      </div>
    </div>

    {/* Cartoony floating resize corner stickers */}
    {(["NorthWest", "NorthEast", "SouthWest", "SouthEast"] as const).map((dir, i) => {
      const isTop  = dir.startsWith("North");
      const isLeft = dir.endsWith("West");
      const isNwSe = (isTop && isLeft) || (!isTop && !isLeft);
      const rot = isTop ? (isLeft ? -7 : 7) : (isLeft ? 7 : -7);
      const path = isTop
        ? (isLeft ? "M 0 14 L 0 0 L 14 0" : "M 0 0 L 14 0 L 14 14")
        : (isLeft ? "M 0 0 L 0 14 L 14 14" : "M 14 0 L 14 14 L 0 14");
      const dur   = 2.8 + i * 0.18;
      const delay = i * 320;
      return (
        <div
          key={dir}
          className="group absolute w-6 h-6 z-50"
          style={{
            top:    isTop  ? 4 : "auto",
            bottom: !isTop ? 4 : "auto",
            left:   isLeft ? 4 : "auto",
            right:  !isLeft ? 4 : "auto",
            cursor:    isNwSe ? "nwse-resize" : "nesw-resize",
            animation: lowPerf() ? undefined : `ts-handle-float ${dur}s ease-in-out ${delay}ms infinite`,
          }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            getCurrentWebviewWindow().startResizeDragging(dir);
          }}
        >
          <svg
            width="14" height="14"
            className="absolute opacity-90 group-hover:opacity-100 transition-opacity"
            style={{
              top:       isTop  ? 2 : "auto",
              bottom:    !isTop ? 2 : "auto",
              left:      isLeft ? 2 : "auto",
              right:     !isLeft ? 2 : "auto",
              transform: `rotate(${rot}deg)`,
              overflow:  "visible",
              filter:    "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
            }}
          >
            <path
              d={path}
              stroke="rgba(var(--accent-light-rgb), 1)"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      );
    })}
    </div>
  );
}
