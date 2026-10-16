import { useMemo, useState } from "react";
import { Calculator, ClipboardList, Copy, Printer, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/layout/PageHeader";
import { CreateQuotationDialog } from "@/components/quotations/CreateQuotationDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { estimate, type EstimateInput, type EstimateResult } from "@/lib/printEstimate";
import { formatINR } from "@/lib/printWorkflow";

/* ------------------------------------------------------------------ presets */

const PRODUCTS = [
  { id: "visiting-card", label: "Visiting card", width: 89, height: 51 },
  { id: "flyer-a5", label: "Flyer / leaflet A5", width: 148, height: 210 },
  { id: "flyer-a4", label: "Flyer / letterhead A4", width: 210, height: 297 },
  { id: "poster-a3", label: "Poster A3", width: 297, height: 420 },
  { id: "brochure", label: "Tri-fold brochure (A4 open)", width: 297, height: 210 },
  { id: "invitation", label: "Invitation card 7×10\"", width: 178, height: 254 },
  { id: "bill-book", label: "Bill book page A5", width: 148, height: 210 },
  { id: "label", label: "Sticker / label 100×50", width: 100, height: 50 },
  { id: "custom", label: "Custom size", width: 0, height: 0 },
];

const SHEETS = [
  { id: "demy", label: "Demy 18×23\"", width: 457, height: 584 },
  { id: "double-demy", label: "Double Demy 23×36\"", width: 584, height: 914 },
  { id: "crown", label: "Crown 15×20\"", width: 381, height: 508 },
  { id: "double-crown", label: "Double Crown 20×30\"", width: 508, height: 762 },
  { id: "royal", label: "Royal 20×25\"", width: 508, height: 635 },
  { id: "sra3", label: "SRA3 320×450 mm", width: 320, height: 450 },
  { id: "12x18", label: "12×18\"", width: 305, height: 457 },
  { id: "13x19", label: "13×19\"", width: 330, height: 483 },
  { id: "a3", label: "A3 297×420 mm", width: 297, height: 420 },
  { id: "custom", label: "Custom sheet", width: 0, height: 0 },
];

const FACTORY: EstimateInput = {
  quantity: 1000,
  width: 89,
  height: 51,
  bleed: 2,
  gutter: 0,
  sheetWidth: 457,
  sheetHeight: 584,
  margin: 8,
  gsm: 300,
  paperPricing: "kg",
  paperRatePerKg: 95,
  paperRatePerSheet: 6,
  wastagePercent: 5,
  makeReadySheets: 50,
  process: "offset",
  colorsFront: 4,
  colorsBack: 0,
  plateRate: 450,
  pressRatePer1000: 180,
  clickRateColor: 8,
  clickRateMono: 2,
  digitalColor: true,
  digitalSides: 1,
  lamination: { enabled: true, sides: 1, ratePerSheetSide: 3 },
  spotUv: { enabled: false, ratePerSheet: 2.5 },
  dieCut: { enabled: false, dieCost: 1500, ratePer1000Sheets: 400 },
  creaseFold: { enabled: false, ratePer1000Pieces: 250 },
  binding: { enabled: false, ratePerPiece: 6 },
  numbering: { enabled: false, ratePer1000Pieces: 150 },
  cuttingPacking: { enabled: true, fixed: 150 },
  designCharge: 0,
  otherCharge: 0,
  marginPercent: 25,
  gstPercent: 18,
};

const STORAGE_KEY = "terralabs.estimator.defaults";

const loadDefaults = (): EstimateInput => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { ...FACTORY, ...JSON.parse(saved) } : FACTORY;
  } catch {
    return FACTORY;
  }
};

/* -------------------------------------------------------------- small parts */

function Section({ title, description, children, aside }: { title: string; description?: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card shadow-card">
      <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
  prefix,
  step = "any",
  min = 0,
  className,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  prefix?: string;
  step?: string;
  min?: number;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      <div className="relative">
        {prefix && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{prefix}</span>}
        <Input
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className={cn("num", prefix && "pl-7", suffix && "pr-12")}
        />
        {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </label>
  );
}

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border bg-muted/70 p-0.5">
      {options.map(([key, label]) => (
        <button
          key={String(key)}
          type="button"
          onClick={() => onChange(key)}
          className={cn(
            "rounded-md px-3 py-1 text-[13px] font-medium transition-colors",
            value === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function FinishingRow({ label, hint, enabled, onToggle, children }: { label: string; hint: string; enabled: boolean; onToggle: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <div className={cn("grid grid-cols-1 items-center gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto]", !enabled && "opacity-70")}>
      <div className="flex items-center gap-3">
        <Switch checked={enabled} onCheckedChange={onToggle} aria-label={label} />
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">{hint}</div>
        </div>
      </div>
      <div className={cn("flex flex-wrap items-end gap-2 sm:justify-end", !enabled && "pointer-events-none")}>{children}</div>
    </div>
  );
}

/** The press sheet with the pieces laid out on it, to scale. */
function ImpositionPreview({ input, result }: { input: EstimateInput; result: EstimateResult }) {
  const { imposition: imp } = result;
  const W = input.sheetWidth;
  const H = input.sheetHeight;
  if (!W || !H) return null;
  const gridW = imp.across * imp.pieceWidth + Math.max(0, imp.across - 1) * input.gutter;
  const gridH = imp.down * imp.pieceHeight + Math.max(0, imp.down - 1) * input.gutter;
  const ox = (W - gridW) / 2;
  const oy = (H - gridH) / 2;
  const pieces = [];
  for (let r = 0; r < imp.down; r++) {
    for (let c = 0; c < imp.across; c++) {
      pieces.push(
        <rect
          key={`${r}-${c}`}
          x={ox + c * (imp.pieceWidth + input.gutter)}
          y={oy + r * (imp.pieceHeight + input.gutter)}
          width={imp.pieceWidth}
          height={imp.pieceHeight}
          className="fill-sky-100 stroke-sky-600"
          strokeWidth={Math.max(W, H) / 400}
        />
      );
    }
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="max-h-56 w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label={`${imp.ups} up on the sheet`}>
        <rect x={0} y={0} width={W} height={H} className="fill-white stroke-slate-400" strokeWidth={Math.max(W, H) / 250} />
        <rect
          x={input.margin}
          y={input.margin}
          width={Math.max(0, W - 2 * input.margin)}
          height={Math.max(0, H - 2 * input.margin)}
          className="fill-slate-50 stroke-slate-300"
          strokeDasharray={`${Math.max(W, H) / 80}`}
          strokeWidth={Math.max(W, H) / 400}
        />
        {pieces}
      </svg>
      <div className="text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{imp.ups}-up</span> · {imp.across} × {imp.down}
        {imp.rotated ? " (turned 90°)" : ""} · {(imp.utilisation * 100).toFixed(0)}% of sheet used
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- page */

export default function PrintEstimator() {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const [input, setInput] = useState<EstimateInput>(loadDefaults);
  const [jobName, setJobName] = useState("Visiting cards");
  const [paperName, setPaperName] = useState("Art card");
  const [productId, setProductId] = useState("visiting-card");
  const [sheetId, setSheetId] = useState(() => SHEETS.find((s) => s.width === input.sheetWidth && s.height === input.sheetHeight)?.id || "custom");
  const [sizeUnit, setSizeUnit] = useState<"mm" | "in">("mm");

  const set = <K extends keyof EstimateInput>(key: K, value: EstimateInput[K]) => setInput((prev) => ({ ...prev, [key]: value }));
  const setNested = <K extends "lamination" | "spotUv" | "dieCut" | "creaseFold" | "binding" | "numbering" | "cuttingPacking">(
    key: K,
    patch: Partial<EstimateInput[K]>
  ) => setInput((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const toUnit = (mm: number) => (sizeUnit === "in" ? Math.round((mm / 25.4) * 100) / 100 : mm);
  const fromUnit = (v: number) => (sizeUnit === "in" ? Math.round(v * 25.4 * 10) / 10 : v);

  const result = useMemo(() => estimate(input), [input]);

  const priceBreaks = useMemo(() => {
    const q = input.quantity;
    if (!q || q <= 0) return [];
    return [...new Set([q, q * 2, q * 5].map((n) => Math.round(n)))].map((quantity) => ({
      quantity,
      result: estimate({ ...input, quantity }),
    }));
  }, [input]);

  const colourLabel =
    input.process === "offset"
      ? `${input.colorsFront}/${input.colorsBack} colour offset`
      : `${input.digitalColor ? "Colour" : "B/W"} digital, ${input.digitalSides === 2 ? "both sides" : "one side"}`;
  const finishing = [
    input.lamination.enabled && `${input.lamination.sides === 2 ? "both-side" : "one-side"} lamination`,
    input.spotUv.enabled && "spot UV",
    input.dieCut.enabled && "die-cut",
    input.creaseFold.enabled && "creasing & folding",
    input.binding.enabled && "binding",
    input.numbering.enabled && "numbering",
  ].filter(Boolean);
  const specLine = [
    `${input.width}×${input.height} mm`,
    `${input.gsm} GSM ${paperName}`.trim(),
    colourLabel,
    ...finishing,
  ].join(" · ");

  const summaryText = () =>
    [
      `ESTIMATE — ${jobName || "Print job"}`,
      `Quantity: ${input.quantity.toLocaleString("en-IN")} pcs`,
      `Spec: ${specLine}`,
      ``,
      ...result.lines.map((l) => `${l.label.padEnd(24)} ${formatINR(l.amount)}`),
      `${"Cost".padEnd(24)} ${formatINR(result.cost)}`,
      `${`Margin (${input.marginPercent}%)`.padEnd(24)} ${formatINR(result.profit)}`,
      `${"Taxable value".padEnd(24)} ${formatINR(result.taxable)}`,
      `${`GST (${input.gstPercent}%)`.padEnd(24)} ${formatINR(result.gst)}`,
      `${"TOTAL".padEnd(24)} ${formatINR(result.total)}`,
      `Per piece: ₹${result.perPiece.toFixed(2)} + GST`,
    ].join("\n");

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryText());
      toast({ title: "Estimate copied", description: "Paste it into WhatsApp, email or a note." });
    } catch {
      toast({ title: "Could not copy", description: "Your browser blocked clipboard access.", variant: "destructive" });
    }
  };

  const saveDefaults = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(input));
      toast({ title: "Saved as your shop rates", description: "New estimates on this device will start from these values." });
    } catch {
      toast({ title: "Could not save", description: "This browser does not allow saving settings.", variant: "destructive" });
    }
  };

  const reset = () => {
    const d = loadDefaults();
    setInput(d);
    setProductId("custom");
    setSheetId(SHEETS.find((s) => s.width === d.sheetWidth && s.height === d.sheetHeight)?.id || "custom");
  };

  // Quotations price per piece to the paisa; round up so the quote never
  // comes in under the estimate.
  const quotedRate = Math.ceil(Math.round(result.perPiece * 1e6) / 1e4) / 100;
  const quotationItems = result.error
    ? []
    : [
        {
          item_name: `${jobName || "Print job"}`,
          description: specLine,
          quantity: input.quantity,
          unit: "pieces",
          unit_price: quotedRate,
        },
      ];

  return (
    <div className="page-frame">
      <PageHeader
        eyebrow="Sales & Estimating"
        title="Print Estimator"
        description="Price a print job from sheet imposition, paper, plates, press time and finishing."
        actions={
          <>
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={reset}>
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={saveDefaults}>
              <Save className="h-3.5 w-3.5" /> Save as shop rates
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* ---------------- inputs */}
        <div className="space-y-5 print:hidden">
          <Section
            title="Job"
            description="What is being printed and how many"
            aside={<Segmented<"mm" | "in"> value={sizeUnit} options={[["mm", "mm"], ["in", "inch"]]} onChange={setSizeUnit} />}
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Job name</span>
                <Input value={jobName} onChange={(e) => setJobName(e.target.value)} placeholder="e.g. Visiting cards – Kumar Textiles" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Product</span>
                <Select
                  value={productId}
                  onValueChange={(id) => {
                    setProductId(id);
                    const p = PRODUCTS.find((x) => x.id === id);
                    if (p && p.width) {
                      setInput((prev) => ({ ...prev, width: p.width, height: p.height }));
                      if (!jobName || PRODUCTS.some((x) => jobName.toLowerCase().startsWith(x.label.toLowerCase().split(" ")[0]))) {
                        setJobName(p.label.replace(/ \(.*\)$/, ""));
                      }
                    }
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRODUCTS.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              <Field label="Quantity" value={input.quantity} onChange={(v) => set("quantity", v)} suffix="pcs" step="1" />
              <Field
                label="Finished width"
                value={toUnit(input.width)}
                onChange={(v) => { setProductId("custom"); set("width", fromUnit(v)); }}
                suffix={sizeUnit}
              />
              <Field
                label="Finished height"
                value={toUnit(input.height)}
                onChange={(v) => { setProductId("custom"); set("height", fromUnit(v)); }}
                suffix={sizeUnit}
              />
              <Field label="Bleed (each side)" value={input.bleed} onChange={(v) => set("bleed", v)} suffix="mm" />
            </div>
          </Section>

          <Section title="Paper & sheet" description="Press sheet, stock and spoilage">
            <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1fr)_260px]">
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Press sheet</span>
                    <Select
                      value={sheetId}
                      onValueChange={(id) => {
                        setSheetId(id);
                        const s = SHEETS.find((x) => x.id === id);
                        if (s && s.width) setInput((prev) => ({ ...prev, sheetWidth: s.width, sheetHeight: s.height }));
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SHEETS.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Paper / board</span>
                    <Input value={paperName} onChange={(e) => setPaperName(e.target.value)} placeholder="e.g. Art card, Maplitho, Chromo" />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <Field label="Sheet width" value={toUnit(input.sheetWidth)} onChange={(v) => { setSheetId("custom"); set("sheetWidth", fromUnit(v)); }} suffix={sizeUnit} />
                  <Field label="Sheet height" value={toUnit(input.sheetHeight)} onChange={(v) => { setSheetId("custom"); set("sheetHeight", fromUnit(v)); }} suffix={sizeUnit} />
                  <Field label="Gripper margin" value={input.margin} onChange={(v) => set("margin", v)} suffix="mm" />
                  <Field label="Gap between pieces" value={input.gutter} onChange={(v) => set("gutter", v)} suffix="mm" />
                </div>
                <div className="flex items-center justify-between gap-3 pt-1">
                  <span className="text-xs font-medium text-muted-foreground">Paper is priced</span>
                  <Segmented<"kg" | "sheet">
                    value={input.paperPricing}
                    options={[["kg", "Per kg"], ["sheet", "Per sheet"]]}
                    onChange={(v) => set("paperPricing", v)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <Field label="GSM" value={input.gsm} onChange={(v) => set("gsm", v)} suffix="g/m²" step="1" />
                  {input.paperPricing === "kg" ? (
                    <Field label="Rate per kg" value={input.paperRatePerKg} onChange={(v) => set("paperRatePerKg", v)} prefix="₹" />
                  ) : (
                    <Field label="Rate per sheet" value={input.paperRatePerSheet} onChange={(v) => set("paperRatePerSheet", v)} prefix="₹" />
                  )}
                  <Field label="Running waste" value={input.wastagePercent} onChange={(v) => set("wastagePercent", v)} suffix="%" />
                  <Field label="Make-ready sheets" value={input.makeReadySheets} onChange={(v) => set("makeReadySheets", v)} suffix="sheets" step="1" />
                </div>
              </div>
              <div className="rounded-lg border bg-muted/40 p-4 2xl:self-start">
                <div className="section-label mb-3">Imposition on the press sheet</div>
                <ImpositionPreview input={input} result={result} />
              </div>
            </div>
          </Section>

          <Section
            title="Printing"
            description="Offset press or digital machine"
            aside={
              <Segmented<"offset" | "digital">
                value={input.process}
                options={[["offset", "Offset"], ["digital", "Digital"]]}
                onChange={(v) =>
                  setInput((prev) => ({
                    ...prev,
                    process: v,
                    makeReadySheets: v === "digital" ? Math.min(prev.makeReadySheets, 5) : Math.max(prev.makeReadySheets, 50),
                  }))
                }
              />
            }
          >
            {input.process === "offset" ? (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Colours — front</span>
                  <Select value={String(input.colorsFront)} onValueChange={(v) => set("colorsFront", Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[0, 1, 2, 3, 4, 5, 6].map((n) => <SelectItem key={n} value={String(n)}>{n === 4 ? "4 (CMYK)" : n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Colours — back</span>
                  <Select value={String(input.colorsBack)} onValueChange={(v) => set("colorsBack", Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[0, 1, 2, 3, 4, 5, 6].map((n) => <SelectItem key={n} value={String(n)}>{n === 0 ? "0 (blank)" : n === 4 ? "4 (CMYK)" : n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <Field label="Plate rate" value={input.plateRate} onChange={(v) => set("plateRate", v)} prefix="₹" suffix="/plate" />
                <Field label="Press rate" value={input.pressRatePer1000} onChange={(v) => set("pressRatePer1000", v)} prefix="₹" suffix="/1000" />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Print</span>
                  <Segmented<"c" | "m"> value={input.digitalColor ? "c" : "m"} options={[["c", "Colour"], ["m", "B/W"]]} onChange={(v) => set("digitalColor", v === "c")} />
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Sides</span>
                  <Segmented<1 | 2> value={input.digitalSides} options={[[1, "One"], [2, "Both"]]} onChange={(v) => set("digitalSides", v)} />
                </div>
                <Field label="Colour click" value={input.clickRateColor} onChange={(v) => set("clickRateColor", v)} prefix="₹" suffix="/side" />
                <Field label="B/W click" value={input.clickRateMono} onChange={(v) => set("clickRateMono", v)} prefix="₹" suffix="/side" />
              </div>
            )}
          </Section>

          <Section title="Finishing" description="Post-press operations, priced at your rates">
            <div className="divide-y">
              <FinishingRow label="Lamination" hint="Thermal gloss / matt, per sheet side" enabled={input.lamination.enabled} onToggle={(v) => setNested("lamination", { enabled: v })}>
                <Segmented<1 | 2> value={input.lamination.sides} options={[[1, "1 side"], [2, "2 sides"]]} onChange={(v) => setNested("lamination", { sides: v })} />
                <Field className="w-32" label="Rate" value={input.lamination.ratePerSheetSide} onChange={(v) => setNested("lamination", { ratePerSheetSide: v })} prefix="₹" suffix="/side" />
              </FinishingRow>
              <FinishingRow label="Spot UV" hint="Per sheet" enabled={input.spotUv.enabled} onToggle={(v) => setNested("spotUv", { enabled: v })}>
                <Field className="w-32" label="Rate" value={input.spotUv.ratePerSheet} onChange={(v) => setNested("spotUv", { ratePerSheet: v })} prefix="₹" suffix="/sheet" />
              </FinishingRow>
              <FinishingRow label="Die-cutting" hint="Die making plus punching per 1,000 sheets" enabled={input.dieCut.enabled} onToggle={(v) => setNested("dieCut", { enabled: v })}>
                <Field className="w-28" label="Die cost" value={input.dieCut.dieCost} onChange={(v) => setNested("dieCut", { dieCost: v })} prefix="₹" />
                <Field className="w-32" label="Punching" value={input.dieCut.ratePer1000Sheets} onChange={(v) => setNested("dieCut", { ratePer1000Sheets: v })} prefix="₹" suffix="/1000" />
              </FinishingRow>
              <FinishingRow label="Creasing & folding" hint="Per 1,000 pieces" enabled={input.creaseFold.enabled} onToggle={(v) => setNested("creaseFold", { enabled: v })}>
                <Field className="w-32" label="Rate" value={input.creaseFold.ratePer1000Pieces} onChange={(v) => setNested("creaseFold", { ratePer1000Pieces: v })} prefix="₹" suffix="/1000" />
              </FinishingRow>
              <FinishingRow label="Binding" hint="Centre-stitch, perfect or wiro — per copy" enabled={input.binding.enabled} onToggle={(v) => setNested("binding", { enabled: v })}>
                <Field className="w-32" label="Rate" value={input.binding.ratePerPiece} onChange={(v) => setNested("binding", { ratePerPiece: v })} prefix="₹" suffix="/pc" />
              </FinishingRow>
              <FinishingRow label="Numbering / perforation" hint="Bill books, tickets — per 1,000 pieces" enabled={input.numbering.enabled} onToggle={(v) => setNested("numbering", { enabled: v })}>
                <Field className="w-32" label="Rate" value={input.numbering.ratePer1000Pieces} onChange={(v) => setNested("numbering", { ratePer1000Pieces: v })} prefix="₹" suffix="/1000" />
              </FinishingRow>
              <FinishingRow label="Cutting & packing" hint="Fixed charge per job" enabled={input.cuttingPacking.enabled} onToggle={(v) => setNested("cuttingPacking", { enabled: v })}>
                <Field className="w-32" label="Charge" value={input.cuttingPacking.fixed} onChange={(v) => setNested("cuttingPacking", { fixed: v })} prefix="₹" />
              </FinishingRow>
            </div>
          </Section>

          <Section title="Charges & pricing" description="Design time, outside work, your margin and GST">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Field label="Design & pre-press" value={input.designCharge} onChange={(v) => set("designCharge", v)} prefix="₹" />
              <Field label="Other / outsourced" value={input.otherCharge} onChange={(v) => set("otherCharge", v)} prefix="₹" />
              <Field label="Margin" value={input.marginPercent} onChange={(v) => set("marginPercent", v)} suffix="%" />
              <Field label="GST" value={input.gstPercent} onChange={(v) => set("gstPercent", v)} suffix="%" />
            </div>
          </Section>
        </div>

        {/* ---------------- summary */}
        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start print:col-span-full">
          <div className="overflow-hidden rounded-xl border bg-card shadow-card">
            <div className="cmyk-strip h-1" />
            <div className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="section-label">Estimate</div>
                  <div className="mt-1 truncate text-base font-semibold">{jobName || "Print job"}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{specLine}</div>
                </div>
                <Calculator className="h-5 w-5 shrink-0 text-muted-foreground" />
              </div>

              {result.error ? (
                <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{result.error}</div>
              ) : (
                <>
                  <div className="mt-5 rounded-lg bg-slate-900 p-4 text-white print:border print:bg-white print:text-black">
                    <div className="text-xs text-slate-400 print:text-slate-600">Quote for {input.quantity.toLocaleString("en-IN")} pcs (incl. GST)</div>
                    <div className="num mt-1 text-3xl font-semibold tracking-tight">{formatINR(result.total)}</div>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-300 print:text-slate-600">
                      <span>₹{result.perPiece.toFixed(2)} / pc + GST</span>
                      <span>₹{result.perPieceWithGst.toFixed(2)} / pc incl.</span>
                    </div>
                  </div>

                  <div className="mt-5 space-y-2.5">
                    {result.lines.map((line) => (
                      <div key={line.key}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="font-medium">{line.label}</span>
                          <span className="num">{formatINR(line.amount)}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary/70" style={{ width: `${result.cost ? (line.amount / result.cost) * 100 : 0}%` }} />
                          </div>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{line.detail}</div>
                      </div>
                    ))}
                  </div>

                  <dl className="mt-5 space-y-1.5 border-t pt-4 text-sm">
                    {[
                      ["Production cost", result.cost],
                      [`Margin (${input.marginPercent}%)`, result.profit],
                      ["Taxable value", result.taxable],
                      [`GST (${input.gstPercent}%)`, result.gst],
                    ].map(([k, v]) => (
                      <div key={k as string} className="flex justify-between">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="num">{formatINR(v as number)}</dd>
                      </div>
                    ))}
                    <div className="flex justify-between border-t pt-2 font-semibold">
                      <dt>Total</dt>
                      <dd className="num">{formatINR(result.total)}</dd>
                    </div>
                  </dl>
                </>
              )}

              <div className="mt-5 grid grid-cols-2 gap-2 print:hidden">
                {hasPermission("Quotations: Create & Edit") && !result.error && (
                  <CreateQuotationDialog initialItems={quotationItems}>
                    <Button className="col-span-2 gap-1.5">
                      <ClipboardList className="h-4 w-4" /> Create quotation
                    </Button>
                  </CreateQuotationDialog>
                )}
                {hasPermission("Quotations: Create & Edit") && !result.error && (
                  <p className="col-span-2 -mt-0.5 text-center text-[11px] text-muted-foreground">
                    Quoted at ₹{quotedRate.toFixed(2)}/pc × {input.quantity.toLocaleString("en-IN")} pcs (quotations carry no GST)
                  </p>
                )}
                <Button variant="outline" className="gap-1.5" onClick={copySummary} disabled={!!result.error}>
                  <Copy className="h-4 w-4" /> Copy
                </Button>
                <Button variant="outline" className="gap-1.5" onClick={() => window.print()} disabled={!!result.error}>
                  <Printer className="h-4 w-4" /> Print
                </Button>
              </div>
            </div>
          </div>

          {!result.error && (
            <div className="rounded-xl border bg-card p-5 shadow-card">
              <div className="section-label mb-3">Production sheet</div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                {[
                  ["Imposition", `${result.imposition.ups}-up${result.imposition.rotated ? " (turned)" : ""}`],
                  ["Good sheets", result.netSheets.toLocaleString("en-IN")],
                  ["Waste sheets", result.wasteSheets.toLocaleString("en-IN")],
                  ["Total sheets", result.totalSheets.toLocaleString("en-IN")],
                  ["Paper weight", `${result.paperKg.toFixed(2)} kg`],
                  [input.process === "offset" ? "Plates" : "Clicks", input.process === "offset" ? result.plates : result.impressions.toLocaleString("en-IN")],
                ].map(([k, v]) => (
                  <div key={k as string}>
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd className="num font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {!result.error && priceBreaks.length > 1 && (
            <div className="rounded-xl border bg-card shadow-card">
              <div className="border-b px-5 py-3">
                <div className="section-label">Price breaks</div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-2 font-semibold">Qty</th>
                    <th className="px-2 py-2 text-right font-semibold">Per pc</th>
                    <th className="px-5 py-2 text-right font-semibold">Total incl. GST</th>
                  </tr>
                </thead>
                <tbody>
                  {priceBreaks.map(({ quantity, result: r }) => (
                    <tr key={quantity} className={cn("border-t", quantity === input.quantity && "bg-primary/5 font-medium")}>
                      <td className="px-5 py-2">{quantity.toLocaleString("en-IN")}</td>
                      <td className="px-2 py-2 text-right">₹{r.perPiece.toFixed(2)}</td>
                      <td className="px-5 py-2 text-right">{formatINR(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
