import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Search, FileText, Trash2, Clock, CheckCircle, XCircle, Send, Mail, MessageSquare, Download, Receipt, Ban, TimerOff, Lock } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { CreateQuotationDialog } from "@/components/quotations/CreateQuotationDialog";
import apiClient from "@/lib/apiClient";
import { getTemplateBodyText, getTemplateVariableNumbers } from "@/lib/whatsappTemplates";
import { useToast } from "@/hooks/use-toast";

interface Quotation {
  _id: string;
  quotationNumber: string;
  customer_id: { _id: string; name: string; email?: string; phone?: string };
  gst_type: "gst" | "non_gst";
  is_interstate: boolean;
  valid_until: string;
  status: QuotationStatus;
  total_amount: number;
  payment_link?: string;
  createdAt: string;
  notes?: string;
  convertedInvoiceId?: string;
  convertedInvoiceNumber?: string;
}

type QuotationStatus = "draft" | "sent" | "approved" | "rejected" | "expired" | "converted" | "closed";

const statusConfig = {
  draft: { label: "Draft", variant: "secondary" as const, icon: Clock },
  sent: { label: "Sent", variant: "default" as const, icon: Send },
  approved: { label: "Approved", variant: "default" as const, icon: CheckCircle },
  rejected: { label: "Rejected", variant: "destructive" as const, icon: XCircle },
  expired: { label: "Expired", variant: "outline" as const, icon: TimerOff },
  converted: { label: "Converted", variant: "default" as const, icon: Receipt },
  closed: { label: "Closed", variant: "outline" as const, icon: Lock },
};

// Statuses the user can set by hand. 'converted' is excluded — it is only ever
// set by the convert-to-invoice action, which needs a real invoice behind it.
const SELECTABLE_STATUSES: QuotationStatus[] = ["draft", "sent", "approved", "rejected", "expired", "closed"];

// Summary tiles: the states worth counting at a glance.
const SUMMARY_STATUSES: QuotationStatus[] = ["draft", "sent", "approved", "converted"];

// A quotation in one of these states is finished and cannot be billed.
const isTerminal = (s: QuotationStatus) => s === "converted" || s === "closed";

export default function Quotations() {
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [emailDialog, setEmailDialog] = useState<{ open: boolean; quotation: Quotation | null }>({ open: false, quotation: null });
  const [emailRecipient, setEmailRecipient] = useState("");
  const [emailMessage, setEmailMessage] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [convertDialog, setConvertDialog] = useState<{ open: boolean; quotation: Quotation | null }>({ open: false, quotation: null });
  const [whatsappDialog, setWhatsappDialog] = useState<{ open: boolean; quotation: Quotation | null }>({ open: false, quotation: null });
  const [whatsappPhone, setWhatsappPhone] = useState("");
  const [sendingWhatsapp, setSendingWhatsapp] = useState(false);
  const [metaIntegrationEnabled, setMetaIntegrationEnabled] = useState(false);
  const [metaTemplates, setMetaTemplates] = useState<any[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [templateMapping, setTemplateMapping] = useState<Record<string, string>>({});
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    if (!whatsappDialog.open) return;
    let cancelled = false;
    (async () => {
      setLoadingTemplates(true);
      try {
        const waSettings: any = await apiClient.getWhatsAppSettings();
        const enabled = !!waSettings?.settings?.enabled;
        if (cancelled) return;
        setMetaIntegrationEnabled(enabled);
        if (enabled) {
          const tmplResponse: any = await apiClient.getMetaTemplates();
          if (cancelled) return;
          setMetaTemplates((tmplResponse?.templates || []).filter((t: any) => t.status === "APPROVED"));
        } else {
          setMetaTemplates([]);
        }
      } catch (err) {
        console.error("Error loading WhatsApp templates:", err);
        if (!cancelled) {
          setMetaIntegrationEnabled(false);
          setMetaTemplates([]);
        }
      } finally {
        if (!cancelled) setLoadingTemplates(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [whatsappDialog.open]);

  const fetchQuotations = async () => {
    setLoading(true);
    try {
      const response = await apiClient.getQuotations();
      const data = (response as any)?.quotations || (response as any) || [];
      setQuotations(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Error fetching quotations:", error);
      toast({
        title: "Error",
        description: "Failed to fetch quotations",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchQuotations();
  }, []);

  const filtered = quotations.filter((q) => {
    const query = searchQuery.toLowerCase();
    return (
      q.quotationNumber?.toLowerCase().includes(query) ||
      q.customer_id?.name?.toLowerCase().includes(query)
    );
  });

  const openEmailDialog = (q: Quotation) => {
    setEmailRecipient(q.customer_id?.email || "");
    setEmailMessage("");
    setEmailDialog({ open: true, quotation: q });
  };

  const handleSendEmail = async () => {
    if (!emailDialog.quotation) return;
    setSendingEmail(true);
    try {
      await apiClient.sendQuotationEmail(emailDialog.quotation._id, emailRecipient, emailMessage || undefined);
      toast({ title: "Email Sent", description: `Quotation sent to ${emailRecipient}` });
      setEmailDialog({ open: false, quotation: null });
      fetchQuotations();
    } catch {
      toast({ title: "Error", description: "Failed to send email", variant: "destructive" });
    } finally {
      setSendingEmail(false);
    }
  };

  const openWhatsAppDialog = (q: Quotation) => {
    setWhatsappPhone(q.customer_id?.phone || "");
    setSelectedTemplate("");
    setTemplateMapping({});
    setWhatsappDialog({ open: true, quotation: q });
  };

  const handleSendWhatsApp = async () => {
    const quotation = whatsappDialog.quotation;
    if (!quotation) return;

    if (!whatsappPhone) {
      toast({ title: "Error", description: "Please enter a phone number", variant: "destructive" });
      return;
    }
    if (!metaIntegrationEnabled) {
      toast({
        title: "Error",
        description: "WhatsApp Business API is not connected. Set it up in Settings > WhatsApp first.",
        variant: "destructive",
      });
      return;
    }
    if (!selectedTemplate) {
      toast({ title: "Error", description: "Please choose an approved WhatsApp template", variant: "destructive" });
      return;
    }

    setSendingWhatsapp(true);
    try {
      await apiClient.sendQuotationWhatsApp(quotation._id, whatsappPhone, selectedTemplate, templateMapping);
      toast({ title: "Success", description: `Quotation sent to ${whatsappPhone} via WhatsApp` });
      setWhatsappDialog({ open: false, quotation: null });
      setWhatsappPhone("");
      setSelectedTemplate("");
      setTemplateMapping({});
      fetchQuotations();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to send quotation via WhatsApp",
        variant: "destructive",
      });
    } finally {
      setSendingWhatsapp(false);
    }
  };

  const handleDownloadPDF = async (q: Quotation) => {
    try {
      const blob = await apiClient.downloadQuotationPDF(q._id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Quotation_${q.quotationNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error: any) {
      toast({
        title: "PDF Error",
        description: error.message || "Failed to download PDF. Ensure company settings are configured.",
        variant: "destructive",
      });
    }
  };

  const handleStatusChange = async (q: Quotation, status: QuotationStatus) => {
    if (status === q.status) return;
    setBusyId(q._id);
    // Optimistic: reflect the new badge immediately, roll back if the call fails.
    const previous = q.status;
    setQuotations((prev) => prev.map((x) => (x._id === q._id ? { ...x, status } : x)));
    try {
      await apiClient.updateQuotationStatus(q._id, status);
      toast({ title: "Status updated", description: `${q.quotationNumber} is now ${statusConfig[status].label}` });
      fetchQuotations();
    } catch (error: any) {
      setQuotations((prev) => prev.map((x) => (x._id === q._id ? { ...x, status: previous } : x)));
      toast({
        title: "Could not update status",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleConvert = async () => {
    const q = convertDialog.quotation;
    if (!q) return;
    setBusyId(q._id);
    try {
      const res: any = await apiClient.convertQuotationToInvoice(q._id);
      const invoiceNumber = res?.invoice?.invoiceNumber ?? res?.data?.invoice?.invoiceNumber;
      toast({
        title: "Invoice created",
        description: `${q.quotationNumber} → ${invoiceNumber ?? "invoice"}`,
      });
      setConvertDialog({ open: false, quotation: null });
      fetchQuotations();
    } catch (error: any) {
      const message: string = error?.message || "Could not convert this quotation.";

      // The server may have finished the conversion even though we stopped
      // waiting (timeout, restart, dropped connection). Treat "already
      // converted" as success and re-sync rather than alarming the user.
      if (/already converted/i.test(message)) {
        toast({ title: "Already converted", description: message });
        setConvertDialog({ open: false, quotation: null });
        fetchQuotations();
        return;
      }

      // A timeout is not proof the conversion failed — tell the user to check.
      if (/timed out/i.test(message)) {
        toast({
          title: "Still processing",
          description: "The server did not respond in time. Refreshing — check whether the invoice was created before retrying.",
          variant: "destructive",
        });
        setConvertDialog({ open: false, quotation: null });
        fetchQuotations();
        return;
      }

      toast({ title: "Conversion failed", description: message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiClient.deleteQuotation(id);
      toast({ title: "Deleted", description: "Quotation deleted" });
      fetchQuotations();
    } catch {
      toast({ title: "Error", description: "Failed to delete quotation", variant: "destructive" });
    }
  };

  const formatDate = (dateStr: string) =>
    dateStr ? new Date(dateStr).toLocaleDateString("en-IN") : "-";

  const formatAmount = (amount: number) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(amount ?? 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Quotations</h1>
          <p className="text-muted-foreground text-sm">Manage and track all customer quotations</p>
        </div>
        <CreateQuotationDialog onQuotationCreated={fetchQuotations}>
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            New Quotation
          </Button>
        </CreateQuotationDialog>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {SUMMARY_STATUSES.map((status) => {
          const count = quotations.filter((q) => q.status === status).length;
          const cfg = statusConfig[status];
          const Icon = cfg.icon;
          return (
            <Card key={status}>
              <CardContent className="p-4 flex items-center gap-3">
                <Icon className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground capitalize">{cfg.label}</p>
                  <p className="text-xl font-bold">{count}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search by number or customer..."
          className="pl-9"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">All Quotations</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
              Loading quotations...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <FileText className="w-10 h-10 opacity-40" />
              <p className="text-sm">
                {searchQuery ? "No quotations match your search." : "No quotations yet. Create your first one."}
              </p>
              {!searchQuery && (
                <CreateQuotationDialog onQuotationCreated={fetchQuotations}>
                  <Button variant="outline" size="sm" className="gap-2">
                    <Plus className="w-4 h-4" />
                    New Quotation
                  </Button>
                </CreateQuotationDialog>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-3 font-medium">Quotation #</th>
                    <th className="text-left px-4 py-3 font-medium">Customer</th>
                    <th className="text-left px-4 py-3 font-medium">GST Type</th>
                    <th className="text-left px-4 py-3 font-medium">Valid Until</th>
                    <th className="text-left px-4 py-3 font-medium">Amount</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((q) => {
                    const cfg = statusConfig[q.status] ?? statusConfig.draft;
                    const Icon = cfg.icon;
                    return (
                      <tr key={q._id} className="border-b hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 font-mono">{q.quotationNumber}</td>
                        <td className="px-4 py-3">{q.customer_id?.name ?? "-"}</td>
                        <td className="px-4 py-3">
                          <Badge variant="outline">
                            {q.gst_type === "gst"
                              ? `GST (${q.is_interstate ? "Interstate" : "Intrastate"})`
                              : "Non-GST"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">{formatDate(q.valid_until)}</td>
                        <td className="px-4 py-3 font-medium">{formatAmount(q.total_amount)}</td>
                        <td className="px-4 py-3">
                          {q.status === "converted" ? (
                            // Terminal and system-owned: show it, don't let it be edited.
                            <Badge variant={cfg.variant} className="gap-1" title={`Invoice ${q.convertedInvoiceNumber ?? ""}`}>
                              <Icon className="w-3 h-3" />
                              {cfg.label}
                            </Badge>
                          ) : (
                            <Select
                              value={q.status}
                              onValueChange={(v) => handleStatusChange(q, v as QuotationStatus)}
                              disabled={busyId === q._id}
                            >
                              <SelectTrigger className="h-7 w-[135px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {SELECTABLE_STATUSES.map((s) => {
                                  const sc = statusConfig[s];
                                  const SIcon = sc.icon;
                                  return (
                                    <SelectItem key={s} value={s} className="text-xs">
                                      <span className="flex items-center gap-2">
                                        <SIcon className="w-3 h-3" />
                                        {sc.label}
                                      </span>
                                    </SelectItem>
                                  );
                                })}
                              </SelectContent>
                            </Select>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{formatDate(q.createdAt)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1 h-7 px-2 text-xs"
                              onClick={() => handleDownloadPDF(q)}
                              title="Download PDF"
                            >
                              <Download className="w-3 h-3" />
                              PDF
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1 h-7 px-2 text-xs"
                              onClick={() => openEmailDialog(q)}
                              title="Send via email"
                            >
                              <Mail className="w-3 h-3" />
                              Send
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1 h-7 px-2 text-xs"
                              onClick={() => openWhatsAppDialog(q)}
                              title="Send via WhatsApp"
                            >
                              <MessageSquare className="w-3 h-3" />
                              WhatsApp
                            </Button>
                            {q.status === "converted" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="gap-1 h-7 px-2 text-xs"
                                onClick={() => navigate("/invoices")}
                                title={`View invoice ${q.convertedInvoiceNumber ?? ""}`}
                              >
                                <Receipt className="w-3 h-3" />
                                {q.convertedInvoiceNumber ?? "Invoice"}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1 h-7 px-2 text-xs"
                                disabled={busyId === q._id || isTerminal(q.status) || q.status === "rejected" || q.status === "expired"}
                                onClick={() => setConvertDialog({ open: true, quotation: q })}
                                title={
                                  q.status === "rejected" || q.status === "expired" || isTerminal(q.status)
                                    ? `A ${q.status} quotation cannot be invoiced`
                                    : "Convert to invoice"
                                }
                              >
                                <Receipt className="w-3 h-3" />
                                Invoice
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-destructive hover:text-destructive"
                              onClick={() => handleDelete(q._id)}
                              title="Delete quotation"
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      {/* Convert to Invoice confirmation */}
      <Dialog open={convertDialog.open} onOpenChange={(open) => !open && setConvertDialog({ open: false, quotation: null })}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="w-5 h-5" />
              Convert to Invoice
            </DialogTitle>
          </DialogHeader>

          {convertDialog.quotation && (
            <div className="space-y-3 py-2 text-sm">
              <div className="rounded-md bg-muted px-3 py-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Quotation</span>
                  <span className="font-mono font-medium">{convertDialog.quotation.quotationNumber}</span>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-muted-foreground">Customer</span>
                  <span className="font-medium">{convertDialog.quotation.customer_id?.name}</span>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-muted-foreground">Amount</span>
                  <span className="font-medium">{formatAmount(convertDialog.quotation.total_amount)}</span>
                </div>
              </div>
              <p className="text-muted-foreground">
                A draft invoice will be created with these items, due 30 days from today. This
                quotation stays on record and is marked <span className="font-medium">Converted</span> —
                it cannot be invoiced again.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertDialog({ open: false, quotation: null })}>
              Cancel
            </Button>
            <Button onClick={handleConvert} disabled={busyId !== null} className="gap-2">
              <Receipt className="w-4 h-4" />
              {busyId ? "Converting..." : "Create Invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send Email Dialog */}
      <Dialog open={emailDialog.open} onOpenChange={(open) => !open && setEmailDialog({ open: false, quotation: null })}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="w-5 h-5" />
              Send Quotation via Email
            </DialogTitle>
          </DialogHeader>

          {emailDialog.quotation && (
            <div className="space-y-4 py-2">
              <div className="rounded-md bg-muted px-3 py-2 text-sm">
                <span className="text-muted-foreground">Quotation: </span>
                <span className="font-mono font-medium">{emailDialog.quotation.quotationNumber}</span>
                <span className="text-muted-foreground ml-3">Customer: </span>
                <span className="font-medium">{emailDialog.quotation.customer_id?.name}</span>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="email-recipient">Recipient Email</Label>
                <Input
                  id="email-recipient"
                  type="email"
                  value={emailRecipient}
                  onChange={(e) => setEmailRecipient(e.target.value)}
                  placeholder="customer@example.com"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="email-message">Message (optional)</Label>
                <Textarea
                  id="email-message"
                  value={emailMessage}
                  onChange={(e) => setEmailMessage(e.target.value)}
                  placeholder="Add a personal note to the email..."
                  rows={3}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailDialog({ open: false, quotation: null })}>
              Cancel
            </Button>
            <Button
              onClick={handleSendEmail}
              disabled={sendingEmail || !emailRecipient}
              className="gap-2"
            >
              <Send className="w-4 h-4" />
              {sendingEmail ? "Sending..." : "Send Email"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send WhatsApp Dialog */}
      <Dialog open={whatsappDialog.open} onOpenChange={(open) => !open && setWhatsappDialog({ open: false, quotation: null })}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5" />
              Send Quotation via WhatsApp
            </DialogTitle>
          </DialogHeader>

          {whatsappDialog.quotation && (
            <div className="space-y-4 py-2">
              <div className="rounded-md bg-muted px-3 py-2 text-sm">
                <span className="text-muted-foreground">Quotation: </span>
                <span className="font-mono font-medium">{whatsappDialog.quotation.quotationNumber}</span>
                <span className="text-muted-foreground ml-3">Customer: </span>
                <span className="font-medium">{whatsappDialog.quotation.customer_id?.name}</span>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="whatsapp-phone">Phone Number</Label>
                <Input
                  id="whatsapp-phone"
                  type="tel"
                  value={whatsappPhone}
                  onChange={(e) => setWhatsappPhone(e.target.value)}
                  placeholder="+1234567890"
                />
              </div>

              {!loadingTemplates && !metaIntegrationEnabled && (
                <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-3">
                  WhatsApp Business API isn't connected yet. Go to Settings → WhatsApp to connect it before sending quotations.
                </div>
              )}

              {metaIntegrationEnabled && (
                <div className="space-y-1.5">
                  <Label htmlFor="whatsapp-template">WhatsApp Template</Label>
                  <Select
                    value={selectedTemplate}
                    onValueChange={(value) => {
                      setSelectedTemplate(value);
                      setTemplateMapping({});
                    }}
                  >
                    <SelectTrigger id="whatsapp-template">
                      <SelectValue placeholder={metaTemplates.length ? "Choose an approved template" : "No approved templates found"} />
                    </SelectTrigger>
                    <SelectContent>
                      {metaTemplates.map((t: any) => (
                        <SelectItem key={t.name} value={t.name}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {metaTemplates.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No approved templates yet. Create one in Settings → WhatsApp.
                    </p>
                  )}
                </div>
              )}

              {selectedTemplate && (() => {
                const chosenTemplate = metaTemplates.find((t: any) => t.name === selectedTemplate);
                const bodyText = getTemplateBodyText(chosenTemplate);
                const varNumbers = getTemplateVariableNumbers(chosenTemplate);

                return (
                  <div className="space-y-3 border-t pt-4">
                    <Label>Variable Mapping</Label>
                    {bodyText && (
                      <p className="text-xs bg-muted rounded p-2 font-mono whitespace-pre-wrap">{bodyText}</p>
                    )}
                    {varNumbers.length === 0 ? (
                      <p className="text-xs text-muted-foreground">This template has no variables — nothing to map.</p>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground">
                          Meta rejects the message if the variable count doesn't match exactly — fill every slot below.
                        </p>
                        {varNumbers.map((num) => (
                          <div key={num} className="flex items-center gap-4">
                            <span className="text-sm font-mono bg-muted px-2 py-1 rounded w-16 text-center">{`{{${num}}}`}</span>
                            <Select
                              value={templateMapping[num.toString()] || ""}
                              onValueChange={(val) =>
                                setTemplateMapping((prev) => ({
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
                                <SelectItem value="quotationNumber">Quotation Number</SelectItem>
                                <SelectItem value="totalAmount">Total Amount</SelectItem>
                                <SelectItem value="validUntil">Valid Until</SelectItem>
                                <SelectItem value="businessName">Business Name</SelectItem>
                                <SelectItem value="quotationLink">Quotation Link (PDF)</SelectItem>
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
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setWhatsappDialog({ open: false, quotation: null })}>
              Cancel
            </Button>
            <Button
              onClick={handleSendWhatsApp}
              disabled={sendingWhatsapp}
              className="gap-2"
            >
              <Send className="w-4 h-4" />
              {sendingWhatsapp ? "Sending..." : "Send WhatsApp"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
