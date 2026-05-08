import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import ChatWidget from "../components/ChatWidget";
import type { CapturedImages } from "./CaptureWindow";
import type { Message, StoredSession } from "../types";

interface ExitingChat {
  images:    CapturedImages;
  sessionId: string;
  origin:    string;
}

const EXIT_MS = 200;

export default function ChatWindow() {
  const [images,                 setImages]                 = useState<CapturedImages | null>(null);
  const [sessionId,              setSessionId]              = useState(() => Date.now().toString());
  const [initialMessages,        setInitialMessages]        = useState<Message[]>([]);
  const [initialSummary,         setInitialSummary]         = useState<string | null>(null);
  const [initialSummarizedCount, setInitialSummarizedCount] = useState<number>(0);
  const [origin,                 setOrigin]                 = useState<string>("50% 50%");
  const [exitingChat,            setExitingChat]            = useState<ExitingChat | null>(null);

  // Refs that always reflect the latest committed state — listeners need fresh values.
  const imagesRef    = useRef<CapturedImages | null>(null);
  const sessionIdRef = useRef<string>(sessionId);
  const originRef    = useRef<string>(origin);
  imagesRef.current    = images;
  sessionIdRef.current = sessionId;
  originRef.current    = origin;

  // Pending state for the next entrance, captured at chat:reset time.
  const targetPosRef = useRef<{ x: number; y: number } | null>(null);
  const exitStartRef = useRef<number | null>(null);

  useEffect(() => {
    const win    = getCurrentWebviewWindow();
    const margin = 24;

    const p1 = listen<CapturedImages>("chat:images", async (e) => {
      // Wait for the exit animation to fully reach scale 0 before swapping in
      // the new chat. Without this, fast encoding interrupts the exit mid-tween,
      // causing the visible "snap" between old origin and new origin.
      const elapsed = exitStartRef.current ? Date.now() - exitStartRef.current : EXIT_MS;
      const wait    = Math.max(0, EXIT_MS - elapsed);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      // Teleport invisibly (old chat is at scale 0, new not yet mounted) and
      // make sure the window is visible before the entrance animation runs.
      if (targetPosRef.current) {
        await win.setPosition(new LogicalPosition(targetPosRef.current.x, targetPosRef.current.y));
        await win.show();
        targetPosRef.current = null;
      }

      setExitingChat(null);
      setImages(e.payload);
      setSessionId(Date.now().toString());
      setInitialMessages([]);
      setInitialSummary(null);
      setInitialSummarizedCount(0);
      exitStartRef.current = null;
    });

    const p2 = listen<StoredSession>("chat:restore", async (e) => {
      const s = e.payload;
      win.setPosition(new LogicalPosition(window.screen.width - 408 - margin, margin));
      setOrigin("50% 50%");
      setExitingChat(null);
      await win.show();
      setImages({ focus: s.focusB64, context: "", focusMime: s.focusMime ?? "image/png" });
      setSessionId(s.id);
      setInitialMessages(s.messages);
      setInitialSummary(s.summary ?? null);
      setInitialSummarizedCount(s.summarizedCount ?? 0);
    });

    // New capture starting: stash current chat as "exiting" and remember
    // where to land + which corner to scale from for the next entrance.
    const p3 = listen<{ originX: string; originY: string; chatX: number; chatY: number }>(
      "chat:reset",
      (e) => {
        const newOrigin = `${e.payload.originX} ${e.payload.originY}`;
        targetPosRef.current = { x: e.payload.chatX, y: e.payload.chatY };

        if (imagesRef.current) {
          setExitingChat({
            images:    imagesRef.current,
            sessionId: sessionIdRef.current,
            origin:    originRef.current,
          });
          setImages(null);
          exitStartRef.current = Date.now();
        } else {
          exitStartRef.current = null;
        }
        setOrigin(newOrigin);
      },
    );

    win.setPosition(new LogicalPosition(window.screen.width - 408 - margin, margin));

    return () => {
      p1.then((fn) => fn());
      p2.then((fn) => fn());
      p3.then((fn) => fn());
    };
  }, []);

  async function handleClose() {
    await getCurrentWebviewWindow().hide();
    setImages(null);
    setExitingChat(null);
  }

  if (images) {
    return (
      <ChatWidget
        key={sessionId}
        captured={images}
        onClose={handleClose}
        sessionId={sessionId}
        origin={origin}
        initialMessages={initialMessages}
        initialSummary={initialSummary}
        initialSummarizedCount={initialSummarizedCount}
      />
    );
  }

  if (exitingChat) {
    return (
      <ChatWidget
        key={exitingChat.sessionId}
        captured={exitingChat.images}
        onClose={handleClose}
        sessionId={exitingChat.sessionId}
        origin={exitingChat.origin}
        exiting
      />
    );
  }

  return null;
}
