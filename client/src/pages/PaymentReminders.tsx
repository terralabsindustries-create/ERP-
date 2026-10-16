import { useState, useEffect, useCallback } from "react";
import { Send, SendHorizonal, CheckCircle2, RefreshCw, Settings, MessageSquare, Search, Filter, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { getTemplateBodyText, getTemplateVariableNumbers } from "@/lib/whatsappTemplates";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { DataCard, DataTable, EntityCell, FilterSelect, MetricBar, Pagination, SearchField, Stack, StatusPill, Tag, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { fmtDate, formatINR, plural } from "@/lib/format";

interface OverdueInvoice {
  _id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  whatsappConsent: boolean;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
  dueDate: string;
  daysOverdue: number;
  paymentStatus: string;
  reminderCount: number;
  lastReminderDate: string | null;
  canSendReminder: boolean;
  maxRemindersReached: boolean;
}

interface Reminder {
  _id: string;
  invoiceNumber: string;
  customerName: string;
  customerPhone: string;
  totalAmount: number;
  balanceAmount: number;
  daysOverdue: number;
  reminderType: string;
  messageContent: string;
  status: string;
  sentAt: string;
  reminderCount: number;
  createdAt: string;
  failureReason?: string;
}

interface ReminderSettings {
  enabled: boolean;
  daysAfterDue: number;
  reminderInterval: number;
  maxReminders: number;
  messageTemplate: string;
  metaTemplateName?: string;
  templateVariableMapping?: Record<string, string>;
  autoSend: boolean;
}

interface Stats {
  overdueInvoices: number;
  totalOutstanding: number;
  customersNeedingReminder: number;
  sentToday: number;
  totalSent: number;
}

export default function PaymentReminders() {
  const [activeTab, setActiveTab] = useState("overdue");
  const [stats, setStats] = useState<Stats>({
    overdueInvoices: 0,
    totalOutstanding: 0,
    customersNeedingReminder: 0,
    sentToday: 0,
    totalSent: 0,
  });
  const [overdueInvoices, setOverdueInvoices] = useState<OverdueInvoice[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [settings, setSettings] = useState<ReminderSettings>({
    enabled: false,
    daysAfterDue: 1,
    reminderInterval: 3,
    maxReminders: 5,
    messageTemplate: "",
    metaTemplateName: "",
    templateVariableMapping: {},
    autoSend: false,
  });

  const [metaTemplates, setMetaTemplates] = useState<any[]>([]);
  const [metaIntegrationEnabled, setMetaIntegrationEnabled] = useState(false);

  const [loading, setLoading] = useState(true);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sendingBulk, setSendingBulk] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [previewMessage, setPreviewMessage] = useState("");
  const [sendDialogInvoice, setSendDialogInvoice] = useState<OverdueInvoice | null>(null);
  const [sendTemplateChoice, setSendTemplateChoice] = useState<string>("__default__");
  const [sendTemplateMapping, setSendTemplateMapping] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);

  const { toast } = useToast();

  const fetchStats = useCallback(async () => {
    try {
      const response: any = await apiClient.getPaymentReminderStats();
      if (response?.stats) {
        setStats(response.stats);
      }
    } catch (error) {
      console.error("Error fetching stats:", error);
    }
  }, []);

  const fetchOverdueInvoices = useCallback(async () => {
    try {
      const response: any = await apiClient.getOverdueInvoices();
      if (response?.invoices) {
        setOverdueInvoices(response.invoices);
      }
    } catch (error) {
      console.error("Error fetching overdue invoices:", error);
      toast({
        title: "Error",
        description: "Failed to fetch overdue invoices",
        variant: "destructive",
      });
    }
  }, [toast]);

  const fetchReminders = useCallback(async (page = 1) => {
    try {
      const params: any = { page, limit: 20 };
      if (statusFilter && statusFilter !== "all") params.status = statusFilter;
      const response: any = await apiClient.getPaymentReminders(params);
      if (response?.reminders) {
        setReminders(response.reminders);
        setHistoryTotal(response.pagination?.total || 0);
      }
    } catch (error) {
      console.error("Error fetching reminders:", error);
    }
  }, [statusFilter]);

  const fetchSettings = useCallback(async () => {
    try {
      const response: any = await apiClient.getPaymentReminderSettings();
      if (response?.settings) {
        setSettings({
          ...response.settings,
          templateVariableMapping: response.settings.templateVariableMapping || {}
        });
      }

      // Check Meta integration
      const waResponse: any = await apiClient.getWhatsAppSettings();
      if (waResponse?.settings?.enabled) {
        setMetaIntegrationEnabled(true);
        if (waResponse.settings.wabaId && waResponse.settings.hasAccessToken) {
          try {
            const tmplResponse: any = await apiClient.getMetaTemplates();
            if (tmplResponse?.templates) {
              setMetaTemplates(tmplResponse.templates);
            }
          } catch (err) {
            console.error("Error fetching Meta templates:", err);
          }
        }
      }
    } catch (error) {
      console.error("Error fetching settings:", error);
    }
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([fetchStats(), fetchOverdueInvoices(), fetchReminders(), fetchSettings()]);
      setLoading(false);
    };
    loadData();
  }, [fetchStats, fetchOverdueInvoices, fetchReminders, fetchSettings]);

  useEffect(() => {
    fetchReminders(historyPage);
  }, [historyPage, statusFilter, fetchReminders]);

  const handleSendReminder = async (
    invoiceId: string,
    templateOverride?: { metaTemplateName?: string; metaTemplateLanguage?: string; templateVariableMapping?: Record<string, string> }
  ) => {
    setSendingId(invoiceId);
    try {
      const response: any = await apiClient.sendPaymentReminder(invoiceId, templateOverride);
      toast({
        title: "Reminder Sent",
        description: response?.message || "Payment reminder sent successfully via WhatsApp",
      });
      // Refresh data
      await Promise.all([fetchStats(), fetchOverdueInvoices(), fetchReminders(historyPage)]);
    } catch (error: any) {
      toast({
        title: "Failed to Send Reminder",
        description: error.message || "Failed to send payment reminder",
        variant: "destructive",
      });
    } finally {
      setSendingId(null);
    }
  };

  const openSendDialog = (invoice: OverdueInvoice) => {
    setSendTemplateChoice(settings.metaTemplateName ? "__default__" : "__freetext__");
    setSendTemplateMapping(settings.templateVariableMapping || {});
    setSendDialogInvoice(invoice);
  };

  const handleConfirmSend = async () => {
    if (!sendDialogInvoice) return;
    const invoiceId = sendDialogInvoice._id;

    if (sendTemplateChoice === "__default__") {
      // Use whatever template is configured in Settings
      await handleSendReminder(invoiceId);
    } else if (sendTemplateChoice === "__freetext__") {
      // Explicitly override to plain text for this send
      await handleSendReminder(invoiceId, { metaTemplateName: "" });
    } else {
      // A specific Meta template was chosen for this send
      const chosenTemplate = metaTemplates.find((t) => t.name === sendTemplateChoice);
      await handleSendReminder(invoiceId, {
        metaTemplateName: sendTemplateChoice,
        metaTemplateLanguage: chosenTemplate?.language,
        templateVariableMapping: sendTemplateMapping,
      });
    }
    setSendDialogInvoice(null);
  };

  const handleBulkSend = async () => {
    setBulkConfirmOpen(false);
    setSendingBulk(true);
    try {
      const response: any = await apiClient.sendBulkPaymentReminders();
      const results = response?.results;
      toast({
        title: "Bulk Reminders Processed",
        description: `${results?.sent || 0} sent, ${results?.failed || 0} failed, ${results?.skipped || 0} skipped`,
      });
      // Refresh data
      await Promise.all([fetchStats(), fetchOverdueInvoices(), fetchReminders(historyPage)]);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to send bulk reminders",
        variant: "destructive",
      });
    } finally {
      setSendingBulk(false);
    }
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      await apiClient.updatePaymentReminderSettings(settings);
      toast({
        title: "Settings Saved",
        description: "Payment reminder settings updated successfully",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to save settings",
        variant: "destructive",
      });
    } finally {
      setSavingSettings(false);
    }
  };

  const handlePreviewMessage = () => {
    const template = settings.messageTemplate || "Hi {{customerName}}, your invoice {{invoiceNumber}} has a balance of ₹{{balanceAmount}}.";
    const preview = template
      .replace(/\{\{customerName\}\}/g, "John Doe")
      .replace(/\{\{invoiceNumber\}\}/g, "INV-202607-0001")
      .replace(/\{\{totalAmount\}\}/g, "25,000")
      .replace(/\{\{balanceAmount\}\}/g, "12,500")
      .replace(/\{\{dueDate\}\}/g, "15 Jul 2026")
      .replace(/\{\{daysOverdue\}\}/g, "9")
      .replace(/\{\{businessName\}\}/g, "Your Company");
    setPreviewMessage(preview);
    setPreviewDialogOpen(true);
  };

  const formatCurrency = (amount: number) => formatINR(Math.round(amount || 0));
  const formatDate = (date: string) => fmtDate(date, "N/A");
  const formatDateTime = (date: string) =>
    date ? new Date(date).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "N/A";

  const REMINDER_STATUS: Record<string, { label: string; tone: PillTone }> = {
    sent: { label: "Sent", tone: "info" },
    delivered: { label: "Delivered", tone: "success" },
    failed: { label: "Failed", tone: "danger" },
    pending: { label: "Pending", tone: "warning" }
  };
  const REMINDER_TYPE: Record<string, string> = { overdue: "Overdue", partial: "Part paid", manual: "Manual" };


  // Filter overdue invoices by search
  const filteredInvoices = overdueInvoices.filter((inv) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      inv.customerName.toLowerCase().includes(q) ||
      inv.invoiceNumber.toLowerCase().includes(q) ||
      (inv.customerPhone && inv.customerPhone.includes(q))
    );
  });

  const eligibleCount = overdueInvoices.filter((i) => i.canSendReminder).length;

  const sendLabel = (inv: OverdueInvoice) =>
    inv.maxRemindersReached ? "Limit reached" : !inv.customerPhone ? "No phone" : inv.canSendReminder ? "Send" : "Wait";

  const overdueColumns: Column<OverdueInvoice>[] = [
    {
      id: "customer",
      header: "Customer",
      cell: (i) => <EntityCell avatar={i.customerName} title={i.customerName} subtitle={i.customerPhone || "No phone number"} />,
      sortValue: (i) => i.customerName.toLowerCase(),
      className: "min-w-[210px]"
    },
    { id: "invoice", header: "Invoice", cell: (i) => <span className="font-mono text-[13px]">{i.invoiceNumber}</span>, sortValue: (i) => i.invoiceNumber },
    {
      id: "due",
      header: "Due",
      cell: (i) => (
        <Stack
          top={<span className="whitespace-nowrap">{formatDate(i.dueDate)}</span>}
          bottom={<span className={i.daysOverdue > 30 ? "font-medium text-destructive-strong" : "text-destructive-strong"}>{plural(i.daysOverdue, "day")} overdue</span>}
        />
      ),
      sortValue: (i) => i.daysOverdue,
      hideBelow: "md"
    },
    { id: "total", header: "Invoice total", align: "right", cell: (i) => formatCurrency(i.totalAmount), sortValue: (i) => i.totalAmount, hideBelow: "lg" },
    { id: "balance", header: "Balance", align: "right", cell: (i) => <span className="font-semibold text-destructive-strong">{formatCurrency(i.balanceAmount)}</span>, sortValue: (i) => i.balanceAmount },
    {
      id: "reminders",
      header: "Reminders",
      cell: (i) => <Stack top={plural(i.reminderCount, "sent", "sent")} bottom={i.lastReminderDate ? `Last ${formatDate(i.lastReminderDate)}` : undefined} />,
      sortValue: (i) => i.reminderCount,
      hideBelow: "lg"
    },
    {
      id: "send",
      header: <span className="sr-only">Send</span>,
      align: "right",
      cell: (i) => (
        <Button
          size="xs"
          variant={i.canSendReminder && i.customerPhone ? "default" : "outline"}
          disabled={!i.canSendReminder || sendingId === i._id || !i.customerPhone}
          onClick={() => openSendDialog(i)}
          title={!i.canSendReminder && !i.maxRemindersReached && i.customerPhone ? "Too soon since the last reminder" : undefined}
        >
          {sendingId === i._id ? <Loader2 className="animate-spin" /> : <Send />}
          {sendLabel(i)}
        </Button>
      ),
      className: "w-[120px]"
    }
  ];

  const historyColumns: Column<Reminder>[] = [
    { id: "at", header: "Sent", cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.sentAt || r.createdAt)}</span>, className: "w-[170px]" },
    { id: "customer", header: "Customer", cell: (r) => <EntityCell avatar={r.customerName} title={r.customerName} subtitle={r.customerPhone} /> },
    { id: "invoice", header: "Invoice", cell: (r) => <span className="font-mono text-[13px]">{r.invoiceNumber}</span>, hideBelow: "md" },
    { id: "type", header: "Type", cell: (r) => <Tag>{REMINDER_TYPE[r.reminderType] || r.reminderType}</Tag>, hideBelow: "lg" },
    { id: "balance", header: "Balance", align: "right", cell: (r) => formatCurrency(r.balanceAmount), hideBelow: "lg" },
    { id: "count", header: "No.", align: "right", cell: (r) => `#${r.reminderCount}`, hideBelow: "xl" },
    {
      id: "status",
      header: "Status",
      cell: (r) => {
        const st = REMINDER_STATUS[r.status] || { label: r.status, tone: "neutral" as PillTone };
        return (
          <div className="flex flex-col items-start gap-0.5">
            <StatusPill tone={st.tone}>{st.label}</StatusPill>
            {r.status === "failed" && r.failureReason && <span className="max-w-[220px] text-xs text-destructive-strong">{r.failureReason}</span>}
          </div>
        );
      },
      className: "w-[150px]"
    }
  ];

  const refreshAll = async () => {
    setLoading(true);
    await Promise.all([fetchStats(), fetchOverdueInvoices(), fetchReminders(historyPage)]);
    setLoading(false);
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow="Billing & finance"
        title="Payment reminders"
        description="Invoices past their due date, and the WhatsApp reminders sent to collect them."
        actions={
          <>
            <Button variant="outline" onClick={refreshAll} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} />
              Refresh
            </Button>
            <Button onClick={() => setBulkConfirmOpen(true)} disabled={sendingBulk || eligibleCount === 0}>
              {sendingBulk ? <Loader2 className="animate-spin" /> : <SendHorizonal />}
              Send all ({eligibleCount})
            </Button>
          </>
        }
      />

      <MetricBar
        loading={loading}
        metrics={[
          { label: "Overdue invoices", value: stats.overdueInvoices, hint: "Past the due date", tone: stats.overdueInvoices > 0 ? "danger" : "success" },
          { label: "Outstanding", value: formatINR(stats.totalOutstanding, { compact: stats.totalOutstanding >= 1e5 }), hint: "Owed on those invoices", tone: stats.totalOutstanding > 0 ? "warning" : "default" },
          { label: "Customers to remind", value: stats.customersNeedingReminder, hint: `${plural(eligibleCount, "reminder")} ready to send`, tone: "info" },
          { label: "Sent today", value: stats.sentToday, hint: `${stats.totalSent} all time`, tone: "success" }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs
          value={activeTab}
          onChange={setActiveTab}
          tabs={[
            { value: "overdue", label: "Overdue invoices", count: overdueInvoices.length, tone: "danger" },
            { value: "history", label: "Reminder history", count: historyTotal },
            { value: "settings", label: "Settings", icon: Settings }
          ]}
        />

        {activeTab === "overdue" && (
          <DataCard
            toolbar={<Toolbar search={<SearchField value={searchQuery} onChange={setSearchQuery} placeholder="Search customer, invoice or phone" />} />}
            footer={!loading && filteredInvoices.length > 0 && `${plural(filteredInvoices.length, "invoice")} · ${eligibleCount} can be reminded now`}
          >
            <DataTable
              columns={overdueColumns}
              rows={filteredInvoices}
              rowKey={(i) => i._id}
              loading={loading}
              defaultSort={{ id: "due", dir: "desc" }}
              rowClassName={(i) => (i.daysOverdue > 30 ? "bg-destructive-soft/30" : undefined)}
              mobile={(i) => (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{i.customerName}</span>
                    <span className="num font-semibold text-destructive-strong">{formatCurrency(i.balanceAmount)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>
                      <span className="font-mono">{i.invoiceNumber}</span> · {plural(i.daysOverdue, "day")} overdue
                    </span>
                    <Button size="xs" disabled={!i.canSendReminder || !i.customerPhone || sendingId === i._id} onClick={() => openSendDialog(i)}>
                      <Send />
                      {sendLabel(i)}
                    </Button>
                  </div>
                </div>
              )}
              empty={
                <EmptyState
                  tone="success"
                  icon={CheckCircle2}
                  title={searchQuery ? "No overdue invoices match" : "All clear"}
                  description={searchQuery ? undefined : "No invoice is past its due date. Every payment is on time."}
                />
              }
            />
          </DataCard>
        )}

        {activeTab === "history" && (
          <DataCard
            toolbar={
              <Toolbar>
                <FilterSelect
                  label="Status"
                  value={statusFilter}
                  onChange={(v) => {
                    setStatusFilter(v);
                    setHistoryPage(1);
                  }}
                  options={[
                    { value: "sent", label: "Sent" },
                    { value: "delivered", label: "Delivered" },
                    { value: "failed", label: "Failed" },
                    { value: "pending", label: "Pending" }
                  ]}
                />
              </Toolbar>
            }
            footer={historyTotal > 0 && <Pagination page={historyPage} pageSize={20} total={historyTotal} onPageChange={setHistoryPage} noun="reminders" />}
          >
            <DataTable
              columns={historyColumns}
              rows={reminders}
              rowKey={(r) => r._id}
              loading={loading}
              mobile={(r) => {
                const st = REMINDER_STATUS[r.status] || { label: r.status, tone: "neutral" as PillTone };
                return (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-medium">{r.customerName}</span>
                      <StatusPill tone={st.tone}>{st.label}</StatusPill>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDateTime(r.sentAt || r.createdAt)} · <span className="font-mono">{r.invoiceNumber}</span> · #{r.reminderCount}
                    </div>
                  </div>
                );
              }}
              empty={<EmptyState compact icon={MessageSquare} title="No reminders yet" description="Reminders appear here once you start sending them." />}
            />
          </DataCard>
        )}

        {activeTab === "settings" && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* General Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Reminder Configuration
              </CardTitle>
              <CardDescription>
                Configure when and how reminders are sent
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base">Enable Reminders</Label>
                  <p className="text-sm text-muted-foreground">
                    Allow sending payment reminders via WhatsApp
                  </p>
                </div>
                <Switch
                  checked={settings.enabled}
                  onCheckedChange={(checked) =>
                    setSettings((prev) => ({ ...prev, enabled: checked }))
                  }
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base">Auto-Send</Label>
                  <p className="text-sm text-muted-foreground">
                    Automatically send reminders every hour
                  </p>
                </div>
                <Switch
                  checked={settings.autoSend}
                  onCheckedChange={(checked) =>
                    setSettings((prev) => ({ ...prev, autoSend: checked }))
                  }
                  disabled={!settings.enabled}
                />
              </div>

              <div className="space-y-2">
                <Label>Days After Due Date</Label>
                <p className="text-xs text-muted-foreground mb-1">
                  Send first reminder X days after the invoice due date
                </p>
                <Input
                  type="number"
                  min={0}
                  max={30}
                  value={settings.daysAfterDue}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, daysAfterDue: parseInt(e.target.value) || 0 }))
                  }
                  disabled={!settings.enabled}
                />
              </div>

              <div className="space-y-2">
                <Label>Reminder Interval (Days)</Label>
                <p className="text-xs text-muted-foreground mb-1">
                  Wait X days between each follow-up reminder
                </p>
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={settings.reminderInterval}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, reminderInterval: parseInt(e.target.value) || 1 }))
                  }
                  disabled={!settings.enabled}
                />
              </div>

              <div className="space-y-2">
                <Label>Maximum Reminders Per Invoice</Label>
                <p className="text-xs text-muted-foreground mb-1">
                  Stop sending after X reminders for the same invoice
                </p>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={settings.maxReminders}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, maxReminders: parseInt(e.target.value) || 1 }))
                  }
                  disabled={!settings.enabled}
                />
              </div>

              <Button
                className="w-full gap-2"
                onClick={handleSaveSettings}
                disabled={savingSettings}
              >
                {savingSettings ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Save Settings
              </Button>
            </CardContent>
          </Card>

          {/* Message Template */}
          {/* Message Template */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                Message Template
              </CardTitle>
              <CardDescription>
                Customize the WhatsApp message sent to customers
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
            
              {metaIntegrationEnabled ? (
                <div className="space-y-4 border rounded-lg p-4 bg-muted/20">
                  <div className="space-y-2">
                    <Label>Select Meta Template</Label>
                    <Select 
                      disabled={!settings.enabled}
                      value={settings.metaTemplateName || "none"}
                      onValueChange={(val) => {
                        setSettings(prev => ({ 
                          ...prev, 
                          metaTemplateName: val === "none" ? "" : val,
                          templateVariableMapping: {} 
                        }));
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose an approved template" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">-- Use Free Text (No Meta Template) --</SelectItem>
                        {metaTemplates.filter(t => t.status === 'APPROVED').map(t => (
                          <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Only APPROVED templates from your Meta account are shown. 
                      Go to the WhatsApp tab to manage templates.
                    </p>
                  </div>

                  {settings.metaTemplateName && (() => {
                    const selectedTemplateObj = metaTemplates.find(t => t.name === settings.metaTemplateName);
                    const bodyText = getTemplateBodyText(selectedTemplateObj);
                    const detected = getTemplateVariableNumbers(selectedTemplateObj);
                    // Fall back to a 5-slot grid only if we couldn't read the template's real structure
                    const varNumbers = selectedTemplateObj ? detected : [1, 2, 3, 4, 5];

                    return (
                      <div className="space-y-3 mt-4 border-t pt-4">
                        <Label>Variable Mapping</Label>
                        {bodyText && (
                          <p className="text-xs bg-muted rounded p-2 font-mono whitespace-pre-wrap">{bodyText}</p>
                        )}
                        {varNumbers.length === 0 ? (
                          <p className="text-xs text-muted-foreground">This template has no variables — nothing to map.</p>
                        ) : (
                          <>
                            <p className="text-xs text-muted-foreground">
                              Map your ERP data to each variable. Meta rejects the message if the count doesn't match exactly, so every slot below must be filled.
                            </p>
                            {varNumbers.map(num => (
                              <div key={num} className="flex items-center gap-4">
                                <span className="text-sm font-mono bg-muted px-2 py-1 rounded w-16 text-center">{`{{${num}}}`}</span>
                                <Select
                                  disabled={!settings.enabled}
                                  value={settings.templateVariableMapping?.[num.toString()] || ""}
                                  onValueChange={(val) => {
                                    setSettings(prev => ({
                                      ...prev,
                                      templateVariableMapping: {
                                        ...(prev.templateVariableMapping || {}),
                                        [num.toString()]: val
                                      }
                                    }));
                                  }}
                                >
                                  <SelectTrigger className="flex-1">
                                    <SelectValue placeholder={`Select data for {{${num}}}`} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="customerName">Customer Name</SelectItem>
                                    <SelectItem value="invoiceNumber">Invoice Number</SelectItem>
                                    <SelectItem value="totalAmount">Total Amount</SelectItem>
                                    <SelectItem value="balanceAmount">Balance Amount</SelectItem>
                                    <SelectItem value="dueDate">Due Date</SelectItem>
                                    <SelectItem value="daysOverdue">Days Overdue</SelectItem>
                                    <SelectItem value="businessName">Business Name</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="bg-warning-soft border border-warning/30 text-warning-strong p-3 rounded text-sm mb-4">
                  WhatsApp isn't connected yet, so reminders can't be sent. Connect it on the WhatsApp page. Note: a free-text message only reaches customers who wrote to you in the last 24 hours — use an approved Meta template for everyone else.
                </div>
              )}

              {!settings.metaTemplateName && (
                <>
                  <div className="space-y-2">
                    <Label>Free Text Message Template</Label>
                    <Textarea
                      value={settings.messageTemplate}
                      onChange={(e) =>
                        setSettings((prev) => ({ ...prev, messageTemplate: e.target.value }))
                      }
                      rows={6}
                      placeholder="Enter your reminder message template..."
                      disabled={!settings.enabled}
                    />
                  </div>

                  <div className="rounded-lg bg-muted p-4 space-y-2">
                    <p className="text-sm font-medium">Available Variables:</p>
                    <div className="grid grid-cols-2 gap-1">
                      {[
                        { var: "{{customerName}}", desc: "Customer name" },
                        { var: "{{invoiceNumber}}", desc: "Invoice number" },
                        { var: "{{totalAmount}}", desc: "Invoice total" },
                        { var: "{{balanceAmount}}", desc: "Balance due" },
                        { var: "{{dueDate}}", desc: "Due date" },
                        { var: "{{daysOverdue}}", desc: "Days overdue" },
                        { var: "{{businessName}}", desc: "Your company name" },
                      ].map((v) => (
                        <div key={v.var} className="flex items-center gap-2">
                          <code className="text-xs bg-background px-1.5 py-0.5 rounded border font-mono">
                            {v.var}
                          </code>
                          <span className="text-xs text-muted-foreground">{v.desc}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <div className="flex gap-2">
                {!settings.metaTemplateName && (
                  <Button
                    variant="outline"
                    className="flex-1 gap-2"
                    onClick={handlePreviewMessage}
                    disabled={!settings.enabled}
                  >
                    <Send className="h-4 w-4" />
                    Preview
                  </Button>
                )}
                <Button
                  className="flex-1 gap-2 bg-green-600 hover:bg-green-700"
                  onClick={handleSaveSettings}
                  disabled={savingSettings}
                >
                  {savingSettings ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save Template Config
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
        )}
      </div>

      {/* Send Reminder Dialog — pick template at send time */}
      <Dialog open={!!sendDialogInvoice} onOpenChange={(open) => !open && setSendDialogInvoice(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5 text-success-strong" />
              Send Payment Reminder
            </DialogTitle>
            <DialogDescription>
              {sendDialogInvoice && (
                <>
                  To <strong>{sendDialogInvoice.customerName}</strong> ({sendDialogInvoice.customerPhone}) for invoice{" "}
                  <strong>{sendDialogInvoice.invoiceNumber}</strong>
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Template</Label>
              <Select
                value={sendTemplateChoice}
                onValueChange={(val) => {
                  setSendTemplateChoice(val);
                  // Reuse the saved default mapping only if it's the same template; otherwise start fresh
                  // so we don't send stale variables that don't match this template's actual slots.
                  setSendTemplateMapping(val === settings.metaTemplateName ? (settings.templateVariableMapping || {}) : {});
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a template" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">
                    Default {settings.metaTemplateName ? `(Meta: ${settings.metaTemplateName})` : "(Free Text)"}
                  </SelectItem>
                  <SelectItem value="__freetext__">Free Text (No Meta Template)</SelectItem>
                  {metaIntegrationEnabled &&
                    metaTemplates
                      .filter((t) => t.status === "APPROVED")
                      .map((t) => (
                        <SelectItem key={t.name} value={t.name}>
                          {t.name}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
            </div>

            {sendTemplateChoice !== "__default__" && sendTemplateChoice !== "__freetext__" && (() => {
              const chosenTemplateObj = metaTemplates.find((t) => t.name === sendTemplateChoice);
              const bodyText = getTemplateBodyText(chosenTemplateObj);
              const varNumbers = getTemplateVariableNumbers(chosenTemplateObj);

              return (
                <div className="space-y-3 border-t pt-4">
                  <Label>Variable Mapping</Label>
                  {bodyText && (
                    <p className="text-xs bg-muted rounded p-2 font-mono whitespace-pre-wrap">{bodyText}</p>
                  )}
                  {varNumbers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">This template has no variables.</p>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Meta rejects the message if the variable count doesn't match exactly — fill every slot below.
                      </p>
                      {varNumbers.map((num) => (
                        <div key={num} className="flex items-center gap-4">
                          <span className="text-sm font-mono bg-muted px-2 py-1 rounded w-16 text-center">{`{{${num}}}`}</span>
                          <Select
                            value={sendTemplateMapping[num.toString()] || ""}
                            onValueChange={(val) =>
                              setSendTemplateMapping((prev) => ({
                                ...prev,
                                [num.toString()]: val,
                              }))
                            }
                          >
                            <SelectTrigger className="flex-1">
                              <SelectValue placeholder={`Select data for {{${num}}}`} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="customerName">Customer Name</SelectItem>
                              <SelectItem value="invoiceNumber">Invoice Number</SelectItem>
                              <SelectItem value="totalAmount">Total Amount</SelectItem>
                              <SelectItem value="balanceAmount">Balance Amount</SelectItem>
                              <SelectItem value="dueDate">Due Date</SelectItem>
                              <SelectItem value="daysOverdue">Days Overdue</SelectItem>
                              <SelectItem value="businessName">Business Name</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              );
            })()}

            {sendTemplateChoice === "__freetext__" && (
              <p className="text-xs text-muted-foreground border-t pt-4">
                Uses the free text message template configured in Settings, filled in with this invoice's details.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSendDialogInvoice(null)}
              disabled={sendingId === sendDialogInvoice?._id}
            >
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700 gap-2"
              onClick={handleConfirmSend}
              disabled={sendingId === sendDialogInvoice?._id}
            >
              {sendingId === sendDialogInvoice?._id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send Reminder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Send Confirmation Dialog */}
      <AlertDialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <SendHorizonal className="h-5 w-5 text-success-strong" />
              Send Bulk Reminders?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will send WhatsApp payment reminders to all eligible customers with overdue invoices.
              <br /><br />
              <strong>{eligibleCount} invoices</strong> are currently eligible for reminders.
              Customers without phone numbers or who have reached the maximum reminder count will be skipped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkSend} className="bg-green-600 hover:bg-green-700">
              Send All Reminders
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Message Preview Dialog */}
      <Dialog open={previewDialogOpen} onOpenChange={setPreviewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-success-strong" />
              Message Preview
            </DialogTitle>
            <DialogDescription>
              This is how the WhatsApp message will look to the customer
            </DialogDescription>
          </DialogHeader>
          <div className="bg-[#e5ded8] rounded-lg p-4">
            <div className="bg-[#dcf8c6] rounded-lg p-3 max-w-[90%] ml-auto shadow-sm">
              <p className="text-sm text-foreground whitespace-pre-wrap">{previewMessage}</p>
              <div className="text-right mt-1">
                <span className="text-[10px] text-muted-foreground">
                  {new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} ✓✓
                </span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
