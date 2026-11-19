import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { exposeBuildInfo } from "@/build-info";
import LobbyApp from "@/pages/lobby.tsx";

exposeBuildInfo();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LobbyApp />
  </StrictMode>,
);
