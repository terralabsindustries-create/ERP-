import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Check,
  ChevronDown,
  Download,
  Mail,
  MessageSquare,
  Printer,
  Edit,
  FileText,
  Calendar,
  User,
  Building,
  Phone,
  MapPin,
  Hash,
  IndianRupee,
  Package,
  Percent,
  Settings,
  AlertTriangle
} from "lucide-react";
import apiClient from "@/lib/apiClient";
import { printOutcomeMessage } from "@/lib/printPdf";
import { getTemplateBodyText, getTemplateVariableNumbers } from "@/lib/whatsappTemplates";
import { useToast } from "@/hooks/use-toast";
import { EditInvoiceDialog } from "./EditInvoiceDialog";
import { useNavigate } from "react-router-dom";
import { AREA_UNITS, areaText, gstByRate, isAreaUnit, sizeLabel } from "@/lib/billing";
import { fmtDate, formatINR } from "@/lib/format";
import { METHOD_LABELS, type PaymentRecord } from "@/components/payments/paymentMeta";

interface InvoiceItem {
  itemName: string;
  description?: string;
  hsnCode?: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  totalAmount: number;
  itemType?: string;
  length?: number;
  width?: number;
  areaPerPiece?: number;
  totalSquareFeet?: number;
  taxableValue?: number;
  gstRate?: number;
  gstAmount?: number;
  cgstAmount?: number;
  sgstAmount?: number;
  igstAmount?: number;
}

interface Invoice {
  _id?: string;
  id: string;
  invoiceNumber: string;
  customerId: {
    _id: string;
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    gstNumber?: string;
  };
  jobId?: {
    _id: string;
    title: string;
  };
  invoiceDate: string;
  dueDate: string;
  items: InvoiceItem[];
  subtotal: number;
  designCharge?: number;
  designChargeGstRate?: number;
  designChargeTaxableValue?: number;
  designChargeCgstAmount?: number;
  designChargeSgstAmount?: number;
  designChargeIgstAmount?: number;
  discountAmount: number;
  taxableAmount?: number;
  totalGstAmount: number;
  totalAmount: number;
  isInterState?: boolean;
  amountPaid: number;
  balanceDue: number;
  paidAmount?: number;
  balanceAmount?: number;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled' | 'refunded';
  paymentStatus: 'pending' | 'partial' | 'paid' | 'overdue';
  noGst?: boolean;
  notes?: string;
  termsAndConditions?: string;
  createdAt: string;
  updatedAt: string;
}

export type InvoiceSendChannel = "email" | "whatsapp";

interface ViewInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: Invoice | null;
  onInvoiceUpdated: () => void;
  /** Opened from a list's "Send" action: go straight to that channel's form. */
  sendVia?: InvoiceSendChannel | null;
}

export function ViewInvoiceDialog({ open, onOpenChange, invoice: listedInvoice, onInvoiceUpdated, sendVia }: ViewInvoiceDialogProps) {
  const [details, setDetails] = useState<{ key: string; invoice: Invoice; paymentHistory: PaymentRecord[] } | null>(null);
  const [detailsError, setDetailsError] = useState("");
  const invoiceKey = listedInvoice?._id || listedInvoice?.id;
  // With no invoice open, invoiceKey and details?.key are both undefined.
  const invoice = details && details.key === invoiceKey ? details.invoice : null;
  const paymentHistory = details && details.key === invoiceKey ? details.paymentHistory : [];
  const [loading, setLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [showWhatsAppDialog, setShowWhatsAppDialog] = useState(false);
  const [showCompanySettingsDialog, setShowCompanySettingsDialog] = useState(false);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [metaIntegrationEnabled, setMetaIntegrationEnabled] = useState(false);
  const [metaTemplates, setMetaTemplates] = useState<any[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [templateMapping, setTemplateMapping] = useState<Record<string, string>>({});
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    if (!open || !invoiceKey) return;
    let cancelled = false;
    setDetailsError("");
    apiClient.getInvoice(invoiceKey).then((response: { invoice: Invoice; paymentHistory?: PaymentRecord[] }) => {
      if (!cancelled) setDetails({ key: invoiceKey, invoice: response.invoice, paymentHistory: response.paymentHistory || [] });
    }).catch((error: Error) => {
      if (!cancelled) setDetailsError(error.message || "Invoice details could not be loaded");
    });
    return () => { cancelled = true; };
  }, [open, invoiceKey]);

  useEffect(() => {
    if (!showWhatsAppDialog) return;
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
  }, [showWhatsAppDialog]);

  const startSend = (channel: InvoiceSendChannel) => {
    if (!invoice) return;
    if (channel === "email") {
      setEmail(invoice.customerId?.email || "");
      setShowEmailDialog(true);
    } else {
      setPhone(invoice.customerId?.phone || "");
      setSelectedTemplate("");
      setTemplateMapping({});
      setShowWhatsAppDialog(true);
    }
  };

  useEffect(() => {
    if (open && invoiceKey && sendVia) startSend(sendVia);
    // Only when the dialog opens on an invoice with a channel asked for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoiceKey, sendVia, details]);

  if (!listedInvoice) return null;
  if (!invoice) return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Invoice details</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{detailsError || "Loading invoice details…"}</p>
      </DialogContent>
    </Dialog>
  );

  // The invoice PDF could not be made: either the business has no company
  // details yet (send them to Settings), or something else went wrong.
  const pdfFailed = (error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("Company details not configured")) {
      setShowCompanySettingsDialog(true);
    } else {
      toast({ title: "Error", description: message || fallback, variant: "destructive" });
    }
  };

  // Prints the same PDF that Download saves (see lib/printPdf).
  const handlePrint = async () => {
    setPrinting(true);
    try {
      const note = printOutcomeMessage(await apiClient.printInvoicePDF(invoice._id || invoice.id), invoice.invoiceNumber);
      if (note) toast(note);
    } catch (error) {
      pdfFailed(error, "Failed to prepare the invoice for printing");
    } finally {
      setPrinting(false);
    }
  };

  const handleDownloadPDF = async () => {
    try {
      setLoading(true);
      const invoiceId = invoice._id || invoice.id;
      await apiClient.downloadInvoicePDF(invoiceId);
      toast({
        title: "Success",
        description: "Invoice PDF downloaded successfully",
      });
    } catch (error) {
      pdfFailed(error, "Failed to download invoice PDF");
    } finally {
      setLoading(false);
    }
  };

  const handleSendEmail = async () => {
    if (!email) {
      toast({
        title: "Error",
        description: "Please enter an email address",
        variant: "destructive",
      });
      return;
    }

    try {
      setLoading(true);
      const invoiceId = invoice._id || invoice.id;
      await apiClient.sendInvoiceEmail(invoiceId, email, message);
      toast({
        title: "Success",
        description: "Invoice sent via email successfully",
      });
      setShowEmailDialog(false);
      setEmail("");
      setMessage("");
    } catch (error: any) {
      console.error('Error sending email:', error);
      // Check if error is about company settings not configured
      if (error.message?.includes('Company details not configured')) {
        setShowCompanySettingsDialog(true);
      } else {
        toast({
          title: "Error",
          description: error.message || "Failed to send invoice via email",
          variant: "destructive",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSendWhatsApp = async () => {
    if (!phone) {
      toast({
        title: "Error",
        description: "Please enter a phone number",
        variant: "destructive",
      });
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
      toast({
        title: "Error",
        description: "Please choose an approved WhatsApp template",
        variant: "destructive",
      });
      return;
    }

    try {
      setLoading(true);
      const invoiceId = invoice._id || invoice.id;
      await apiClient.sendInvoiceWhatsApp(invoiceId, phone, selectedTemplate, templateMapping);
      toast({
        title: "Success",
        description: "Invoice sent via WhatsApp successfully",
      });
      setShowWhatsAppDialog(false);
      setPhone("");
      setSelectedTemplate("");
      setTemplateMapping({});
    } catch (error: any) {
      console.error('Error sending WhatsApp:', error);
      if (error.message?.includes('Company details not configured')) {
        setShowCompanySettingsDialog(true);
      } else if (error.code === 'WHATSAPP_NOT_CONFIGURED') {
        setMetaIntegrationEnabled(false);
        toast({
          title: "Error",
          description: error.message || "WhatsApp Business API is not configured",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Error",
          description: error.message || "Failed to send invoice via WhatsApp",
          variant: "destructive",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = () => {
    setShowEditDialog(true);
    onOpenChange(false);
  };

  const handleEditDialogClose = (open: boolean) => {
    setShowEditDialog(open);
    if (!open) {
      onOpenChange(true);
      onInvoiceUpdated();
    }
  };

  const getPaymentStatusConfig = (status: string) => {
    const configs = {
      "pending": { variant: "secondary" as const, label: "Unpaid" },
      "partial": { variant: "warning" as const, label: "Partially Paid" },
      "paid": { variant: "success" as const, label: "Paid" },
      "overdue": { variant: "destructive" as const, label: "Overdue" },
    };
    return configs[status as keyof typeof configs] || configs["pending"];
  };

  const paidAmount = invoice.paidAmount ?? invoice.amountPaid ?? 0;
  const balanceAmount = invoice.balanceAmount ?? Math.max(0, invoice.totalAmount - paidAmount);
  // A payment can be split across invoices: count only the part applied here.
  const appliedOf = (payment: PaymentRecord) => payment.appliedAmount ?? payment.amount;
  const recordedAmount = paymentHistory.filter((payment) => payment.status === "completed").reduce((sum, payment) => sum + appliedOf(payment), 0);
  const paymentStatusConfig = getPaymentStatusConfig(balanceAmount <= 0 ? "paid" : paidAmount > 0 ? "partial" : "pending");

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="text-2xl flex items-center gap-2">
                  <FileText className="h-6 w-6" />
                  <span className="font-mono font-semibold tracking-normal text-primary">{invoice.invoiceNumber}</span>
                </DialogTitle>
                <DialogDescription>
                  Invoice details and information
                </DialogDescription>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={paymentStatusConfig.variant}>
                  {paymentStatusConfig.label}
                </Badge>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-6">
            {/* Customer Information */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Building className="h-5 w-5" />
                  Customer Information
                </CardTitle>
              </CardHeader>
              <CardContent className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="font-semibold">{invoice.customerId.name}</span>
                  </div>
                  {invoice.customerId.email && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Mail className="h-4 w-4" />
                      <span>{invoice.customerId.email}</span>
                    </div>
                  )}
                  {invoice.customerId.phone && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Phone className="h-4 w-4" />
                      <span>{invoice.customerId.phone}</span>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  {invoice.customerId.address && (
                    <div className="flex items-start gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-4 w-4 mt-0.5" />
                      <span>{invoice.customerId.address}</span>
                    </div>
                  )}
                  {invoice.customerId.gstNumber && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Hash className="h-4 w-4" />
                      <span>GST: {invoice.customerId.gstNumber}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Invoice Details */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Calendar className="h-5 w-5" />
                  Invoice Details
                </CardTitle>
              </CardHeader>
              <CardContent className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Invoice Date:</span>
                    <span className="font-semibold">{new Date(invoice.invoiceDate).toLocaleDateString()}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Due Date:</span>
                    <span className="font-semibold">{new Date(invoice.dueDate).toLocaleDateString()}</span>
                  </div>
                  {invoice.jobId && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Job:</span>
                      <span className="font-semibold">{invoice.jobId.title}</span>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Created:</span>
                    <span className="font-semibold">{new Date(invoice.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Invoice Items */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Package className="h-5 w-5" />
                  Items ({invoice.items.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {invoice.items.map((item, index) => {
                    // Older area lines may say "pieces"; they were priced per sq ft.
                    const isArea = item.itemType === 'Square Feet';
                    const unit = isArea && !isAreaUnit(item.unit) ? 'sqft' : item.unit;
                    const size = sizeLabel({ unit, length: item.length, width: item.width });
                    const perPiece = item.areaPerPiece || (size ? (item.length || 0) * (item.width || 0) : 0);
                    return (
                      <div key={index} className="border rounded-lg p-4 space-y-2">
                        <div className="flex justify-between items-start">
                          <div>
                            <h4 className="font-semibold">{item.itemName}</h4>
                            {item.description && (
                              <p className="text-sm text-muted-foreground">{item.description}</p>
                            )}
                            {(item.hsnCode || (!invoice.noGst && (item.gstRate || 0) > 0)) && (
                              <p className="text-xs text-muted-foreground">
                                {item.hsnCode && <span className="font-mono">HSN {item.hsnCode}</span>}
                                {item.hsnCode && !invoice.noGst && (item.gstRate || 0) > 0 && " · "}
                                {!invoice.noGst && (item.gstRate || 0) > 0 && `GST ${item.gstRate}%`}
                              </p>
                            )}
                          </div>
                          <span className="font-semibold">{formatINR(item.totalAmount || 0)}</span>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm text-muted-foreground">
                          {size && <div>Size: {size} ({areaText(perPiece, unit)} each)</div>}
                          {isArea && <div>Area: {areaText(item.totalSquareFeet || 0, unit)}</div>}
                          <div>Qty: {item.quantity}{!isArea && item.unit && item.unit !== 'pieces' ? ` ${item.unit}` : ''}</div>
                          <div>
                            Rate: {formatINR(item.unitPrice || 0)}
                            {isArea && isAreaUnit(unit) ? ` / ${AREA_UNITS[unit].label}` : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Payment Summary */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <IndianRupee className="h-5 w-5" />
                  Payment Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Items subtotal:</span>
                  <span>{formatINR(invoice.subtotal || 0)}</span>
                </div>
                {(invoice.designCharge || 0) > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Design charge:</span>
                    <span>{formatINR(invoice.designCharge || 0)}</span>
                  </div>
                )}
                {invoice.discountAmount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Discount:</span>
                    <span className="text-destructive-strong">-{formatINR(invoice.discountAmount)}</span>
                  </div>
                )}
                {(() => {
                  // The tax stored on each line and on the design charge, by rate.
                  const rates = invoice.noGst
                    ? []
                    : gstByRate([
                        ...invoice.items.map((i) => ({ ...i, taxableValue: i.taxableValue ?? i.totalAmount })),
                        {
                          gstRate: invoice.designChargeGstRate,
                          taxableValue: invoice.designChargeTaxableValue,
                          cgstAmount: invoice.designChargeCgstAmount,
                          sgstAmount: invoice.designChargeSgstAmount,
                          igstAmount: invoice.designChargeIgstAmount
                        }
                      ]);
                  if (!rates.length) return null;
                  return (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Taxable amount:</span>
                        <span>{formatINR(invoice.taxableAmount ?? 0)}</span>
                      </div>
                      {rates.map((r) => (
                        <div key={r.rate} className="space-y-1">
                          {r.cgst + r.sgst > 0 && (
                            <>
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">CGST @ {r.rate / 2}%:</span>
                                <span>{formatINR(r.cgst)}</span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">SGST @ {r.rate / 2}%:</span>
                                <span>{formatINR(r.sgst)}</span>
                              </div>
                            </>
                          )}
                          {r.igst > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">IGST @ {r.rate}%:</span>
                              <span>{formatINR(r.igst)}</span>
                            </div>
                          )}
                        </div>
                      ))}
                      {rates.length > 1 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Total GST:</span>
                          <span>{formatINR(invoice.totalGstAmount || 0)}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
                <div className="border-t border-dashed border-input pt-2 flex justify-between font-semibold">
                  <span>Invoice Total{invoice.totalGstAmount > 0 ? " (incl. GST)" : ""}:</span>
                  <span className="font-mono text-lg text-primary">{formatINR(invoice.totalAmount || 0)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Amount Received:</span>
                  <span className="text-success-strong">{formatINR(paidAmount)}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>Remaining Balance:</span>
                  <span className={balanceAmount > 0 ? "text-warning-strong" : "text-success-strong"}>{formatINR(balanceAmount)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Payment Status:</span>
                  <Badge variant={paymentStatusConfig.variant}>{paymentStatusConfig.label}</Badge>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-lg">Payment History</CardTitle></CardHeader>
              <CardContent>
                {paymentHistory.length ? (
                  <ul className="divide-y">
                    {paymentHistory.map((payment) => (
                      <li key={payment._id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="font-medium">{fmtDate(payment.paymentDate)} · {METHOD_LABELS[payment.paymentMethod] || payment.paymentMethod}</div>
                          <div className="text-xs text-muted-foreground">
                            Reference: {payment.referenceNumber || "—"}
                            {appliedOf(payment) < payment.amount - 0.005 && ` · part of a ${formatINR(payment.amount)} payment`}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 sm:justify-end">
                          <span className="font-semibold tabular-nums">{formatINR(appliedOf(payment))}</span>
                          {payment.status !== "completed" && <Badge variant="secondary">{payment.status}</Badge>}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">No payments allocated to this invoice yet.</p>}
                {paidAmount > recordedAmount + 0.01 && (
                  <p className="mt-3 text-xs text-muted-foreground">Amount received also includes {formatINR(paidAmount - recordedAmount)} recorded directly on the invoice (outside payments).</p>
                )}
              </CardContent>
            </Card>

            {/* Notes and Terms */}
            {(invoice.notes || invoice.termsAndConditions) && (
              <Card>
                <CardContent className="pt-6 space-y-4">
                  {invoice.notes && (
                    <div>
                      <h4 className="font-semibold mb-2">Notes:</h4>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">{invoice.notes}</p>
                    </div>
                  )}
                  {invoice.termsAndConditions && (
                    <div>
                      <h4 className="font-semibold mb-2">Terms and Conditions:</h4>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">{invoice.termsAndConditions}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <div className="flex flex-1 flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={handlePrint}
                disabled={loading || printing}
                className="gap-2"
              >
                <Printer className="h-4 w-4" />
                {printing ? "Preparing…" : "Print"}
              </Button>
              <Button
                variant="outline"
                onClick={handleDownloadPDF}
                disabled={loading || printing}
                className="gap-2"
              >
                <Download className="h-4 w-4" />
                Download PDF
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" disabled={loading || printing} className="gap-2">
                    <Mail className="h-4 w-4" />
                    Send
                    <ChevronDown className="h-4 w-4 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => startSend("email")}>
                    <Mail className="h-4 w-4" />
                    By email
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => startSend("whatsapp")}>
                    <MessageSquare className="h-4 w-4" />
                    On WhatsApp
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex gap-2">
              {/* Closes the preview the same way as the X: the page underneath
                  is where the user came from. Nothing is saved, sent or
                  changed. Held while a PDF is being made, so a print dialog or
                  download does not appear after the preview has gone. */}
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={loading || printing}
                className="gap-2"
              >
                <Check className="h-4 w-4" />
                Finished
              </Button>
              <Button
                variant="default"
                onClick={handleEdit}
                className="gap-2"
              >
                <Edit className="h-4 w-4" />
                Edit Invoice
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email Dialog */}
      <Dialog open={showEmailDialog} onOpenChange={setShowEmailDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Invoice via Email</DialogTitle>
            <DialogDescription>
              Send this invoice to the customer via email
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="customer@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="emailMessage">Message (Optional)</Label>
              <Textarea
                id="emailMessage"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Add a personal message..."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEmailDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSendEmail} disabled={loading}>
              {loading ? "Sending..." : "Send Email"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* WhatsApp Dialog */}
      <Dialog open={showWhatsAppDialog} onOpenChange={setShowWhatsAppDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Invoice via WhatsApp</DialogTitle>
            <DialogDescription>
              Send this invoice to the customer via WhatsApp
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number</Label>
              <Input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1234567890"
              />
            </div>
            {!loadingTemplates && !metaIntegrationEnabled && (
              <div className="text-sm text-warning-strong bg-warning-soft border border-warning/30 rounded p-3">
                WhatsApp Business API isn't connected yet. Go to Settings → WhatsApp to connect it before sending invoices.
              </div>
            )}

            {metaIntegrationEnabled && (
              <div className="space-y-2">
                <Label htmlFor="whatsappTemplate">WhatsApp Template</Label>
                <Select
                  value={selectedTemplate}
                  onValueChange={(value) => {
                    setSelectedTemplate(value);
                    setTemplateMapping({});
                  }}
                >
                  <SelectTrigger id="whatsappTemplate">
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
                              <SelectItem value="invoiceNumber">Invoice Number</SelectItem>
                              <SelectItem value="totalAmount">Total Amount</SelectItem>
                              <SelectItem value="balanceDue">Balance Due</SelectItem>
                              <SelectItem value="invoiceDate">Invoice Date</SelectItem>
                              <SelectItem value="dueDate">Due Date</SelectItem>
                              <SelectItem value="businessName">Business Name</SelectItem>
                              <SelectItem value="invoiceLink">Invoice Link (PDF)</SelectItem>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowWhatsAppDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSendWhatsApp} disabled={loading}>
              {loading ? "Sending..." : "Send WhatsApp"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Company Settings Required Dialog */}
      <Dialog open={showCompanySettingsDialog} onOpenChange={setShowCompanySettingsDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-warning-strong">
              <AlertTriangle className="h-5 w-5" />
              Company Settings Required
            </DialogTitle>
            <DialogDescription>
              You need to configure your company details before you can generate invoices.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="bg-warning-soft border border-warning/30 rounded-lg p-4">
              <p className="text-sm text-warning-strong">
                Please go to <strong>Settings &gt; Company</strong> and add your company information including:
              </p>
              <ul className="text-sm text-warning-strong mt-2 ml-4 list-disc">
                <li>Company Name</li>
                <li>Company Address</li>
                <li>Phone Number</li>
                <li>Email</li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCompanySettingsDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={() => {
                setShowCompanySettingsDialog(false);
                navigate('/settings');
              }}
              className="gap-2"
            >
              <Settings className="h-4 w-4" />
              Go to Settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Invoice Dialog */}
      <EditInvoiceDialog
        open={showEditDialog}
        onOpenChange={handleEditDialogClose}
        invoice={invoice as unknown as React.ComponentProps<typeof EditInvoiceDialog>["invoice"]}
        onInvoiceUpdated={onInvoiceUpdated}
      />
    </>
  );
}
