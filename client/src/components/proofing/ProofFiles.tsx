import { useEffect, useState } from "react";
import { Download, ExternalLink, FileArchive, FileText, ImageOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { downloadProofFile, fetchProofFile, openProofFile, type ProofFile } from "@/lib/api/proofs";
import { cn } from "@/lib/utils";
import { fileExt, fileKind, fmtBytes } from "./proofMeta";

/** An image proof, fetched with the login's token (files are not public). */
function AuthImage({ file, className }: { file: ProofFile; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!file.fileId) {
      setFailed(true);
      return;
    }
    let alive = true;
    let objectUrl: string | null = null;
    setFailed(false);
    fetchProofFile(file.fileId)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.fileId]);

  if (failed)
    return (
      <div className={cn("flex flex-col items-center justify-center gap-1 bg-muted text-xs text-muted-foreground", className)}>
        <ImageOff className="h-5 w-5" />
        Preview not available
      </div>
    );
  if (!url)
    return (
      <div className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}>
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  return <img src={url} alt={file.fileName} className={cn("bg-muted object-contain", className)} />;
}

function FileIconBox({ file, className }: { file: ProofFile; className?: string }) {
  const kind = fileKind(file);
  const Icon = kind === "pdf" ? FileText : /ZIP|RAR/.test(fileExt(file)) ? FileArchive : FileText;
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1.5 bg-muted text-muted-foreground", className)}>
      <Icon className="h-8 w-8" />
      <span className="rounded bg-background px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-foreground">{fileExt(file) || "FILE"}</span>
    </div>
  );
}

function useFileActions() {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (error) {
      toast({ title: "The file could not be opened", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/** The files of one proof version: image previews, and open / download for every file. */
export function ProofFiles({ files, className }: { files: ProofFile[]; className?: string }) {
  const { busy, run } = useFileActions();
  if (!files.length) return <p className="text-sm text-muted-foreground">No files.</p>;
  const single = files.length === 1;
  return (
    <ul className={cn("grid gap-3", single ? "grid-cols-1" : "sm:grid-cols-2", className)}>
      {files.map((f, i) => {
        const key = f.fileId || `${f.fileName}-${i}`;
        const kind = fileKind(f);
        const preview = cn("w-full", single ? "aspect-[4/3] max-h-[420px]" : "aspect-[4/3]");
        return (
          <li key={key} className="overflow-hidden rounded-lg border bg-card">
            {kind === "image" ? (
              <button type="button" className="block w-full" onClick={() => run(`open-${key}`, () => openProofFile(f))} aria-label={`Open ${f.fileName}`}>
                <AuthImage file={f} className={preview} />
              </button>
            ) : (
              <FileIconBox file={f} className={cn(preview, single && "aspect-[16/7]")} />
            )}
            <div className="flex items-center gap-2 border-t px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" title={f.fileName}>
                  {f.fileName}
                </div>
                <div className="text-xs text-muted-foreground">
                  {fileExt(f)} · {fmtBytes(f.fileSize)}
                </div>
              </div>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Open ${f.fileName}`} disabled={!!busy} onClick={() => run(`open-${key}`, () => openProofFile(f))}>
                {busy === `open-${key}` ? <Loader2 className="animate-spin" /> : <ExternalLink />}
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Download ${f.fileName}`} disabled={!!busy} onClick={() => run(`dl-${key}`, () => downloadProofFile(f))}>
                {busy === `dl-${key}` ? <Loader2 className="animate-spin" /> : <Download />}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Compact file chips for older versions: name, open and download. */
export function ProofFileChips({ files }: { files: ProofFile[] }) {
  const { busy, run } = useFileActions();
  return (
    <ul className="flex flex-wrap gap-2">
      {files.map((f, i) => {
        const key = f.fileId || `${f.fileName}-${i}`;
        return (
          <li key={key} className="flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-muted/30 py-0.5 pl-2 pr-0.5 text-xs">
            <span className="truncate" title={f.fileName}>
              {f.fileName}
            </span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Open ${f.fileName}`} disabled={!!busy} onClick={() => run(`open-${key}`, () => openProofFile(f))}>
              {busy === `open-${key}` ? <Loader2 className="animate-spin" /> : <ExternalLink />}
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Download ${f.fileName}`} disabled={!!busy} onClick={() => run(`dl-${key}`, () => downloadProofFile(f))}>
              {busy === `dl-${key}` ? <Loader2 className="animate-spin" /> : <Download />}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
