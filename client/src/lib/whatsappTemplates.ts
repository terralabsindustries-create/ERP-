// Meta only accepts exactly as many variables as the approved template's body actually declares
export function getTemplateBodyText(template: any): string {
  const bodyComponent = template?.components?.find((c: any) => c.type === "BODY");
  return bodyComponent?.text || "";
}

export function getTemplateVariableNumbers(template: any): number[] {
  const text = getTemplateBodyText(template);
  const matches = Array.from(text.matchAll(/\{\{(\d+)\}\}/g)).map((m: any) => Number(m[1]));
  return Array.from(new Set(matches)).sort((a, b) => a - b);
}
