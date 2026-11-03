import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, ExternalLink, Eye, FileText, Loader2, MessageCircle, Plus, RefreshCw, Save, Send, Settings, Trash2, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import apiClient from "@/lib/apiClient";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, FilterSelect, MetricBar, SearchField, Stack, StatusPill, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { fmtDate, fmtRelative, plural } from "@/lib/format";
import { getTemplateBodyText, getTemplateExamples, getTemplateFooterText, getTemplateVariableNumbers, languageLabel } from "@/lib/whatsappTemplates";
import { ConnectWhatsApp } from "@/components/whatsapp/ConnectWhatsApp";
import { CreateTemplateDialog } from "@/components/whatsapp/CreateTemplateDialog";
import { MessagePreview } from "@/components/whatsapp/MessagePreview";
import { StarterTemplates } from "@/components/whatsapp/StarterTemplates";
import {
  CATEGORY_LABEL,
  QUALITY_META,
  STATUS_HELP,
  limitHint,
  statusMeta,
  whatsappManagerUrl,
  type MetaTemplate,
  type StarterTemplate,
  type WhatsAppAccount,
  type WhatsAppConfig,
} from "@/components/whatsapp/whatsappMeta";
import { cn } from "@/lib/utils";

type Tab = "templates" | "test" | "connection";

const EMPTY_CONFIG: WhatsAppConfig = { enabled: false, wabaId: "", phoneNumberId: "", setupMethod: "manual", hasAccessToken: false, webhookSubscribed: false };

const toConfig = (s: any): WhatsAppConfig => ({
  enabled: !!s?.enabled,
  wabaId: s?.wabaId || "",
  phoneNumberId: s?.phoneNumberId || "",
  setupMethod: s?.setupMethod || "manual",
  hasAccessToken: !!s?.hasAccessToken,
  connectedAt: s?.embeddedSignupData?.tokenExchangedAt,
  webhookSubscribed: !!s?.webhookConfig?.subscribedFields?.length,
});

const NAME_STATUS: Record<string, { label: string; tone: PillTone }> = {
  APPROVED: { label: "Approved", tone: "success" },
  AVAILABLE_WITHOUT_REVIEW: { label: "Approved", tone: "success" },
  PENDING_REVIEW: { label: "In review", tone: "warning" },
  DECLINED: { label: "Declined", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "danger" },
};

// The same name can exist once per language.
const templateKey = (t: Pick<MetaTemplate, "name" | "language">) => `${t.name}|${t.language}`;

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

export default function WhatsApp() {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  // The server allows template and connection changes to "Settings: Edit" only.
  const canEdit = hasPermission("Settings: Edit");
  const canSend = hasPermission("WhatsApp: Send Messages");

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [config, setConfig] = useState<WhatsAppConfig>(EMPTY_CONFIG);
  const [account, setAccount] = useState<WhatsAppAccount | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);

  const [templates, setTemplates] = useState<MetaTemplate[]>([]);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [starters, setStarters] = useState<StarterTemplate[]>([]);

  const [tab, setTab] = useState<Tab>("templates");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [previewing, setPreviewing] = useState<MetaTemplate | null>(null);
  const [deleting, setDeleting] = useState<MetaTemplate | null>(null);

  // Test message
  const [phoneNumber, setPhoneNumber] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [sendingMessage, setSendingMessage] = useState(false);
  const [lastSent, setLastSent] = useState<{ to: string; template: string } | null>(null);

  // Connection
  const [credentials, setCredentials] = useState({ wabaId: "", phoneNumberId: "", accessToken: "" });
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const connected = !!config.wabaId;
  const sender = account?.verifiedName || "Your business";

  const fetchTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    try {
      const response: any = await apiClient.getMetaTemplates();
      setTemplates(response?.templates || []);
      setTemplatesError(null);
      setSyncedAt(new Date());
    } catch (error: any) {
      setTemplatesError(error.message || "Couldn't load templates from Meta.");
    } finally {
      setLoadingTemplates(false);
    }
  }, []);

  const checkAccount = useCallback(async () => {
    setChecking(true);
    try {
      const response: any = await apiClient.getWhatsAppAccount();
      setAccount(response?.account || null);
      setAccountError(null);
    } catch (error: any) {
      setAccount(null);
      setAccountError(error.message || "Couldn't reach Meta.");
    } finally {
      setChecking(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const response: any = await apiClient.getWhatsAppSettings();
      const next = toConfig(response?.settings);
      setConfig(next);
      setCredentials({ wabaId: next.wabaId, phoneNumberId: next.phoneNumberId, accessToken: "" });
      setLoadError(null);
      if (next.wabaId && next.hasAccessToken) {
        checkAccount();
        fetchTemplates();
        apiClient
          .getWhatsAppStarterTemplates()
          .then((r: any) => setStarters(r?.templates || []))
          .catch(() => setStarters([]));
      } else if (next.wabaId) {
        setAccountError("No access token is saved for this number. Add one under Connection.");
      }
    } catch (error: any) {
      setLoadError(error.message || "Couldn't load the WhatsApp settings.");
    } finally {
      setLoaded(true);
    }
  }, [checkAccount, fetchTemplates]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const refreshAll = () => Promise.all([checkAccount(), fetchTemplates()]);

  const toggleEnabled = async (enabled: boolean) => {
    setTogglingEnabled(true);
    setConfig((c) => ({ ...c, enabled }));
    try {
      // An empty token keeps the saved one.
      await apiClient.setupWhatsApp({ enabled, wabaId: config.wabaId, phoneNumberId: config.phoneNumberId, accessToken: "" });
      toast({
        title: enabled ? "Sending turned on" : "Sending paused",
        description: enabled ? "Invoices, quotations and reminders can go out on WhatsApp." : "Nothing is sent on WhatsApp until you turn it back on.",
      });
    } catch (error: any) {
      setConfig((c) => ({ ...c, enabled: !enabled }));
      toast({ title: "Couldn't change it", description: error.message || "Failed to update.", variant: "destructive" });
    } finally {
      setTogglingEnabled(false);
    }
  };

  // --- Templates ---
  const counts = useMemo(() => {
    const c = { approved: 0, review: 0, attention: 0 };
    for (const t of templates) {
      const g = statusMeta(t.status).group;
      if (g !== "other") c[g]++;
    }
    return c;
  }, [templates]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter(
      (t) =>
        (statusFilter === "all" || statusMeta(t.status).group === statusFilter) &&
        (categoryFilter === "all" || t.category === categoryFilter) &&
        (!q || t.name.toLowerCase().includes(q) || getTemplateBodyText(t).toLowerCase().includes(q))
    );
  }, [templates, search, statusFilter, categoryFilter]);

  const showStatus = (group: string) => {
    setTab("templates");
    setStatusFilter((s) => (s === group ? "all" : group));
  };

  const startTest = (t: MetaTemplate) => {
    setSelectedKey(templateKey(t));
    setTemplateVars({});
    setLastSent(null);
    setTab("test");
  };

  const confirmDeleteTemplate = async () => {
    if (!deleting) return;
    try {
      await apiClient.deleteMetaTemplate(deleting.name);
      toast({ title: "Template deleted", description: `${deleting.name} was removed from your Meta account.` });
      setDeleting(null);
      fetchTemplates();
    } catch (error: any) {
      toast({ title: "Couldn't delete", description: error.message || "Failed to delete template.", variant: "destructive" });
      throw error;
    }
  };

  const columns: Column<MetaTemplate>[] = [
    {
      id: "name",
      header: "Template",
      cell: (t) => (
        <div className="min-w-0 max-w-[400px]">
          <p className="truncate font-medium">{t.name}</p>
          <p className="truncate text-xs text-muted-foreground">{getTemplateBodyText(t) || "No message text"}</p>
        </div>
      ),
      sortValue: (t) => t.name,
    },
    {
      id: "category",
      header: "Category",
      cell: (t) => <Stack top={CATEGORY_LABEL[t.category] || t.category} bottom={languageLabel(t.language)} />,
      sortValue: (t) => t.category,
      className: "whitespace-nowrap",
      hideBelow: "lg",
    },
    {
      id: "status",
      header: "Status",
      cell: (t) => {
        const st = statusMeta(t.status);
        return <StatusPill tone={st.tone}>{st.label}</StatusPill>;
      },
      sortValue: (t) => statusMeta(t.status).label,
      className: "w-[130px]",
    },
  ];

  // --- Test message ---
  const approvedTemplates = templates.filter((t) => t.status === "APPROVED");
  const chosen = approvedTemplates.find((t) => templateKey(t) === selectedKey);
  const chosenVars = chosen ? getTemplateVariableNumbers(chosen) : [];
  const chosenExamples = chosen ? getTemplateExamples(chosen) : {};
  const phoneDigits = phoneNumber.replace(/\D/g, "");
  const showLanguage = (t: MetaTemplate) => approvedTemplates.filter((x) => x.name === t.name).length > 1;

  const handleSendMessage = async () => {
    if (!chosen || !phoneDigits) {
      toast({ title: "Add a number and a template", description: "Both are needed to send a test.", variant: "destructive" });
      return;
    }
    const missing = chosenVars.filter((n) => !templateVars[String(n)]?.trim());
    if (missing.length) {
      toast({ title: "Fill in every variable", description: `Missing ${missing.map((n) => `{{${n}}}`).join(", ")}`, variant: "destructive" });
      return;
    }
    setSendingMessage(true);
    try {
      await apiClient.sendWhatsAppMessage(phoneNumber, chosen.name, templateVars, chosen.language);
      setLastSent({ to: phoneNumber, template: chosen.name });
      toast({ title: "Message sent", description: `Sent to ${phoneNumber} on WhatsApp.` });
    } catch (error: any) {
      toast({ title: "Meta didn't send it", description: error.message || "Failed to send message.", variant: "destructive" });
    } finally {
      setSendingMessage(false);
    }
  };

  // --- Connection ---
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: `${label} copied` });
    } catch {
      toast({ title: "Copy did not work", description: "Select the text and copy it by hand.", variant: "destructive" });
    }
  };

  const saveCredentials = async () => {
    const wabaId = credentials.wabaId.trim();
    const phoneNumberId = credentials.phoneNumberId.trim();
    if (!wabaId || !phoneNumberId) {
      toast({ title: "Both IDs are needed", description: "Fill in the account ID and the phone number ID.", variant: "destructive" });
      return;
    }
    setSavingCredentials(true);
    try {
      await apiClient.setupWhatsApp({ enabled: config.enabled, wabaId, phoneNumberId, accessToken: credentials.accessToken.trim() });
      toast({ title: "Credentials saved", description: "Checking them with Meta now." });
      await loadSettings();
    } catch (error: any) {
      toast({ title: "Couldn't save", description: error.message || "Failed to save settings.", variant: "destructive" });
    } finally {
      setSavingCredentials(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await apiClient.resetEmbeddedSignupConfiguration();
      toast({ title: "Disconnected", description: "WhatsApp is no longer linked to Carbon." });
      setConfig(EMPTY_CONFIG);
      setAccount(null);
      setAccountError(null);
      setTemplates([]);
      setStarters([]);
      setTab("templates");
      setShowDisconnectDialog(false);
    } catch (error: any) {
      toast({ title: "Couldn't disconnect", description: error.message || "Failed to disconnect.", variant: "destructive" });
    } finally {
      setDisconnecting(false);
    }
  };

  const health: { label: string; tone: PillTone } = accountError
    ? { label: "Not working", tone: "danger" }
    : !config.enabled
      ? { label: "Paused", tone: "warning" }
      : account
        ? { label: "Live", tone: "success" }
        : { label: "Checking…", tone: "neutral" };
  const quality = account?.qualityRating ? QUALITY_META[account.qualityRating] : undefined;
  const nameStatus = account?.nameStatus ? NAME_STATUS[account.nameStatus] : undefined;
  const previewGroup = previewing ? (previewing.status ? statusMeta(previewing.status).group : null) : null;

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow="Setup"
        title="WhatsApp"
        description="Send invoices, quotations and payment reminders from your own WhatsApp Business number."
        actions={
          connected && (
            <>
              <Button variant="outline" onClick={refreshAll} disabled={checking || loadingTemplates}>
                <RefreshCw className={checking || loadingTemplates ? "animate-spin" : undefined} />
                Check connection
              </Button>
              {canEdit && (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus />
                  New template
                </Button>
              )}
            </>
          )
        }
      />

      {!loaded ? (
        <div className="space-y-4" aria-busy>
          <div className="h-[88px] animate-pulse rounded-xl border bg-muted/40" />
          <div className="h-[84px] animate-pulse rounded-xl border bg-muted/40" />
          <div className="h-64 animate-pulse rounded-xl border bg-muted/40" />
        </div>
      ) : loadError ? (
        <DataCard>
          <EmptyState
            icon={AlertCircle}
            title="Couldn't load the WhatsApp settings"
            description={loadError}
            action={
              <Button variant="outline" onClick={() => { setLoaded(false); loadSettings(); }}>
                <RefreshCw />
                Try again
              </Button>
            }
          />
        </DataCard>
      ) : !connected ? (
        <ConnectWhatsApp canEdit={canEdit} onConnected={loadSettings} />
      ) : (
        <>
          {/* The connected number and the master switch */}
          <section className="overflow-hidden rounded-xl border bg-card shadow-card">
            <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <div className="flex min-w-0 items-center gap-3.5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-success-soft text-success-strong">
                  <MessageCircle className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    {checking && !account ? (
                      <span className="inline-block h-5 w-40 animate-pulse rounded bg-muted" />
                    ) : (
                      <p className="num truncate text-base font-semibold">{account?.displayPhoneNumber || `Number ID ${config.phoneNumberId}`}</p>
                    )}
                    <StatusPill tone={health.tone}>{health.label}</StatusPill>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {account?.verifiedName || "WhatsApp Business"} · {config.setupMethod === "embedded_signup" ? "Connected through Meta sign-up" : "Connected with API keys"}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3.5 py-2.5 sm:min-w-[280px]">
                <div className="min-w-0">
                  <Label htmlFor="wa-enabled" className="text-sm font-medium">
                    Send from the ERP
                  </Label>
                  <p className="text-xs text-muted-foreground">{config.enabled ? "Invoices, quotes and reminders go out" : "Paused. Nothing is sent"}</p>
                </div>
                <Switch id="wa-enabled" checked={config.enabled} onCheckedChange={toggleEnabled} disabled={!canEdit || togglingEnabled} />
              </div>
            </div>
            {accountError && (
              <div role="alert" className="flex items-start gap-2.5 border-t border-destructive/25 bg-destructive-soft px-4 py-3 text-sm text-destructive-strong sm:px-5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Meta isn't accepting this connection</p>
                  <p className="text-xs">{accountError}</p>
                </div>
                <Button size="xs" variant="outline" onClick={() => setTab("connection")} className="shrink-0">
                  Fix it
                </Button>
              </div>
            )}
          </section>

          <MetricBar
            loading={loadingTemplates && !syncedAt}
            metrics={[
              { label: "Approved", value: counts.approved, hint: "Ready to send", tone: "success", onClick: () => showStatus("approved"), active: tab === "templates" && statusFilter === "approved" },
              { label: "In review", value: counts.review, hint: "Waiting on Meta", tone: counts.review ? "warning" : "default", onClick: () => showStatus("review"), active: tab === "templates" && statusFilter === "review" },
              { label: "Needs attention", value: counts.attention, hint: "Rejected or paused", tone: counts.attention ? "danger" : "default", onClick: () => showStatus("attention"), active: tab === "templates" && statusFilter === "attention" },
              { label: "Number quality", value: quality?.label || (account ? "Not rated yet" : "—"), hint: limitHint(account?.messagingLimitTier), tone: quality?.tone || "default" },
            ]}
          />

          <div className="space-y-4">
            <ViewTabs<Tab>
              value={tab}
              onChange={setTab}
              tabs={[
                { value: "templates", label: "Templates", count: templates.length, icon: FileText },
                { value: "test", label: "Send a test", icon: Send },
                { value: "connection", label: "Connection", icon: Settings, tone: "danger", count: accountError ? 1 : undefined },
              ]}
            />

            {/* --- TEMPLATES --- */}
            {tab === "templates" && (
              <div className={cn("grid gap-4", starters.length > 0 && "xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start")}>
                <DataCard
                  toolbar={
                    <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search templates" />}>
                      <FilterSelect
                        label="Status"
                        value={statusFilter}
                        onChange={setStatusFilter}
                        options={[
                          { value: "approved", label: "Approved" },
                          { value: "review", label: "In review" },
                          { value: "attention", label: "Needs attention" },
                        ]}
                      />
                      <FilterSelect
                        label="Category"
                        value={categoryFilter}
                        onChange={setCategoryFilter}
                        options={[
                          { value: "UTILITY", label: "Utility" },
                          { value: "MARKETING", label: "Marketing" },
                          { value: "AUTHENTICATION", label: "Authentication" },
                        ]}
                      />
                      <Button variant="outline" onClick={fetchTemplates} disabled={loadingTemplates} className="h-9 shrink-0">
                        <RefreshCw className={loadingTemplates ? "animate-spin" : undefined} />
                        Sync
                      </Button>
                    </Toolbar>
                  }
                  footer={
                    syncedAt &&
                    !templatesError &&
                    `${plural(filtered.length, "template")}${filtered.length !== templates.length ? ` of ${templates.length}` : ""} · Synced with Meta ${fmtRelative(syncedAt)}`
                  }
                >
                  {templatesError ? (
                    <EmptyState
                      icon={AlertCircle}
                      title="Couldn't load templates from Meta"
                      description={templatesError}
                      action={
                        <Button variant="outline" onClick={fetchTemplates} disabled={loadingTemplates}>
                          <RefreshCw className={loadingTemplates ? "animate-spin" : undefined} />
                          Try again
                        </Button>
                      }
                    />
                  ) : (
                    <DataTable
                      columns={columns}
                      rows={filtered}
                      rowKey={(t) => t.id || templateKey(t)}
                      loading={loadingTemplates && !syncedAt}
                      onRowClick={(t) => setPreviewing(t)}
                      minWidth={640}
                      actionsLabel={(t) => `Actions for ${t.name}`}
                      actions={(t) => [
                        { label: "Preview", icon: Eye, onClick: () => setPreviewing(t) },
                        { label: "Send a test", icon: Send, onClick: () => startTest(t), hidden: t.status !== "APPROVED" || !canSend },
                        { label: "Delete", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(t), hidden: !canEdit },
                      ]}
                      mobile={(t) => {
                        const st = statusMeta(t.status);
                        return (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="truncate font-medium">{t.name}</span>
                              <StatusPill tone={st.tone}>{st.label}</StatusPill>
                            </div>
                            <p className="line-clamp-2 text-xs text-muted-foreground">{getTemplateBodyText(t)}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {CATEGORY_LABEL[t.category] || t.category} · {languageLabel(t.language)}
                            </p>
                          </div>
                        );
                      }}
                      empty={
                        templates.length === 0 ? (
                          <EmptyState
                            icon={FileText}
                            title="No templates yet"
                            description="WhatsApp only lets businesses start a chat with an approved template. Add the ERP's own, or write one."
                            action={
                              canEdit && (
                                <Button onClick={() => setCreateOpen(true)}>
                                  <Plus />
                                  New template
                                </Button>
                              )
                            }
                          />
                        ) : (
                          <EmptyState
                            compact
                            icon={FileText}
                            title="No templates match"
                            action={
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setSearch("");
                                  setStatusFilter("all");
                                  setCategoryFilter("all");
                                }}
                              >
                                Clear filters
                              </Button>
                            }
                          />
                        )
                      }
                    />
                  )}
                </DataCard>

                <StarterTemplates starters={starters} templates={templates} canEdit={canEdit} onSubmitted={fetchTemplates} onPreview={setPreviewing} />
              </div>
            )}

            {/* --- SEND A TEST --- */}
            {tab === "test" && (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
                <section className="space-y-5 rounded-xl border bg-card p-4 shadow-card sm:p-5">
                  <div>
                    <h2 className="text-sm font-semibold">Send a test message</h2>
                    <p className="text-xs text-muted-foreground">See how an approved template arrives before customers get it. Meta bills a test like any other message.</p>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="wa-test-phone">Send to</Label>
                      <Input id="wa-test-phone" type="tel" inputMode="tel" placeholder="+91 98765 43210" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} />
                      {phoneDigits.length === 10 ? (
                        <p className="text-xs text-warning-strong">Add the country code in front, e.g. +91 for India.</p>
                      ) : (
                        <p className="text-xs text-muted-foreground">A number with WhatsApp, with its country code.</p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label>Template</Label>
                      <Select
                        value={chosen ? selectedKey : ""}
                        onValueChange={(v) => {
                          setSelectedKey(v);
                          setTemplateVars({});
                          setLastSent(null);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose an approved template" />
                        </SelectTrigger>
                        <SelectContent>
                          {approvedTemplates.map((t) => (
                            <SelectItem key={templateKey(t)} value={templateKey(t)}>
                              {t.name}
                              {showLanguage(t) && <span className="text-muted-foreground"> · {languageLabel(t.language)}</span>}
                            </SelectItem>
                          ))}
                          {approvedTemplates.length === 0 && (
                            <SelectItem value="none" disabled>
                              No approved templates yet
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {chosen && (
                    <div className="space-y-2.5">
                      <p className="section-label">Fill in the variables</p>
                      {chosenVars.length === 0 ? (
                        <p className="text-sm text-muted-foreground">This template has no variables. It's sent exactly as shown.</p>
                      ) : (
                        chosenVars.map((n) => (
                          <div key={n} className="flex items-center gap-3">
                            <span className="w-12 shrink-0 rounded bg-info-soft py-1 text-center font-mono text-xs text-info-strong">{`{{${n}}}`}</span>
                            <Input
                              value={templateVars[String(n)] || ""}
                              onChange={(e) => setTemplateVars((v) => ({ ...v, [String(n)]: e.target.value }))}
                              placeholder={chosenExamples[String(n)] ? `e.g. ${chosenExamples[String(n)]}` : `Value for {{${n}}}`}
                              aria-label={`Value for variable ${n}`}
                            />
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {lastSent && (
                    <div className="flex items-center gap-2 rounded-lg border border-success/25 bg-success-soft px-3 py-2.5 text-sm text-success-strong">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      <span>
                        {lastSent.template} was sent to {lastSent.to}. Delivery can take a few seconds.
                      </span>
                    </div>
                  )}

                  <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-muted-foreground">{canSend ? "Uses your connected number." : "Your role can't send WhatsApp messages."}</p>
                    <Button onClick={handleSendMessage} disabled={sendingMessage || !canSend || !chosen || !phoneDigits}>
                      {sendingMessage ? <Loader2 className="animate-spin" /> : <Send />}
                      Send test
                    </Button>
                  </div>
                </section>

                <div className="space-y-2">
                  <p className="section-label">What the customer sees</p>
                  <MessagePreview
                    body={chosen ? getTemplateBodyText(chosen) : ""}
                    footer={chosen ? getTemplateFooterText(chosen) : ""}
                    values={templateVars}
                    sender={sender}
                    placeholder="Choose a template to preview it."
                  />
                </div>
              </div>
            )}

            {/* --- CONNECTION --- */}
            {tab === "connection" && (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:items-start">
                <section className="overflow-hidden rounded-xl border bg-card shadow-card">
                  <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                    <h2 className="text-sm font-semibold">Connection details</h2>
                    <Button variant="outline" size="xs" asChild>
                      <a href={whatsappManagerUrl(config.wabaId)} target="_blank" rel="noreferrer">
                        <ExternalLink />
                        WhatsApp Manager
                      </a>
                    </Button>
                  </div>
                  <dl className="divide-y">
                    <DetailRow label="Phone number">
                      <span className="num font-medium">{account?.displayPhoneNumber || "—"}</span>
                      {account?.codeVerificationStatus === "VERIFIED" && <span className="ml-2 text-xs text-success-strong">Verified</span>}
                    </DetailRow>
                    <DetailRow label="Display name">
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {account?.verifiedName || "—"}
                        {nameStatus && <StatusPill tone={nameStatus.tone}>{nameStatus.label}</StatusPill>}
                      </span>
                    </DetailRow>
                    <DetailRow label="Business account ID">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="break-all font-mono text-[13px]">{config.wabaId}</span>
                        <Button variant="ghost" size="icon-xs" onClick={() => copy(config.wabaId, "Account ID")} aria-label="Copy business account ID">
                          <Copy />
                        </Button>
                      </span>
                    </DetailRow>
                    <DetailRow label="Phone number ID">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="break-all font-mono text-[13px]">{config.phoneNumberId || "—"}</span>
                        {config.phoneNumberId && (
                          <Button variant="ghost" size="icon-xs" onClick={() => copy(config.phoneNumberId, "Phone number ID")} aria-label="Copy phone number ID">
                            <Copy />
                          </Button>
                        )}
                      </span>
                    </DetailRow>
                    <DetailRow label="Connected through">
                      {config.setupMethod === "embedded_signup" ? "Meta sign-up" : "API keys"}
                      {config.connectedAt && <span className="text-muted-foreground"> · {fmtDate(config.connectedAt)}</span>}
                    </DetailRow>
                    <DetailRow label="Access token">
                      {config.hasAccessToken ? <StatusPill tone="success">Saved</StatusPill> : <StatusPill tone="danger">Missing</StatusPill>}
                    </DetailRow>
                    <DetailRow label="Delivery updates">
                      {config.webhookSubscribed ? (
                        <StatusPill tone="success">Receiving</StatusPill>
                      ) : (
                        <span className="text-muted-foreground">Set the webhook up in your Meta app to see delivered and read receipts.</span>
                      )}
                    </DetailRow>
                  </dl>
                </section>

                <div className="space-y-4">
                  {canEdit && (
                    <section className="space-y-4 rounded-xl border bg-card p-4 shadow-card">
                      <div>
                        <h2 className="text-sm font-semibold">Replace API credentials</h2>
                        <p className="text-xs text-muted-foreground">For moving to another number, or when Meta stops accepting the saved token.</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="wa-cred-waba">Business account ID</Label>
                        <Input id="wa-cred-waba" inputMode="numeric" value={credentials.wabaId} onChange={(e) => setCredentials((c) => ({ ...c, wabaId: e.target.value }))} />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="wa-cred-phone">Phone number ID</Label>
                        <Input id="wa-cred-phone" inputMode="numeric" value={credentials.phoneNumberId} onChange={(e) => setCredentials((c) => ({ ...c, phoneNumberId: e.target.value }))} />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="wa-cred-token">Access token</Label>
                        <Input
                          id="wa-cred-token"
                          type="password"
                          autoComplete="off"
                          value={credentials.accessToken}
                          onChange={(e) => setCredentials((c) => ({ ...c, accessToken: e.target.value }))}
                          placeholder={config.hasAccessToken ? "Saved. Enter a new one to replace it" : "EAAI…"}
                        />
                      </div>
                      <Button variant="outline" onClick={saveCredentials} disabled={savingCredentials} className="w-full">
                        {savingCredentials ? <Loader2 className="animate-spin" /> : <Save />}
                        Save and check
                      </Button>
                    </section>
                  )}

                  {canEdit && (
                    <section className="flex flex-col gap-3 rounded-xl border border-destructive/25 bg-card p-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h2 className="text-sm font-semibold">Disconnect WhatsApp</h2>
                        <p className="text-xs text-muted-foreground">Removes the token and IDs from the ERP. Templates stay in your Meta account.</p>
                      </div>
                      <Button variant="outline" onClick={() => setShowDisconnectDialog(true)} className="shrink-0 text-destructive-strong hover:text-destructive-strong">
                        <Unplug />
                        Disconnect
                      </Button>
                    </section>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <CreateTemplateDialog open={createOpen} onOpenChange={setCreateOpen} existing={templates} sender={sender} onCreated={fetchTemplates} />

      <Dialog open={!!previewing} onOpenChange={(o) => !o && setPreviewing(null)}>
        <DialogContent className="max-w-md">
          {previewing && (
            <>
              <DialogHeader>
                <DialogTitle className="break-all font-mono text-base">{previewing.name}</DialogTitle>
                <DialogDescription>
                  {CATEGORY_LABEL[previewing.category] || previewing.category} · {languageLabel(previewing.language)} · {plural(getTemplateVariableNumbers(previewing).length, "variable")}
                </DialogDescription>
              </DialogHeader>
              <MessagePreview body={getTemplateBodyText(previewing)} footer={getTemplateFooterText(previewing)} values={getTemplateExamples(previewing)} sender={sender} />
              <div className="flex items-start gap-2.5 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                {previewGroup ? (
                  <>
                    <StatusPill tone={statusMeta(previewing.status).tone} className="shrink-0">
                      {statusMeta(previewing.status).label}
                    </StatusPill>
                    <span>{STATUS_HELP[previewGroup]}</span>
                  </>
                ) : (
                  <>
                    <StatusPill className="shrink-0">Not added</StatusPill>
                    <span>Not on your Meta account yet. Add it from "Templates the ERP sends".</span>
                  </>
                )}
              </div>
              {(previewGroup === "attention" || (previewGroup === "approved" && canSend)) && (
                <DialogFooter className="gap-2">
                  {previewGroup === "attention" && (
                    <Button variant="outline" asChild>
                      <a href={whatsappManagerUrl(config.wabaId, "message-templates")} target="_blank" rel="noreferrer">
                        <ExternalLink />
                        Open WhatsApp Manager
                      </a>
                    </Button>
                  )}
                  {previewGroup === "approved" && canSend && (
                    <Button
                      onClick={() => {
                        startTest(previewing);
                        setPreviewing(null);
                      }}
                    >
                      <Send />
                      Send a test
                    </Button>
                  )}
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete the template "${deleting?.name}"?`}
        description="It's deleted from your Meta WhatsApp account in every language, and can no longer be used to send messages. Meta won't let you reuse the name for 30 days."
        onConfirm={confirmDeleteTemplate}
      />

      <AlertDialog open={showDisconnectDialog} onOpenChange={(open) => !open && !disconnecting && setShowDisconnectDialog(false)}>
        <AlertDialogContent>
          <AlertDialogHeader className="space-y-3">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <AlertDialogTitle className="text-center text-xl">Disconnect WhatsApp Business?</AlertDialogTitle>
            <AlertDialogDescription className="text-center">Your access token and connection details will be deleted from Carbon.</AlertDialogDescription>
          </AlertDialogHeader>

          <div className="rounded-lg border border-input bg-muted/50 p-4 text-sm">
            <p className="mb-2 font-medium text-foreground">After disconnecting:</p>
            <ul className="space-y-1.5 text-muted-foreground">
              <li>• Automatic payment reminders stop going out</li>
              <li>• Invoices and quotations can no longer be sent over WhatsApp</li>
              <li>• Your message templates stay safe in your Meta account</li>
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">You can reconnect any time by running the setup again. It takes about a minute.</p>
          </div>

          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={disconnecting}>Keep connected</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Hold the dialog open while the request is in flight.
                e.preventDefault();
                handleDisconnect();
              }}
              disabled={disconnecting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {disconnecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                "Disconnect"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
