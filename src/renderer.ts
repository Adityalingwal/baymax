import "./index.css";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { App } from "./renderer/App";

const container = document.getElementById("app");
if (!container) {
  throw new Error("#app not found");
}
createRoot(container).render(createElement(App));
