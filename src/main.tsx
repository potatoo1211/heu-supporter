import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { invoke } from '@tauri-apps/api/core';

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

invoke('resize_window', {
  width: window.screen.width,
  height: window.screen.height
});