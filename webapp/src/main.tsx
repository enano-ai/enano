import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/tailwind.css";
import "@/i18n";
import PlaygroundPage from "@/pages/playground/PlaygroundPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlaygroundPage />
  </StrictMode>
);
