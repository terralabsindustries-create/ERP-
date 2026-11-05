import type { KeyboardEvent } from "react";

/**
 * Enter in a long editing form.
 *
 * A browser submits a form when Enter is pressed in a single-line field
 * ("implicit submission"). In a quotation or invoice that saves the document
 * half-written. With moveFocusOnEnter on the form, Enter moves to the next
 * field instead (Shift+Enter to the previous one), and the form is only
 * submitted by its own Save / Create button.
 */
export type EnterAction = "next" | "previous" | "block" | "default";

// Single-line inputs, the ones a browser submits the form from on Enter.
const SINGLE_LINE = new Set(["", "text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "week", "time"]);

interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/**
 * What a key press in a form should do. Textareas keep their new line;
 * buttons, selects and checkboxes keep their own Enter; a key that finishes
 * an IME composition is left alone. Enter with a modifier in a field does
 * nothing at all, so no combination submits the form by accident.
 */
export function enterAction(e: KeyLike, target: { tagName?: string; type?: string }): EnterAction {
  if (e.key !== "Enter" || e.isComposing) return "default";
  if (String(target.tagName).toUpperCase() !== "INPUT" || !SINGLE_LINE.has(String(target.type ?? "").toLowerCase())) return "default";
  if (e.ctrlKey || e.metaKey || e.altKey) return "block";
  return e.shiftKey ? "previous" : "next";
}

// What counts as a field to move to: inputs, textareas, selects (including
// Radix select triggers) and checkboxes — not action buttons like Remove.
const FIELDS = 'input:not([type="hidden"]), textarea, select, [role="combobox"], button[role="checkbox"]';

const usable = (el: HTMLElement) =>
  !(el as HTMLInputElement).disabled && !el.hasAttribute("readonly") && el.tabIndex >= 0 && el.getClientRects().length > 0;

/** onKeyDown for a <form>: Enter in a field moves to the next field instead of submitting. */
export function moveFocusOnEnter(e: KeyboardEvent<HTMLElement>) {
  const target = e.target as HTMLElement & { type?: string };
  const action = enterAction(
    { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent?.isComposing },
    { tagName: target.tagName, type: target.type }
  );
  if (action === "default") return;
  e.preventDefault();
  if (action === "block") return;

  const fields = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FIELDS)).filter(usable);
  const index = fields.indexOf(target);
  const next = fields[action === "next" ? index + 1 : index - 1];
  if (!next) return;
  next.focus();
  // Typing over a number or name right away is the common next step.
  const input = next as HTMLInputElement;
  if (next.tagName === "INPUT" && SINGLE_LINE.has(input.type) && typeof input.select === "function") {
    try {
      input.select();
    } catch {
      /* Some input types (date) cannot be selected. */
    }
  }
}
