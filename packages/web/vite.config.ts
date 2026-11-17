import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.BATON_WEB_PROXY_URL ?? "http://127.0.0.1:7433",
      "/mcp": process.env.BATON_WEB_PROXY_URL ?? "http://127.0.0.1:7433",
    },
  },
  build: {
    outDir: "dist", sourcemap: true,
    rolldownOptions: { output: { codeSplitting: { groups: [
      { name: "react", test: /node_modules[\/](react|react-dom|scheduler)[\/]/, priority: 30 },
      { name: "highlight", test: /node_modules[\/](highlight\.js|lowlight|rehype-highlight)[\/]/, priority: 20 },
      { name: "markdown", test: /node_modules[\/](react-markdown|remark-gfm)[\/]/, priority: 10 },
      { name: "protocol", test: /node_modules[\/](zod|@baton[\/]protocol)[\/]|packages[\/]protocol[\/]/, priority: 10 },
      { name: "editor", test: /node_modules[\/](@tiptap|prosemirror-[a-z-]+|linkifyjs|orderedmap|rope-sequence|w3c-keyname|fast-equals)[\/]/, priority: 10 },
    ] } } },
  },
});
