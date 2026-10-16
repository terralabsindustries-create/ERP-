import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, Pagination, SearchField, Stack, Tag, Toolbar, ViewTabs, type Column } from "@/components/data";
import { CreateHsnCodeDialog } from "@/components/hsn/CreateHsnCodeDialog";
import { EditHsnCodeDialog } from "@/components/hsn/EditHsnCodeDialog";
import { BulkImportDialog } from "@/components/hsn/BulkImportDialog";
import { CreateSacCodeDialog } from "@/components/sac/CreateSacCodeDialog";
import { EditSacCodeDialog } from "@/components/sac/EditSacCodeDialog";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { fmtDate, humanize } from "@/lib/format";

type Kind = "hsn" | "sac";

interface TaxCode {
  _id: string;
  hsnCode?: string;
  sacCode?: string;
  description: string;
  gstRate: number;
  type?: "product" | "service" | "both";
  category: string;
  subCategory?: string;
  notes?: string;
  updatedAt?: string;
}

const PAGE_SIZE = 25;

const CONFIG = {
  hsn: {
    title: "HSN codes",
    noun: "HSN code",
    description: "Tax codes for the goods you sell — paper, printed matter, packaging — and the GST rate each one carries.",
    field: "hsnCode" as const,
    list: (p: Record<string, string>) => apiClient.getHsnCodes(p),
    categories: () => apiClient.getHsnCategories(),
    remove: (id: string) => apiClient.deleteHsnCode(id),
    summary: "/hsn-codes/gst-rates/summary"
  },
  sac: {
    title: "SAC codes",
    noun: "SAC code",
    description: "Tax codes for the services you bill — printing, design, delivery — and the GST rate each one carries.",
    field: "sacCode" as const,
    list: (p: Record<string, string>) => apiClient.getSacCodes(p),
    categories: () => apiClient.getSacCategories(),
    remove: (id: string) => apiClient.deleteSacCode(id),
    summary: "/sac-codes/gst-rates/summary"
  }
};

/** The HSN and SAC code screens: one layout, two catalogues. */
export function TaxCodesView({ kind }: { kind: Kind }) {
  const cfg = CONFIG[kind];
  const { toast } = useToast();
  const [rows, setRows] = useState<TaxCode[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [category, setCategory] = useState("all");
  const [type, setType] = useState("all");
  const [rate, setRate] = useState("all");
  const [page, setPage] = useState(1);
  const [categories, setCategories] = useState<string[]>([]);
  const [rates, setRates] = useState<{ rate: number; count: number }[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<TaxCode | null>(null);
  const [deleting, setDeleting] = useState<TaxCode | null>(null);

  const loadMeta = useCallback(async () => {
    const [cats, sum] = await Promise.all([
      cfg.categories().catch(() => null) as Promise<{ categories?: string[] } | string[] | null>,
      apiClient.get<{ gstRatesSummary?: { _id: number; count: number }[] }>(cfg.summary).catch(() => null)
    ]);
    setCategories(Array.isArray(cats) ? cats : cats?.categories || []);
    setRates((sum?.gstRatesSummary || []).map((r) => ({ rate: r._id, count: r.count })));
  }, [cfg]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { page: String(page), limit: String(PAGE_SIZE) };
      if (q) params.search = q;
      if (category !== "all") params.category = category;
      if (type !== "all") params.type = type;
      if (rate !== "all") params.gstRate = rate;
      const res = (await cfg.list(params)) as Record<string, unknown> & { pagination?: { totalHsnCodes?: number; totalSacCodes?: number } };
      const list = (res[kind === "hsn" ? "hsnCodes" : "sacCodes"] as TaxCode[]) || [];
      setRows(list);
      const p = res.pagination || {};
      setTotal(p.totalHsnCodes ?? p.totalSacCodes ?? list.length);
    } catch (error) {
      toast({ title: `${cfg.title} could not be loaded`, description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [cfg, kind, page, q, category, type, rate, toast]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);
  useEffect(() => {
    load();
  }, [load]);
  // A new filter starts from the first page.
  useEffect(() => setPage(1), [q, category, type, rate]);

  const refresh = () => {
    load();
    loadMeta();
  };

  const allCount = rates.reduce((s, r) => s + r.count, 0);
  const topRate = rates.reduce<{ rate: number; count: number } | null>((best, r) => (!best || r.count > best.count ? r : best), null);
  const filtered = !!q || category !== "all" || type !== "all";

  const code = (r: TaxCode) => (kind === "hsn" ? r.hsnCode : r.sacCode) || "—";
  // The edit dialogs read `id`; the API sends `_id`.
  const forDialog = (r: TaxCode) => ({ ...r, id: r._id }) as TaxCode & { id: string };

  const columns = useMemo<Column<TaxCode>[]>(
    () => [
      {
        id: "code",
        header: kind === "hsn" ? "HSN code" : "SAC code",
        cell: (r) => <EntityCell icon={FileText} title={code(r)} mono subtitle={kind === "hsn" && r.type ? humanize(r.type) : undefined} />,
        sortValue: (r) => code(r),
        className: "w-[180px]"
      },
      {
        id: "description",
        header: "Description",
        cell: (r) => (
          <span className="line-clamp-2 max-w-[440px]" title={r.description}>
            {r.description}
          </span>
        ),
        sortValue: (r) => r.description
      },
      {
        id: "category",
        header: "Category",
        cell: (r) => <Stack top={<Tag>{r.category}</Tag>} bottom={r.subCategory} />,
        sortValue: (r) => r.category,
        hideBelow: "lg"
      },
      {
        id: "updated",
        header: "Updated",
        cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{fmtDate(r.updatedAt)}</span>,
        sortValue: (r) => r.updatedAt || "",
        hideBelow: "xl"
      },
      {
        id: "rate",
        header: "GST",
        align: "right",
        cell: (r) => <span className="font-semibold">{r.gstRate}%</span>,
        sortValue: (r) => r.gstRate,
        className: "w-[90px]"
      }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind]
  );

  const remove = async () => {
    if (!deleting) return;
    try {
      await cfg.remove(deleting._id);
      toast({ title: `${cfg.noun} ${code(deleting)} removed` });
      setDeleting(null);
      refresh();
    } catch (error) {
      toast({ title: "Not removed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow="Setup"
        title={cfg.title}
        description={cfg.description}
        actions={
          <>
            {kind === "hsn" && (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload />
                Import CSV
              </Button>
            )}
            <Button onClick={() => setCreateOpen(true)}>
              <Plus />
              Add {cfg.noun}
            </Button>
          </>
        }
      />

      <MetricBar
        metrics={[
          { label: "Codes", value: allCount, hint: "Active in the code picker" },
          { label: "Categories", value: categories.length, hint: categories.slice(0, 3).join(" · ") || "—" },
          { label: "Most used rate", value: topRate ? `${topRate.rate}%` : "—", hint: topRate ? `${topRate.count} code${topRate.count === 1 ? "" : "s"}` : "No codes yet", tone: "info" },
          { label: "Rates in use", value: rates.length, hint: rates.map((r) => `${r.rate}%`).join(" · ") || "—" }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs
          value={rate}
          onChange={setRate}
          tabs={[{ value: "all", label: "All rates", count: allCount }, ...rates.map((r) => ({ value: String(r.rate), label: `${r.rate}%`, count: r.count }))]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder={`Search ${kind.toUpperCase()} code or description`} />}>
              <FilterSelect label="Category" value={category} onChange={setCategory} options={categories.map((c) => ({ value: c, label: c }))} />
              {kind === "hsn" && (
                <FilterSelect
                  label="Type"
                  value={type}
                  onChange={setType}
                  options={[
                    { value: "product", label: "Product" },
                    { value: "service", label: "Service" },
                    { value: "both", label: "Both" }
                  ]}
                />
              )}
            </Toolbar>
          }
          footer={!loading && total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="codes" />}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r._id}
            loading={loading}
            onRowClick={(r) => setEditing(r)}
            actions={(r) => [
              { label: "Edit", icon: Pencil, onClick: () => setEditing(r) },
              { label: "Remove", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(r) }
            ]}
            actionsLabel={(r) => `Actions for ${code(r)}`}
            minWidth={720}
            mobile={(r) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-sm font-semibold">{code(r)}</span>
                  <span className="num text-sm font-semibold">{r.gstRate}%</span>
                </div>
                <p className="line-clamp-2 text-sm text-muted-foreground">{r.description}</p>
                <Tag>{r.category}</Tag>
              </div>
            )}
            empty={
              filtered || rate !== "all" ? (
                <EmptyState
                  compact
                  icon={FileText}
                  title="No codes match"
                  description="Try another search, category or rate."
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSearch("");
                        setCategory("all");
                        setType("all");
                        setRate("all");
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={FileText}
                  title={`No ${cfg.title} yet`}
                  description={`Add the ${cfg.noun}s you use on invoices so each line gets the right GST rate.`}
                  action={
                    <Button onClick={() => setCreateOpen(true)}>
                      <Plus />
                      Add {cfg.noun}
                    </Button>
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      {kind === "hsn" ? (
        <>
          <CreateHsnCodeDialog open={createOpen} onOpenChange={setCreateOpen} onHsnCodeCreated={refresh} />
          <EditHsnCodeDialog
            open={!!editing}
            onOpenChange={(o) => !o && setEditing(null)}
            hsnCode={editing ? (forDialog(editing) as never) : null}
            onHsnCodeUpdated={refresh}
          />
          <BulkImportDialog open={importOpen} onOpenChange={setImportOpen} onImportCompleted={refresh} />
        </>
      ) : (
        <>
          <CreateSacCodeDialog open={createOpen} onOpenChange={setCreateOpen} onSacCodeCreated={refresh} />
          <EditSacCodeDialog
            open={!!editing}
            onOpenChange={(o) => !o && setEditing(null)}
            sacCode={editing ? (forDialog(editing) as never) : null}
            onSacCodeUpdated={refresh}
          />
        </>
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${cfg.noun} ${deleting ? code(deleting) : ""}?`}
        description="It disappears from this list and from the code picker on new invoices. Invoices that already use it keep it."
        confirmLabel="Remove"
        onConfirm={remove}
      />
    </PageShell>
  );
}
