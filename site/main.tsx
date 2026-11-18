import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Home } from "./Home";
// GitHub's own markdown styles (light and dark, by the system setting), bundled rather than linked from a CDN:
// pinned in the lockfile, and nothing for the page to fetch from anyone else when it loads.
import "github-markdown-css/github-markdown.css";
import "./site.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
