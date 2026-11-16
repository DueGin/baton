/** Derived from Orca src/main/acp/requests/acp-form-elicitation.ts and
 * acp-dialects/cursor-dialect.ts @a5781b8 (MIT, Copyright 2026 Lovecast Inc.). Modified for baton's native
 * question permission bridge and its four-question card bound. */
import { record, text } from "../session.js";
import type { AgentPermissionRequest, AgentPermissionResponse } from "../agent-sdk-types.js";
export interface AcpQuestion { request: Omit<AgentPermissionRequest, "id">; reply(response: AgentPermissionResponse): Record<string, unknown> }
export function formElicitation(params: Record<string, unknown>): AcpQuestion {
  const schema = record(params.requestedSchema), properties = record(schema.properties);
  const entries = Object.entries(properties);
  // Reject oversized forms explicitly rather than accepting a partly answered schema.
  if (!entries.length || entries.length > 4) throw new Error("ACP form requires 1..4 supported fields");
  const fields = entries.map(([key, raw]) => {
    const property = record(raw), items = record(property.items);
    if (!["string", "boolean", "array"].includes(text(property.type))) throw new Error(`Unsupported ACP form field ${key}`);
    const rawChoices = property.oneOf ?? items.anyOf;
    const choices = property.type === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] :
      Array.isArray(rawChoices) ? rawChoices : [];
    const options = choices.length ? choices.map(rawChoice => { const choice = record(rawChoice); return { value: text(choice.value ?? choice.const), label: text(choice.label ?? choice.title ?? choice.const), description: text(choice.description) }; }) :
      (Array.isArray(property.enum ?? items.enum) ? (property.enum ?? items.enum) as unknown[] : []).map(value => ({ value: text(value), label: text(value), description: "" }));
    if (property.type === "array" && !options.length) throw new Error(`ACP array field ${key} requires enum choices`);
    return { key, property, options };
  });
  return {
    request: { name: "acp_elicitation", kind: "question", description: text(params.message), input: { questions: fields.map(({ key, property, options }) => ({ id: key, header: text(property.title) || key, question: [text(params.message), text(property.title), text(property.description)].filter(Boolean).join("\n\n"), options: options.map(({ label, description }) => ({ label, description })), multiSelect: property.type === "array" })) } },
    reply(response) {
      if (response.behavior !== "allow") return { action: "cancel" };
      const answers = record(response.updatedInput?.answers), content: Record<string, unknown> = {};
      for (const { key, property, options } of fields) {
        const answer = answers[key];
        if (!Array.isArray(answer) || answer.some(value => typeof value !== "string")) throw new Error(`Missing ACP answer ${key}`);
        const values = answer.map(value => options.find(option => option.label === value)?.value ?? value);
        if (options.length && values.some(value => !options.some(option => option.value === value))) throw new Error(`Invalid ACP choice ${key}`);
        content[key] = property.type === "array" ? values : property.type === "boolean" ? values[0] === "true" : values.join(", ");
      }
      return { action: "accept", content };
    },
  };
}
export function cursorQuestion(params: Record<string, unknown>): AcpQuestion {
  const questions = (Array.isArray(params.questions) ? params.questions : []).map(record);
  if (!questions.length || questions.length > 4) throw new Error("Cursor questions require 1..4 prompts");
  return {
    request: { name: "cursor_ask_question", kind: "question", input: { questions: questions.map(q => ({ id: text(q.id), question: text(q.prompt), multiSelect: q.allowMultiple === true, options: q.options })) } },
    reply(response) {
      if (response.behavior !== "allow") return { outcome: { outcome: "cancelled" } };
      const answers = record(response.updatedInput?.answers);
      return { outcome: { outcome: "answered", answers: questions.map(q => ({ questionId: q.id, selectedOptionIds: (Array.isArray(answers[text(q.id)]) ? answers[text(q.id)] as unknown[] : []).map(label => {
        const option = (Array.isArray(q.options) ? q.options : []).map(record).find(o => o.label === label);
        if (!option) throw new Error("Invalid Cursor option");
        return option.id;
      }) })) } };
    },
  };
}
