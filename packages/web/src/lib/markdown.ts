export function safeLink(url: string): string | undefined {
  const trimmed = url.trim();
  return !/[\u0000-\u0020\u007f]/.test(trimmed) && /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : undefined;
}
export interface CodeFence { code: string; language: string; complete: boolean; start: number; end: number }
/** Inspect source fences rather than the recovered Markdown AST: an unfinished fence is valid Markdown too. */
export function codeFences(text: string): CodeFence[] {
  const lines = text.split(/\n/); const result: CodeFence[] = []; let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!; const opening = /^\s*(`{3,}|~{3,})([^\s]*)[^\n]*$/.exec(line);
    if (!opening) { offset += line.length + 1; continue; }
    const start = offset; const marker = opening[1]!; const language = opening[2]!.toLowerCase(); const code: string[] = [];
    offset += line.length + 1; let complete = false;
    while (++index < lines.length) {
      const next = lines[index]!; offset += next.length + 1;
      if (new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(next)) { complete = true; break; }
      code.push(next);
    }
    result.push({ start, end: Math.min(text.length, offset), language, code: code.join("\n"), complete });
  }
  return result;
}
export function diagramReady(complete: boolean, stableForMs: number): boolean { return complete && stableForMs >= 500; }
