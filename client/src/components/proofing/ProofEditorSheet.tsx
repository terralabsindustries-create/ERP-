import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EditorSection, EditorSheet } from "@/components/users/EditorSheet";
import { useToast } from "@/hooks/use-toast";
import { proofsApi, uploadProofFiles, type ColorMode, type JobOption, type Proof, type ProofInput, type UploadedFile } from "@/lib/api/proofs";
import { cn } from "@/lib/utils";
import { FilePicker } from "./FilePicker";
import { JobPicker } from "./JobPicker";
import { FINISHING, PAPER_SIZES, PAPER_TYPES, jobIdOf } from "./proofMeta";

interface FormState {
  jobId: string;
  title: string;
  description: string;
  paperSize: string;
  paperType: string;
  colorMode: ColorMode;
  quantity: string;
  finishing: string[];
  specialInstructions: string;
}

const EMPTY: FormState = { jobId: "", title: "", description: "", paperSize: "", paperType: "", colorMode: "color", quantity: "", finishing: [], specialInstructions: "" };

const fromProof = (p: Proof): FormState => ({
  jobId: jobIdOf(p),
  title: p.title,
  description: p.description || "",
  paperSize: p.specifications?.paperSize || "",
  paperType: p.specifications?.paperType || "",
  colorMode: p.specifications?.colorMode || "color",
  quantity: p.specifications?.quantity ? String(p.specifications.quantity) : "",
  finishing: p.specifications?.finishing || [],
  specialInstructions: p.specifications?.specialInstructions || ""
});

export type SavedAs = "draft" | "sent" | "edit";

/** New proof (job, details, specifications, files) or editing an existing one's details. */
export function ProofEditorSheet({
  open,
  onOpenChange,
  proof,
  onSaved
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing this proof; leave out to create one. */
  proof?: Proof | null;
  onSaved: (proof: Proof, savedAs: SavedAs) => void;
}) {
  const { toast } = useToast();
  const editing = !!proof;
  const [form, setForm] = useState<FormState>(EMPTY);
  const [files, setFiles] = useState<File[]>([]);
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [saving, setSaving] = useState<SavedAs | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [otherFinish, setOtherFinish] = useState("");
  const uploaded = useRef(new WeakMap<File, UploadedFile>());

  useEffect(() => {
    if (!open) return;
    setForm(proof ? fromProof(proof) : EMPTY);
    setFiles([]);
    setOtherFinish("");
    uploaded.current = new WeakMap();
    let alive = true;
    setJobsLoading(true);
    proofsApi
      .jobs()
      .then((list) => alive && setJobs(list))
      .catch((error) => alive && toast({ title: "Jobs could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" }))
      .finally(() => alive && setJobsLoading(false));
    return () => {
      alive = false;
    };
  }, [open, proof, toast]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const pickJob = (job: JobOption) => {
    setForm((f) => {
      if (editing) return { ...f, jobId: job._id };
      const s = job.printSpecs || {};
      return {
        ...f,
        jobId: job._id,
        title: f.title || job.title,
        paperSize: f.paperSize || s.printSize || "",
        paperType: f.paperType || s.paperType || "",
        colorMode: s.colorType || f.colorMode,
        quantity: f.quantity || (s.quantity && s.quantity > 1 ? String(s.quantity) : "")
      };
    });
  };

  const toggleFinish = (name: string) => set("finishing", form.finishing.includes(name) ? form.finishing.filter((x) => x !== name) : [...form.finishing, name]);
  const addOtherFinish = () => {
    const v = otherFinish.trim();
    if (!v) return;
    if (!form.finishing.some((x) => x.toLowerCase() === v.toLowerCase())) set("finishing", [...form.finishing, v]);
    setOtherFinish("");
  };

  const payload = (): ProofInput => ({
    jobId: form.jobId,
    title: form.title.trim(),
    description: form.description.trim(),
    specifications: {
      paperSize: form.paperSize.trim(),
      paperType: form.paperType.trim(),
      colorMode: form.colorMode,
      quantity: form.quantity ? Number(form.quantity) : undefined,
      finishing: form.finishing,
      specialInstructions: form.specialInstructions.trim()
    }
  });

  const save = async (as: SavedAs) => {
    if (saving) return;
    const job = jobs.find((j) => j._id === form.jobId);
    if (!form.jobId || (!editing && !job)) return toast({ title: "Choose the job this proof is for", variant: "destructive" });
    if (!form.title.trim()) return toast({ title: "Give the proof a title", variant: "destructive" });
    if (form.quantity && (!Number.isInteger(Number(form.quantity)) || Number(form.quantity) < 1)) return toast({ title: "Quantity must be a whole number above 0", variant: "destructive" });
    if (!editing && files.length === 0) return toast({ title: "Add the proof file", description: "Upload at least one PDF or image.", variant: "destructive" });

    setSaving(as);
    try {
      let saved: Proof;
      if (proof) {
        saved = await proofsApi.update(proof._id, payload());
      } else {
        const done = await uploadProofFiles(files, job!, (current, total) => setProgress({ current, total }), uploaded.current);
        setProgress(null);
        saved = await proofsApi.create({ ...payload(), files: done.map((f) => ({ fileId: f._id })), status: as === "sent" ? "sent" : "draft" });
      }
      onSaved(saved, as);
    } catch (error) {
      toast({ title: editing ? "Changes not saved" : "Proof not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(null);
      setProgress(null);
    }
  };

  const busyLabel = progress ? `Uploading ${progress.current} of ${progress.total}…` : "Saving…";

  return (
    <EditorSheet
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      wide
      title={editing ? `Edit ${proof?.proofNumber}` : "New proof"}
      description={editing ? "Change the details. To replace the artwork, upload a new version instead." : "Upload the artwork the customer has to approve before printing."}
      onSubmit={(e) => {
        e.preventDefault();
        save(editing ? "edit" : "draft");
      }}
      footer={
        <>
          <Button type="button" variant="outline" disabled={!!saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {editing ? (
            <Button type="submit" disabled={!!saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Check />}
              {saving ? "Saving…" : "Save changes"}
            </Button>
          ) : (
            <>
              <Button type="submit" variant="outline" disabled={!!saving}>
                {saving === "draft" && <Loader2 className="animate-spin" />}
                {saving === "draft" ? busyLabel : "Save as draft"}
              </Button>
              <Button type="button" disabled={!!saving} onClick={() => save("sent")}>
                {saving === "sent" ? <Loader2 className="animate-spin" /> : <Send />}
                {saving === "sent" ? busyLabel : "Save and mark sent"}
              </Button>
            </>
          )}
        </>
      }
    >
      <EditorSection title="Job" description="The customer comes from the job.">
        <JobPicker key={open ? proof?._id || "new" : "closed"} id="proof-job" jobs={jobs} loading={jobsLoading} value={form.jobId} onChange={pickJob} />
      </EditorSection>

      <EditorSection title="Proof">
        <div className="space-y-1.5">
          <Label htmlFor="proof-title">Title</Label>
          <Input id="proof-title" value={form.title} maxLength={200} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Visiting card, front and back" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="proof-description">Description</Label>
          <Textarea id="proof-description" rows={2} maxLength={2000} value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="Optional" />
        </div>
      </EditorSection>

      <EditorSection title="Print specifications" description="What the customer is approving, besides the artwork.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="proof-size">Paper size</Label>
            <Input id="proof-size" list="proof-size-options" value={form.paperSize} maxLength={100} onChange={(e) => set("paperSize", e.target.value)} placeholder="e.g. A4" />
            <datalist id="proof-size-options">
              {PAPER_SIZES.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="proof-paper">Paper type</Label>
            <Input id="proof-paper" list="proof-paper-options" value={form.paperType} maxLength={100} onChange={(e) => set("paperType", e.target.value)} placeholder="e.g. 300 gsm art card" />
            <datalist id="proof-paper-options">
              {PAPER_TYPES.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="proof-colour">Colour</Label>
            <Select value={form.colorMode} onValueChange={(v) => set("colorMode", v as ColorMode)}>
              <SelectTrigger id="proof-colour">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="color">Colour</SelectItem>
                <SelectItem value="black_white">Black &amp; white</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="proof-qty">Quantity</Label>
            <Input id="proof-qty" type="number" inputMode="numeric" min={1} step={1} value={form.quantity} onChange={(e) => set("quantity", e.target.value)} placeholder="e.g. 1000" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Finishing</Label>
          <div className="flex flex-wrap gap-1.5">
            {[...FINISHING, ...form.finishing.filter((f) => !FINISHING.includes(f))].map((name) => {
              const on = form.finishing.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleFinish(name)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on ? "border-primary/50 bg-primary-soft text-primary-strong" : "bg-background text-muted-foreground hover:text-foreground"
                  )}
                >
                  {on && <Check className="h-3 w-3" />}
                  {name}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2 pt-1">
            <Input
              aria-label="Other finishing"
              value={otherFinish}
              maxLength={60}
              onChange={(e) => setOtherFinish(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addOtherFinish();
                }
              }}
              placeholder="Other finishing"
              className="h-9"
            />
            <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={addOtherFinish} disabled={!otherFinish.trim()}>
              <Plus />
              Add
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="proof-instructions">Instructions</Label>
          <Textarea
            id="proof-instructions"
            rows={2}
            maxLength={2000}
            value={form.specialInstructions}
            onChange={(e) => set("specialInstructions", e.target.value)}
            placeholder="Optional, e.g. keep 3 mm bleed, match logo colour to the sample"
          />
        </div>
      </EditorSection>

      {!editing && (
        <EditorSection title="Files" description="Each file is uploaded when you save. Customers usually get a PDF or JPG.">
          <FilePicker id="proof-files" files={files} onChange={setFiles} disabled={!!saving} />
        </EditorSection>
      )}
    </EditorSheet>
  );
}
