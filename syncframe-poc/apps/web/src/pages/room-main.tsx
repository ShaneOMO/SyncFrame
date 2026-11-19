import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import "@/types/movi-player.d.ts";
import { exposeBuildInfo } from "@/build-info";
import RoomApp from "@/pages/room/room.tsx";

exposeBuildInfo();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RoomApp />
  </StrictMode>,
);
