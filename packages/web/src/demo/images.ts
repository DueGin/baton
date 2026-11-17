import type { AttachmentRef } from "@baton/protocol";

/**
 * Demo images are drawn on a canvas in the browser, so the console ships no binary fixtures. They
 * imitate screenshots of the search palette the demo conversation talks about.
 */
export type DemoImageKind = "before" | "after";
export const demoAttachments: Record<string, AttachmentRef & { kind: DemoImageKind }> = {
  att_demo_search: { id: "att_demo_search", mimeType: "image/png", name: "搜索面板截图.png", width: 960, height: 600, kind: "before" },
  att_demo_shot: { id: "att_demo_shot", mimeType: "image/png", name: "screenshot.png", width: 960, height: 600, kind: "after" },
};
/** Local files the demo agent refers to by path (relative to the conversation's cwd). */
export const demoLocalImages: Record<string, DemoImageKind> = { "/workspace/notes/docs/search-spacing.png": "after" };

export function drawDemoImage(kind: DemoImageKind): Promise<Blob> {
  if (typeof document === "undefined") return Promise.reject(new Error("演示图片需要浏览器环境"));
  const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 600;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("无法绘制演示图片"));
  const font = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  const box = (x: number, y: number, w: number, h: number, radius: number, fill: string, stroke?: string) => {
    context.beginPath(); context.roundRect(x, y, w, h, radius); context.fillStyle = fill; context.fill();
    if (stroke) { context.strokeStyle = stroke; context.lineWidth = 2; context.stroke(); }
  };
  context.fillStyle = "#e9edf1"; context.fillRect(0, 0, 960, 600);
  // A dimmed app behind the palette.
  box(0, 0, 960, 44, 0, "#dfe4e9"); ["#e06c63", "#e8b24f", "#5fb769"].forEach((color, index) => { context.beginPath(); context.arc(22 + index * 20, 22, 6, 0, Math.PI * 2); context.fillStyle = color; context.fill(); });
  for (let row = 0; row < 7; row++) box(40, 80 + row * 70, 220, 40, 6, "#d9dfe5");
  box(180, 70, 600, 460, 14, "#ffffff", "#ccd5de");
  box(204, 94, 552, 48, 9, "#f3f5f7", "#28846c");
  context.fillStyle = "#202a36"; context.font = `500 20px ${font}`; context.fillText("搜索：权限", 226, 125);
  context.fillStyle = "#82909c"; context.font = `600 13px ${font}`; context.fillText("文件", 210, 172);
  const titles = ["src/auth/permissions.ts", "src/auth/session.ts", "docs/权限模型.md", "tests/permissions.test.ts", "src/api/routes.ts"];
  const gap = kind === "before" ? 38 : 64; const height = kind === "before" ? 34 : 52;
  titles.forEach((title, index) => {
    const y = 184 + index * gap;
    box(204, y, 552, height, 7, index === 0 ? "#e7f2ed" : "#ffffff");
    context.fillStyle = index === 0 ? "#28846c" : "#566474"; context.font = `${kind === "before" ? 14 : 17}px ${font}`;
    context.fillText(title, 222, y + height / 2 + 6);
    if (kind === "after") { context.fillStyle = "#82909c"; context.font = `13px ${font}`; context.fillText(`${3 + index} 处匹配`, 676, y + height / 2 + 5); }
  });
  if (kind === "before") {
    context.setLineDash([7, 5]); context.strokeStyle = "#c05a5d"; context.lineWidth = 3;
    context.strokeRect(196, 178, 568, 196); context.setLineDash([]);
    box(560, 392, 196, 40, 8, "#f9e9e9"); context.fillStyle = "#c05a5d"; context.font = `600 15px ${font}`; context.fillText("行距过挤 · 无匹配数", 578, 418);
  } else {
    box(560, 488, 196, 30, 8, "#e4f3ed"); context.fillStyle = "#27896e"; context.font = `600 14px ${font}`; context.fillText("✓ 行高 52px · 间距 12px", 574, 508);
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("无法生成演示图片")), "image/png"));
}
