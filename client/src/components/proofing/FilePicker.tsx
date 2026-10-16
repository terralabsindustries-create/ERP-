import { useEffect, useRef, useState } from "react";
import { FileArchive, FileText, ImageIcon, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { PROOF_ACCEPT, fileProblem, fmtBytes } from "./proofMeta";

function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = file.type.startsWith("image/") && file.type !== "image/svg+xml";
  useEffect(() => {
    if (!isImage) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, isImage]);
  if (url) return <img src={url} alt="" className="h-10 w-10 shrink-0 rounded-md border object-cover" />;
  const Icon = file.type.startsWith("image/") ? ImageIcon : /zip|rar/.test(file.name.toLowerCase()) ? FileArchive : FileText;
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <Icon className="h-5 w-5" />
    </span>
  );
}

/**
 * Pick or drop the proof files. Checks type and size before anything is
 * uploaded; the upload itself happens when the form is saved.
 */
export function FilePicker({ files, onChange, disabled, id }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean; id?: string }) {
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const add = (list: FileList | null) => {
    if (!list?.length) return;
    const picked = Array.from(list);
    const problems = picked.map(fileProblem).filter((p): p is string => !!p);
    const ok = picked.filter((f) => !fileProblem(f) && !files.some((x) => x.name === f.name && x.size === f.size));
    if (problems.length) toast({ title: problems.length === 1 ? "File not added" : `${problems.length} files not added`, description: problems.join(". "), variant: "destructive" });
    if (ok.length) onChange([...files, ...ok]);
  };

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) add(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-5 text-center transition-colors",
          over ? "border-primary bg-primary-soft/40" : "bg-muted/30",
          disabled && "opacity-60"
        )}
      >
        <Upload className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm">
          Drop files here or{" "}
          <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="font-medium text-primary underline-offset-4 hover:underline disabled:no-underline">
            choose files
          </button>
        </p>
        <p className="text-xs text-muted-foreground">PDF, JPG, PNG, GIF, SVG, ZIP or RAR · up to 50 MB each</p>
        <input
          ref={input}
          id={id}
          type="file"
          multiple
          accept={PROOF_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {files.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${i}`} className="flex items-center gap-3 px-3 py-2">
              <Thumb file={f} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{f.name}</div>
                <div className="text-xs text-muted-foreground">{fmtBytes(f.size)}</div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
