import { lazy, Suspense, useRef, type ComponentProps } from "react";
import { IMAGE_ACCEPT } from "../lib/images.js";
import { Icon } from "./common.js";

export interface ComposerHandle {
  /** Send the draft (unless images are still uploading or failed). */
  submit(): void;
  /** Add images at the caret (gated on the agent's image capability). */
  attach(files: File[]): void;
  focus(): void;
  /** Put Markdown into the draft (replaces an empty draft, else appended) and focus it. */
  setDraft(markdown: string): void;
  insertQuote(markdown: string): void;
  /** Show a short hint in the composer footer. */
  hint(text: string): void;
}
export interface ComposerStatus { empty: boolean; uploading: boolean; failed: boolean; hint?: string }

/** The editor's empty state as plain markup: shown while the editor loads (and when rendering on the server). */
export function ComposerPlaceholder({ placeholder, disabled }: { placeholder: string; disabled: boolean }) {
  return <div className="composer-editor-scroll"><div className="composer-editor" role="textbox" aria-multiline="true" aria-label="消息" aria-placeholder={placeholder} aria-disabled={disabled || undefined} aria-expanded={false}><p className="is-editor-empty" data-placeholder={placeholder} /></div></div>;
}

// TipTap and ProseMirror load with the first conversation, not with the console.
const Editor = lazy(() => import("./Composer.js").then(module => ({ default: module.Composer })));
export function LazyComposer(props: ComponentProps<typeof Editor>) {
  return <Suspense fallback={<div className={`composer-body${props.disabled ? " is-disabled" : ""}`}><ComposerPlaceholder placeholder={props.placeholder} disabled={props.disabled} /></div>}><Editor {...props} /></Suspense>;
}

/** Image icon in the composer footer; disabled with a reason when the node's agent cannot take images. */
export function AttachImageButton({ enabled, disabled, attach }: { enabled: boolean; disabled: boolean; attach: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <button type="button" className="icon-button composer-attach" aria-label="添加图片" title={enabled ? "添加图片 · 也可直接粘贴或拖入" : "当前 agent 不支持图片"} disabled={disabled || !enabled} onClick={() => input.current?.click()}><Icon name="image" size={16} /></button>
    <input ref={input} type="file" accept={IMAGE_ACCEPT} multiple hidden tabIndex={-1} onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ""; attach(files); }} />
  </>;
}
