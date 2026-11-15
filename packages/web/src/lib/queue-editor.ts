export function queueEditError(text: string): string | undefined { return text.trim() ? undefined : "消息不能为空"; }
export function queueEditKey(key: string, shiftKey: boolean, composing: boolean): "save" | "cancel" | undefined {
  if (composing) return undefined;
  if (key === "Escape") return "cancel";
  if (key === "Enter" && !shiftKey) return "save";
  return undefined;
}
