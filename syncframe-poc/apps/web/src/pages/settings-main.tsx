import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { exposeBuildInfo } from "@/build-info";
import SettingsApp from "@/pages/settings.tsx";

exposeBuildInfo();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
