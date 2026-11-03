import { useState } from "react";
import { CheckCircle2, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/data";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { plural } from "@/lib/format";
import { statusMeta, type MetaTemplate, type StarterTemplate } from "./whatsappMeta";

/**
 * The templates the ERP's own sends are written for, with where each one
 * stands on the account and a one-click submit for any that are missing.
 */
export function StarterTemplates({
  starters,
  templates,
  canEdit,
  onSubmitted,
  onPreview
}: {
  starters: StarterTemplate[];
  templates: MetaTemplate[];
  canEdit: boolean;
  onSubmitted: () => void;
  onPreview: (t: MetaTemplate) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string[]>([]);

  const onAccount = (s: StarterTemplate) => templates.find((t) => t.name === s.name);
  const missing = starters.filter((s) => !onAccount(s));
  const approved = starters.filter((s) => onAccount(s)?.status === "APPROVED").length;

  const submit = async (list: StarterTemplate[]) => {
    setBusy(list.map((s) => s.name));
    const failed: string[] = [];
    for (const s of list) {
      try {
        await apiClient.createMetaTemplate({ name: s.name, language: s.language, category: s.category, components: s.components });
      } catch (error: any) {
        failed.push(`${s.name}: ${error.message || "rejected"}`);
      }
    }
    setBusy([]);
    const sent = list.length - failed.length;
    if (sent) toast({ title: `${plural(sent, "template")} submitted`, description: "Meta reviews each one, usually within a day." });
    if (failed.length) toast({ title: "Some templates weren't accepted", description: failed.join(" · "), variant: "destructive" });
    onSubmitted();
  };

  if (!starters.length) return null;

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Templates the ERP sends</h2>
          <p className="text-xs text-muted-foreground">
            {missing.length ? `${plural(missing.length, "template")} not added yet` : `${approved} of ${starters.length} approved`}
          </p>
        </div>
        {canEdit && missing.length > 1 && (
          <Button size="xs" variant="subtle" onClick={() => submit(missing)} disabled={busy.length > 0}>
            {busy.length > 1 ? <Loader2 className="animate-spin" /> : <Plus />}
            Add all
          </Button>
        )}
      </div>
      <ul className="divide-y">
        {starters.map((s) => {
          const existing = onAccount(s);
          const st = existing && statusMeta(existing.status);
          return (
            <li key={s.name} className="flex items-center gap-3 px-4 py-2.5">
              <button
                type="button"
                onClick={() => onPreview(existing || { ...s, status: "" })}
                className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <p className="truncate text-sm font-medium">{s.purpose}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">{s.name}</p>
              </button>
              {st ? (
                <StatusPill tone={st.tone}>{st.label}</StatusPill>
              ) : canEdit ? (
                <Button size="xs" variant="outline" onClick={() => submit([s])} disabled={busy.length > 0}>
                  {busy.includes(s.name) ? <Loader2 className="animate-spin" /> : <Plus />}
                  Add
                </Button>
              ) : (
                <StatusPill>Not added</StatusPill>
              )}
            </li>
          );
        })}
      </ul>
      {!missing.length && approved === starters.length && (
        <div className="flex items-center gap-2 border-t bg-success-soft/50 px-4 py-2.5 text-xs text-success-strong">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Invoices, quotations and reminders are ready to send.
        </div>
      )}
    </section>
  );
}
