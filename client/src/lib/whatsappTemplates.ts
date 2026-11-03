// Meta only accepts exactly as many variables as the approved template's body actually declares
export function getTemplateBodyText(template: any): string {
  const bodyComponent = template?.components?.find((c: any) => c.type === "BODY");
  return bodyComponent?.text || "";
}

export function getTemplateFooterText(template: any): string {
  return template?.components?.find((c: any) => c.type === "FOOTER")?.text || "";
}

export function getVariableNumbers(text: string): number[] {
  const matches = Array.from(text.matchAll(/\{\{(\d+)\}\}/g)).map((m: any) => Number(m[1]));
  return Array.from(new Set(matches)).sort((a, b) => a - b);
}

export function getTemplateVariableNumbers(template: any): number[] {
  return getVariableNumbers(getTemplateBodyText(template));
}

/** The sample values a template was submitted with, by variable number ("1" → "Rajesh Kumar"). */
export function getTemplateExamples(template: any): Record<string, string> {
  const bodyComponent = template?.components?.find((c: any) => c.type === "BODY");
  const samples: string[] = bodyComponent?.example?.body_text?.[0] || [];
  return Object.fromEntries(samples.map((s, i) => [String(i + 1), s]));
}

/** Template names Meta accepts: lowercase letters, digits and underscores. */
export const normalizeTemplateName = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

export const TEMPLATE_BODY_LIMIT = 1024;
export const TEMPLATE_FOOTER_LIMIT = 60;

/** Meta's rules for a template body, as plain-language problems; empty when it can be submitted. */
export function templateBodyProblems(text: string): string[] {
  const body = text.trim();
  if (!body) return [];
  const problems: string[] = [];
  const vars = getVariableNumbers(body);
  if (vars.some((n, i) => n !== i + 1)) {
    problems.push(`Number the variables {{1}}, {{2}}, {{3}}… in order, with none skipped.`);
  }
  if (/^\{\{\d+\}\}/.test(body)) problems.push("The message can't start with a variable.");
  if (/\{\{\d+\}\}$/.test(body)) problems.push("The message can't end with a variable. Add a word or full stop after it.");
  if (/\}\}\s*\{\{/.test(body)) problems.push("Two variables can't sit next to each other. Put some words between them.");
  if (body.length > TEMPLATE_BODY_LIMIT) problems.push(`Keep the message under ${TEMPLATE_BODY_LIMIT} characters.`);
  return problems;
}

export const TEMPLATE_LANGUAGES = [
  { value: "en_US", label: "English (US)" },
  { value: "en_GB", label: "English (UK)" },
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
  { value: "ml", label: "Malayalam" },
  { value: "ta", label: "Tamil" },
  { value: "kn", label: "Kannada" },
  { value: "te", label: "Telugu" },
  { value: "mr", label: "Marathi" }
];

export const languageLabel = (code?: string) => TEMPLATE_LANGUAGES.find((l) => l.value === code)?.label || code || "—";
