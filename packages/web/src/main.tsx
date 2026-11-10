import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { ApiClient, readToken } from "./api.js";
import { DemoClient } from "./demo/client.js";
import "@xyflow/react/dist/style.css";
import "./styles.css";

const token = readToken(window.location, window.sessionStorage, window.history);
const demo = new URLSearchParams(window.location.search).get("demo") === "1" || !token;
const client = demo ? new DemoClient() : new ApiClient(token!);
createRoot(document.getElementById("root")!).render(<StrictMode><App client={client} /></StrictMode>);
