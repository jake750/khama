import React from "react";
import ReactDOM from "react-dom/client";
// الخط مضمّن داخل التطبيق (لا اتصال بـ Google Fonts). يدعم العربية واللاتينية.
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans-arabic/700.css";
import "./styles.css";
import "./redesign.css";
import "./guide.css";
import "./bubbly.css";
import App from "./App";
import { followSystemMotion } from "./motion";
import { installFocusTrap } from "./focusTrap";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installGlobalErrorLog } from "./log";

followSystemMotion();
installFocusTrap();
installGlobalErrorLog();

// في المتصفح فقط (npm run dev): بيانات تجريبية بدل Rust لمعاينة التصميم. لا تدخل في نسخة التطبيق.
const ready = import.meta.env.DEV ? import("./dev-mock") : Promise.resolve();

ready.then(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  ),
);
