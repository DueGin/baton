import { Children, isValidElement, memo, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import rehypeHighlight from "rehype-highlight";
import { codeFences, fixBareUrls, remarkBrTags, safeLink } from "../lib/markdown.js";
import { useColorTheme } from "../lib/theme.js";
import { MermaidBlock } from "./MermaidBlock.js";

import { CopyButton } from "./CopyButton.js";

function plainChildren(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === "string" || typeof child === "number" ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? plainChildren(child.props.children) : "").join("");
}
// Chat-style text: single newlines are line breaks (no stray spaces between CJK lines).
const REMARK_PLUGINS = [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough, remarkBreaks, remarkBrTags];
export const Markdown = memo(function Markdown({ text: source, streaming = false }: { text: string; streaming?: boolean }) {
  // Fence offsets, Mermaid stability and rendering all use the same normalized text.
  const text = useMemo(() => fixBareUrls(source), [source]);
  const theme = useColorTheme();
  const [stableText, setStableText] = useState<string | null>(null);
  useEffect(() => { const timer = setTimeout(() => setStableText(text), 500); return () => clearTimeout(timer); }, [text]);
  const fences = useMemo(() => codeFences(text), [text]);
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => safeLink(href ?? "") ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    // Images from agent text are links, avoiding remote requests and oversized inline assets.
    img: ({ src, alt }) => safeLink(typeof src === "string" ? src : "") ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || "图片"}</a> : <span>{alt}</span>,
    table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
    pre: ({ node, children }) => {
      const start = node?.position?.start.offset;
      const fence = fences.find(entry => start !== undefined && start >= entry.start && start < entry.end);
      const codeElement = Children.toArray(children).find(child => isValidElement(child));
      const className = isValidElement<{ className?: string }>(codeElement) ? codeElement.props.className ?? "" : "";
      const language = fence?.language || /language-([^\s]+)/.exec(className)?.[1] || "text";
      const code = fence?.code ?? plainChildren(children).replace(/\n$/, "");
      return language === "mermaid" ? <MermaidBlock code={code} complete={fence?.complete ?? false} stable={stableText === text} theme={theme} /> : <div className="code-block"><div className="code-language"><span>{language}</span><CopyButton text={code} /></div><pre>{children}</pre></div>;
    },
  }), [fences, stableText, text, theme]);
  return <div className={`markdown theme-${theme}${streaming ? " streaming-text" : ""}`}><ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={[[rehypeHighlight, { detect: false, plainText: ["mermaid"] }]]} urlTransform={url => safeLink(url) ?? ""} components={components}>{text}</ReactMarkdown></div>;
});
