function nonBlankLines(selection: string): string[] {
  const lines = selection.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex(line => line.trim() !== "");
  if (first < 0) return [];
  const last = lines.findLastIndex(line => line.trim() !== "");
  return lines.slice(first, last + 1);
}

export interface QuoteSegment<Body> {
  text: string;
  body: Body | null;
  control?: boolean;
  start?: number;
  end?: number;
  separator?: string;
  preserveWhitespace?: boolean;
}

export function selectedBodyText<Body>(segments: Iterable<QuoteSegment<Body>>): string {
  const parts: string[] = [];
  let body: Body | null = null, text = "", pending = "";
  const finishBody = () => {
    const lines = nonBlankLines(text);
    if (lines.length) parts.push(lines.join("\n"));
    text = "";
    pending = "";
  };
  for (const segment of segments) {
    if (segment.body === null || segment.control) continue;
    const clip = segment.text.slice(segment.start ?? 0, segment.end);
    if (!clip) continue;
    if (body !== segment.body) { finishBody(); body = segment.body; }
    if (segment.separator) pending = segment.separator;
    if (segment.preserveWhitespace) {
      text += (text ? pending : "") + clip;
      pending = "";
    } else {
      const flow = clip.replace(/[\t\n\f\r ]+/g, " ");
      const words = flow.replace(/^ | $/g, "");
      if (words) {
        if (text) text += pending || (flow.startsWith(" ") && !text.endsWith("\n") ? " " : "");
        text += words;
        pending = "";
      }
      if (!pending && flow.endsWith(" ") && !text.endsWith("\n")) pending = " ";
    }
  }
  finishBody();
  return parts.join("\n\n");
}

export function quoteMarkdown(selection: string): string {
  const lines = nonBlankLines(selection);
  return lines.length ? lines.map(line => line.trim() ? `> ${line}` : ">").join("\n") + "\n\n" : "";
}
