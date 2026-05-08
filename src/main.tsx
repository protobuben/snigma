import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { applyStoredAccent } from "./theme";
import "./index.css";

async function mount() {
  applyStoredAccent();

  const label = getCurrentWebviewWindow().label;

  const { default: Component } =
    label === "capture" ? await import("./windows/CaptureWindow") :
    label === "chat"    ? await import("./windows/ChatWindow")    :
                          await import("./windows/MainWindow");

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Component />
    </React.StrictMode>
  );
}

mount();
