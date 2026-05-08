import { useEffect, useRef, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as autostartIsEnabled } from "@tauri-apps/plugin-autostart";
import type { StoredSession } from "../types";
import { applyAccent, DEFAULT_ACCENT } from "../theme";
import { applyHotkey, formatHotkey, loadHotkey, saveHotkey, type Hotkey } from "../hotkey";

const PROXY = "https://snigma-api.protobuben.workers.dev";

const LANGUAGES: [string, string][] = [
  ["English (US)",    "en-US"],
  ["English (UK)",    "en-GB"],
  ["Ukrainian",       "uk-UA"],
  ["Russian",         "ru-RU"],
  ["Spanish",         "es-ES"],
  ["French",          "fr-FR"],
  ["German",          "de-DE"],
  ["Italian",         "it-IT"],
  ["Portuguese (BR)", "pt-BR"],
  ["Polish",          "pl-PL"],
  ["Dutch",           "nl-NL"],
  ["Turkish",         "tr-TR"],
  ["Hindi",           "hi-IN"],
  ["Japanese",        "ja-JP"],
  ["Korean",          "ko-KR"],
  ["Chinese (CN)",    "zh-CN"],
  ["Arabic",          "ar-SA"],
];

function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60)    return "just now";
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function MainWindow() {
  const [licensed, setLicensed] = useState<boolean>(() => !!localStorage.getItem("snigma_license_key"));
  const [key,      setKey]      = useState("");
  const [error,    setError]    = useState("");
  const [saving,   setSaving]   = useState(false);
  const [sessions, setSessions] = useState<StoredSession[]>([]);

  // Settings
  const [accent,    setAccent]    = useState<string>(() => localStorage.getItem("snigma_accent") ?? DEFAULT_ACCENT);
  const [autostart, setAutostart] = useState<boolean>(false);
  const [lowPerf,   setLowPerf]   = useState<boolean>(() => localStorage.getItem("snigma_low_perf") === "true");
  const [sttLang,   setSttLang]   = useState<string>(() => localStorage.getItem("snigma_stt_lang") ?? "en-US");
  const [micId,     setMicId]     = useState<string>(() => localStorage.getItem("snigma_mic_id") ?? "");
  const [micList,   setMicList]   = useState<MediaDeviceInfo[]>([]);
  const [hotkey,    setHotkey]    = useState<Hotkey>(() => loadHotkey());
  const [recording, setRecording] = useState<boolean>(false);
  const recordingRef = useRef(false);

  // Sync license, autostart status, saved hotkey, and mic list to Rust on mount.
  useEffect(() => {
    invoke("set_license_state", { licensed: !!localStorage.getItem("snigma_license_key") });
    autostartIsEnabled().then(setAutostart).catch(() => {});
    applyHotkey(loadHotkey()).catch((e) => console.error("hotkey apply failed:", e));

    async function loadMics() {
      let devices = await navigator.mediaDevices.enumerateDevices();
      let mics = devices.filter((d) => d.kind === "audioinput");
      // Labels are empty until permission is granted — request it silently.
      if (mics.length > 0 && !mics[0].label) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
        mics = devices.filter((d) => d.kind === "audioinput");
      }
      setMicList(mics);
    }
    loadMics().catch(() => {});
  }, []);

  useEffect(() => {
    function load() {
      const raw = localStorage.getItem("tutor_sessions");
      setSessions(raw ? JSON.parse(raw) : []);
    }
    load();
    window.addEventListener("storage", load);
    return () => window.removeEventListener("storage", load);
  }, []);

  // ---------- License ----------

  async function submitLicense() {
    if (!key.trim()) return;
    setSaving(true);
    setError("");
    try {
      const resp = await fetch(`${PROXY}/quota`, {
        headers: { Authorization: `Bearer ${key.trim()}` },
      });
      if (resp.ok) {
        localStorage.setItem("snigma_license_key", key.trim());
        setLicensed(true);
        invoke("set_license_state", { licensed: true });
      } else if (resp.status === 403) {
        setError("Invalid or inactive license key — check your subscription.");
      } else {
        setError("Couldn't verify key — check your connection and try again.");
      }
    } catch {
      setError("Couldn't reach the server — check your connection.");
    } finally {
      setSaving(false);
    }
  }

  function deactivate() {
    localStorage.removeItem("snigma_license_key");
    setLicensed(false);
    setKey("");
    invoke("set_license_state", { licensed: false });
  }

  async function openSession(session: StoredSession) {
    await emitTo("chat", "chat:restore", session);
  }

  function clearHistory() {
    localStorage.removeItem("tutor_sessions");
    setSessions([]);
  }

  // ---------- Theme ----------

  function onAccentChange(hex: string) {
    setAccent(hex);
    applyAccent(hex);
    localStorage.setItem("snigma_accent", hex);
    emitTo("chat",    "theme:accent", { hex }).catch(() => {});
    emitTo("capture", "theme:accent", { hex }).catch(() => {});
  }

  // ---------- Voice ----------

  function onLangChange(lang: string) {
    setSttLang(lang);
    localStorage.setItem("snigma_stt_lang", lang);
  }

  function onMicChange(id: string) {
    setMicId(id);
    localStorage.setItem("snigma_mic_id", id);
  }

  // ---------- Low-perf mode ----------

  function toggleLowPerf(next: boolean) {
    setLowPerf(next);
    localStorage.setItem("snigma_low_perf", next ? "true" : "false");
  }

  // ---------- Autostart ----------

  async function toggleAutostart(next: boolean) {
    setAutostart(next);
    try {
      if (next) await enableAutostart();
      else      await disableAutostart();
    } catch (e) {
      console.error("autostart toggle failed:", e);
      setAutostart(!next);
    }
  }

  // ---------- Hotkey recorder ----------

  function startRecording() {
    setRecording(true);
    recordingRef.current = true;
  }

  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent) {
      // Ignore lone modifier presses — wait for a real key.
      if (["Control", "Shift", "Alt", "Meta", "ContextMenu"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        recordingRef.current = false;
        return;
      }
      const next: Hotkey = {
        ctrl:  e.ctrlKey,
        shift: e.shiftKey,
        alt:   e.altKey,
        meta:  e.metaKey,
        code:  e.code,
      };
      setHotkey(next);
      saveHotkey(next);
      applyHotkey(next).catch((err) => console.error("hotkey apply failed:", err));
      setRecording(false);
      recordingRef.current = false;
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [recording]);

  // ---------- Render ----------

  return (
    <div
      className="flex flex-col h-screen overflow-y-auto p-6 gap-5"
      style={{ background: "#0f0f10", color: "white" }}
    >
      <h1 className="text-xl font-bold text-white/90">Snigma</h1>

      {/* License */}
      <section className="rounded-xl p-5 flex flex-col gap-3" style={{ background: "#1a1a1e" }}>
        <h2 className="text-xs font-semibold text-white/50 uppercase tracking-widest">License</h2>
        {licensed ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
              <span>✓</span>
              <span>Active — {formatHotkey(hotkey)} to capture</span>
            </div>
            <button
              onClick={deactivate}
              className="text-xs transition-colors"
              style={{ color: "rgba(255,255,255,0.25)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(255,80,80,0.7)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.25)")}
            >
              Remove
            </button>
          </div>
        ) : (
          <>
            <input
              className="rounded-lg px-3 py-2 text-sm text-white outline-none"
              style={{ background: "#0f0f10", border: "1px solid rgba(255,255,255,0.1)" }}
              placeholder="Paste your license key…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitLicense()}
            />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button
              onClick={submitLicense}
              disabled={saving || key.trim().length < 4}
              className="py-2 rounded-lg text-white text-sm font-semibold transition-opacity disabled:opacity-40"
              style={{ background: "rgba(var(--accent-rgb), 0.8)" }}
            >
              {saving ? "Verifying…" : "Activate"}
            </button>
            <a
              href="https://snigma.github.io/#pricing"
              target="_blank"
              rel="noreferrer"
              className="text-center text-xs hover:underline"
              style={{ color: "rgba(var(--accent-rgb), 0.9)" }}
            >
              Don't have a key? Subscribe at snigma.github.io →
            </a>
          </>
        )}
      </section>

      {/* Settings */}
      <section className="rounded-xl p-5 flex flex-col gap-4" style={{ background: "#1a1a1e" }}>
        <h2 className="text-xs font-semibold text-white/50 uppercase tracking-widest">Settings</h2>

        {/* Hotkey */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-sm text-white/85">Capture shortcut</span>
            <span className="text-xs text-white/40">
              {recording ? "Press a combo… (Esc to cancel)" : formatHotkey(hotkey)}
            </span>
          </div>
          <button
            onClick={startRecording}
            disabled={recording}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white/80 hover:text-white transition-colors disabled:opacity-50"
            style={{ background: "rgba(var(--accent-rgb), 0.25)" }}
          >
            {recording ? "Recording…" : "Change"}
          </button>
        </div>

        {/* Theme color */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-sm text-white/85">Theme color</span>
            <span className="text-xs text-white/40">Used across all windows</span>
          </div>
          <label
            className="relative w-9 h-9 rounded-lg cursor-pointer overflow-hidden"
            style={{ background: accent, border: "1px solid rgba(255,255,255,0.12)" }}
          >
            <input
              type="color"
              value={accent}
              onChange={(e) => onAccentChange(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
          </label>
        </div>

        {/* Autostart */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-sm text-white/85">Launch on login</span>
            <span className="text-xs text-white/40">Start Snigma when you sign in</span>
          </div>
          <button
            onClick={() => toggleAutostart(!autostart)}
            className="relative w-10 h-6 rounded-full transition-colors"
            style={{ background: autostart ? "rgba(var(--accent-rgb), 0.85)" : "rgba(255,255,255,0.12)" }}
          >
            <span
              className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
              style={{ left: autostart ? "calc(100% - 22px)" : "2px" }}
            />
          </button>
        </div>

        {/* Low performance mode */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-sm text-white/85">Low performance mode</span>
            <span className="text-xs text-white/40">Disables overlay animations to reduce CPU usage</span>
          </div>
          <button
            onClick={() => toggleLowPerf(!lowPerf)}
            className="relative w-10 h-6 rounded-full transition-colors"
            style={{ background: lowPerf ? "rgba(var(--accent-rgb), 0.85)" : "rgba(255,255,255,0.12)" }}
          >
            <span
              className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
              style={{ left: lowPerf ? "calc(100% - 22px)" : "2px" }}
            />
          </button>
        </div>

        {/* Voice language */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-sm text-white/85">Voice language</span>
            <span className="text-xs text-white/40">Speech recognition language</span>
          </div>
          <select
            value={sttLang}
            onChange={(e) => onLangChange(e.target.value)}
            className="text-xs rounded-lg px-2 py-1.5 outline-none max-w-[140px]"
            style={{ background: "#0f0f10", color: "rgba(255,255,255,0.75)", border: "1px solid rgba(255,255,255,0.1)" }}
          >
            {LANGUAGES.map(([label, code]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
        </div>

        {/* Microphone */}
        {micList.length > 0 && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-sm text-white/85">Microphone</span>
              <span className="text-xs text-white/40">Input device for voice</span>
            </div>
            <select
              value={micId}
              onChange={(e) => onMicChange(e.target.value)}
              className="text-xs rounded-lg px-2 py-1.5 outline-none max-w-[140px]"
              style={{ background: "#0f0f10", color: "rgba(255,255,255,0.75)", border: "1px solid rgba(255,255,255,0.1)" }}
            >
              <option value="">System default</option>
              {micList.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      {/* Recent Sessions */}
      {sessions.length > 0 && (
        <section className="rounded-xl p-5 flex flex-col gap-3" style={{ background: "#1a1a1e" }}>
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-white/50 uppercase tracking-widest">Recent Sessions</h2>
            <button
              onClick={clearHistory}
              className="text-xs transition-colors"
              style={{ color: "rgba(255,255,255,0.25)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(255,80,80,0.7)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.25)")}
            >
              Clear
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {sessions.slice(0, 5).map((s) => (
              <div key={s.id} className="flex items-center gap-3">
                <img
                  src={`data:image/png;base64,${s.focusB64}`}
                  alt=""
                  className="h-8 w-12 rounded object-cover shrink-0"
                  style={{ border: "1px solid rgba(255,255,255,0.08)" }}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-white/60 text-xs">{timeAgo(s.timestamp)}</p>
                  <p className="text-white/30 text-xs">{s.messages.length} messages</p>
                </div>
                <button
                  onClick={() => openSession(s)}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium text-white/70 hover:text-white transition-colors shrink-0"
                  style={{ background: "rgba(var(--accent-rgb), 0.25)" }}
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="mt-auto text-center text-xs" style={{ color: "rgba(255,255,255,0.25)" }}>
        {formatHotkey(hotkey)} to capture
      </p>
    </div>
  );
}
