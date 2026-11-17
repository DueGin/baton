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
import { InsideLink, MarkdownImage } from "./Images.js";

import { CopyButton } from "./CopyButton.js";

function plainChildren(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === "string" || typeof child === "number" ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? plainChildren(child.props.children) : "").join("");
}
// Chat-style text: single newlines are line breaks (no stray spaces between CJK lines).
const REMARK_PLUGINS = [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough, remarkBreaks, remarkBrTags];
/** Links keep the http(s)/mailto allow-list; image URLs pass through to MarkdownImage, which only
 * renders attachment markers, local image paths, http(s) and base64 image data URLs. */
const urlTransform = (url: string, key: string): string => key === "src" ? url : safeLink(url) ?? "";
/** `cwd` resolves relative image paths (otherwise the surrounding ImageContext's cwd is used). */
export const Markdown = memo(function Markdown({ text: source, streaming = false, cwd }: { text: string; streaming?: boolean; cwd?: string }) {
  // Fence offsets, Mermaid stability and rendering all use the same normalized text.
  const text = useMemo(() => fixBareUrls(source), [source]);
  const theme = useColorTheme();
  const [stableText, setStableText] = useState<string | null>(null);
  useEffect(() => { const timer = setTimeout(() => setStableText(text), 500); return () => clearTimeout(timer); }, [text]);
  const fences = useMemo(() => codeFences(text), [text]);
  const components = useMemo<Components>(() => ({
    // An image inside a link renders as a plain image so no button nests inside the anchor.
    a: ({ href, children }) => safeLink(href ?? "") ? <a href={href} target="_blank" rel="noopener noreferrer"><InsideLink value>{children}</InsideLink></a> : <span>{children}</span>,
    img: ({ src, alt }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} cwd={cwd} />,
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
  }), [cwd, fences, stableText, text, theme]);
  return <div className={`markdown theme-${theme}${streaming ? " streaming-text" : ""}`}><ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={[[rehypeHighlight, { detect: false, plainText: ["mermaid"] }]]} urlTransform={urlTransform} components={components}>{text}</ReactMarkdown></div>;
});

const INLINE_ELEMENTS = ["p", "strong", "em", "del", "code", "br"];
const INLINE_COMPONENTS: Components = { p: ({ children }) => <>{children}</> };
/** Inline-only Markdown (bold, italic, strike, code) for places like option buttons: block elements,
 * links and images are unwrapped to their text so nothing interactive nests inside a button. */
export const InlineMarkdown = memo(function InlineMarkdown({ text }: { text: string }) {
  return <span className="inline-markdown"><ReactMarkdown remarkPlugins={REMARK_PLUGINS} allowedElements={INLINE_ELEMENTS} unwrapDisallowed components={INLINE_COMPONENTS}>{text}</ReactMarkdown></span>;
});
