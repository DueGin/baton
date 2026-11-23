import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { detectSuggestion, sameSuggestion, type SuggestionMatch, type SuggestionSession } from "./composer-suggest.js";
import { isSendKey, type SendShortcut, type ShortcutEvent } from "./send-shortcut.js";

export function editorSuggestion(state: EditorState): SuggestionMatch | null {
  const { selection, storedMarks, doc } = state;
  const { $from } = selection;
  if (!(selection instanceof TextSelection) || !selection.empty || !$from.parent.isTextblock) return null;
  for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.spec.code) return null;
  if ((storedMarks ?? $from.marks()).some(mark => mark.type.spec.code)) return null;
  const start = $from.start();
  const text = $from.parent.textBetween(0, $from.parentOffset, "", node => node.type.name === "hardBreak" ? "\n" : "\uFFFC");
  const match = detectSuggestion(text, start === 1 && $from.parent.type.name === "paragraph");
  if (!match) return null;
  const from = start + match.from, to = start + match.to;
  let code = false;
  doc.nodesBetween(from, to, node => { if (node.marks.some(mark => mark.type.spec.code)) code = true; });
  return code ? null : { ...match, from, to };
}

export function editorSuggestionReplacement(state: EditorState, match: SuggestionMatch, text: string): Transaction | null {
  if (!sameSuggestion(editorSuggestion(state), match)) return null;
  const transaction = state.tr.replaceWith(match.from, match.to, state.schema.text(text));
  return transaction.setSelection(TextSelection.create(transaction.doc, match.from + text.length));
}

export function composerKeyDown(view: Pick<EditorView, "state" | "dispatch" | "composing">,
  event: ShortcutEvent & Pick<KeyboardEvent, "preventDefault" | "stopPropagation">,
  suggestions: SuggestionSession, composing: boolean, shortcut: SendShortcut, submit: () => void): boolean {
  if (view.composing || composing || event.isComposing || event.keyCode === 229) return false;
  if (suggestions.keyDown(event, (match, text) => {
    const transaction = editorSuggestionReplacement(view.state, match, text);
    if (transaction) view.dispatch(transaction.scrollIntoView());
  })) { event.preventDefault(); event.stopPropagation(); return true; }
  if (!isSendKey(event, shortcut)) return false;
  if (shortcut === "enter") {
    const { $from } = view.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      const type = $from.node(depth).type;
      if (type.spec.code || type.name === "listItem" || type.name === "taskItem") return false;
    }
  }
  submit();
  return true;
}
