import { useMemo, useRef, useState } from "react";
import { AlertCircle, Braces, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import {
  TEMPLATE_BODY_LIMIT,
  TEMPLATE_FOOTER_LIMIT,
  TEMPLATE_LANGUAGES,
  getVariableNumbers,
  normalizeTemplateName,
  templateBodyProblems
} from "@/lib/whatsappTemplates";
import { cn } from "@/lib/utils";
import { MessagePreview } from "./MessagePreview";

const EMPTY = { name: "", category: "UTILITY", language: "en_US", body: "", footer: "", samples: {} as Record<string, string> };

const CATEGORY_HELP: Record<string, string> = {
  UTILITY: "About something the customer already has with you: an order, invoice, payment or delivery.",
  MARKETING: "Offers, promotions and announcements. Meta charges more for these, and customers can block them."
};

/**
 * Writes a new message template and submits it to Meta for review, with a live
 * preview and Meta's body rules checked as you type.
 */
export function CreateTemplateDialog({
  open,
  onOpenChange,
  existing,
  sender,
  onCreated
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Templates already on the account, to catch a name that's taken. */
  existing: { name: string; language: string }[];
  sender?: string;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const name = normalizeTemplateName(form.name);
  const vars = useMemo(() => getVariableNumbers(form.body), [form.body]);
  const bodyProblems = templateBodyProblems(form.body);
  const taken = !!name && existing.some((t) => t.name === name && t.language === form.language);
  const missingSamples = vars.filter((n) => !form.samples[n]?.trim());
  const footerProblem = /\{\{/.test(form.footer)
    ? "The footer can't contain variables."
    : form.footer.length > TEMPLATE_FOOTER_LIMIT
      ? `Keep the footer under ${TEMPLATE_FOOTER_LIMIT} characters.`
      : null;
  const ready = !!name && !!form.body.trim() && !bodyProblems.length && !taken && !missingSamples.length && !footerProblem;

  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Puts the next {{n}} where the cursor is, so variables stay numbered in order.
  const insertVariable = () => {
    const token = `{{${(vars.length ? Math.max(...vars) : 0) + 1}}}`;
    const el = bodyRef.current;
    const at = el ? el.selectionStart : form.body.length;
    const end = el ? el.selectionEnd : form.body.length;
    set("body", form.body.slice(0, at) + token + form.body.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const submit = async () => {
    if (!ready) return;
    setSaving(true);
    try {
      const body = form.body.trim();
      const components: any[] = [
        { type: "BODY", text: body, ...(vars.length ? { example: { body_text: [vars.map((n) => form.samples[n].trim())] } } : {}) }
      ];
      if (form.footer.trim()) components.push({ type: "FOOTER", text: form.footer.trim() });
      await apiClient.createMetaTemplate({ name, language: form.language, category: form.category, components });
      toast({ title: "Template submitted", description: `${name} is with Meta for review. It can be sent once approved.` });
      setForm(EMPTY);
      onOpenChange(false);
      onCreated();
    } catch (error: any) {
      toast({ title: "Meta didn't accept the template", description: error.message || "Failed to create template.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>New message template</DialogTitle>
          <DialogDescription>Meta reviews every template before it can be sent. Approval usually takes a few minutes, at most a day.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">Template name</Label>
              <Input id="tpl-name" placeholder="e.g. order_ready_for_pickup" value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus />
              {taken ? (
                <p className="text-xs text-destructive-strong">A template called {name} already exists in this language.</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {name && name !== form.name ? (
                    <>
                      Saved as <span className="font-mono text-foreground">{name}</span>
                    </>
                  ) : (
                    "Lowercase letters, numbers and underscores. Customers never see it."
                  )}
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => set("category", v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UTILITY">Utility</SelectItem>
                    <SelectItem value="MARKETING">Marketing</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Language</Label>
                <Select value={form.language} onValueChange={(v) => set("language", v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_LANGUAGES.map((l) => (
                      <SelectItem key={l.value} value={l.value}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="-mt-2 text-xs text-muted-foreground sm:col-span-2">{CATEGORY_HELP[form.category]}</p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-end justify-between gap-2">
                <Label htmlFor="tpl-body">Message</Label>
                <Button type="button" variant="outline" size="xs" onClick={insertVariable}>
                  <Braces />
                  Add variable
                </Button>
              </div>
              <Textarea
                id="tpl-body"
                ref={bodyRef}
                rows={6}
                placeholder={"Hi {{1}}, your order {{2}} is ready for pickup at our shop.\n\nThank you!"}
                value={form.body}
                onChange={(e) => set("body", e.target.value)}
              />
              <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                <span>Variables like {"{{1}}"} are filled in for each customer when the message is sent.</span>
                <span className={cn("num shrink-0", form.body.length > TEMPLATE_BODY_LIMIT && "text-destructive-strong")}>
                  {form.body.length}/{TEMPLATE_BODY_LIMIT}
                </span>
              </div>
              {bodyProblems.length > 0 && (
                <ul className="space-y-1 rounded-md border border-destructive/25 bg-destructive-soft px-3 py-2 text-xs text-destructive-strong">
                  {bodyProblems.map((p) => (
                    <li key={p} className="flex gap-1.5">
                      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {vars.length > 0 && (
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <div>
                  <p className="text-sm font-medium">Sample values</p>
                  <p className="text-xs text-muted-foreground">Meta's reviewers see these instead of the variables. Use realistic examples.</p>
                </div>
                {vars.map((n) => (
                  <div key={n} className="flex items-center gap-2">
                    <span className="w-12 shrink-0 rounded bg-info-soft py-1 text-center font-mono text-xs text-info-strong">{`{{${n}}}`}</span>
                    <Input
                      className="h-8"
                      value={form.samples[n] || ""}
                      onChange={(e) => set("samples", { ...form.samples, [n]: e.target.value })}
                      placeholder={n === 1 ? "e.g. Rajesh Kumar" : `Example for {{${n}}}`}
                      aria-label={`Sample value for variable ${n}`}
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="tpl-footer">
                Footer <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input id="tpl-footer" placeholder="e.g. Reply STOP to opt out" value={form.footer} onChange={(e) => set("footer", e.target.value)} />
              {footerProblem && <p className="text-xs text-destructive-strong">{footerProblem}</p>}
            </div>
          </div>

          <div className="space-y-2 md:sticky md:top-0 md:self-start">
            <p className="section-label">Preview</p>
            <MessagePreview body={form.body} footer={form.footer} values={form.samples} sender={sender} placeholder="Start typing the message to see it here." />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:items-center">
          {!ready && form.body.trim() && missingSamples.length > 0 && !bodyProblems.length && (
            <p className="mr-auto text-xs text-muted-foreground">Add a sample value for {missingSamples.map((n) => `{{${n}}}`).join(", ")}.</p>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!ready || saving}>
            {saving && <Loader2 className="animate-spin" />}
            Submit for review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
