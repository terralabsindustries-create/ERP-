import { useState, useEffect, useRef } from "react";
import { STAGES } from "@/lib/printWorkflow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_SUGGESTIONS, SuggestionPopover } from "@/components/ui/suggestion-popover";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { unitPriceForTotal } from "@/lib/lineTotal";
import { EditableLineTotal } from "./EditableLineTotal";
import { normalizePriority } from "@/lib/priority";
import apiClient from "@/lib/apiClient";
import { Plus, Trash2 } from "lucide-react";
import { JobInvoiceDialog } from "./JobInvoiceDialog";
import { InvoiceSavedDialog } from "../invoices/InvoiceSavedDialog";
import { UNITS_OF_MEASUREMENT } from "../inventory/CreateItemDialog";
import { CustomerTypePicker } from "../customers/CustomerTypePicker";
import { CustomerSearch, customerIdOf } from "../customers/CustomerSearch";
import { StockAvailability, StockCheckList } from "../billing/StockAvailability";
import { qtyText, sellingRate, stockItemNamed, stockNeeded, unitText, type StockItem } from "../billing/stock";
import { HSN_PATTERN, draftTotals, jobItemPieces, lineDraftFromJobItem } from "../billing/lineDraft";
import { localDate } from "@/lib/format";
import { priceLine } from "@/lib/billing";
import { paperStock, withPaperLine } from "@/lib/paperStock";

const AREA_UNITS = ['sqft', 'sqm'];

/**
 * An item's area and total, priced as its invoice will be (lib/billing.ts,
 * the same as the server). An area item is length × width per piece, times
 * the number of pieces (its quantity), times the rate per sq ft / sq m:
 *   6 ft × 4 ft = 24 sq ft a piece; 2 pieces = 48 sq ft; @ ₹12 = ₹576.
 * Anything else is quantity × unit price. itemTotal includes the item's GST.
 */
function priceJobItem(item: InvoiceItem): InvoiceItem {
  const gst = (amount: number) => amount + (amount * (Number(item.gstRate) || 0)) / 100;
  if (item.itemType === 'Square Feet') {
    const p = priceLine({ quantity: item.quantity || 0, unitPrice: item.unitPrice, unit: item.unit === 'sqm' ? 'sqm' : 'sqft', length: item.length, width: item.width });
    return p.isArea ? { ...item, totalSquareFeet: p.totalArea, itemTotal: gst(p.amount) } : { ...item, totalSquareFeet: 0, itemTotal: 0 };
  }
  return { ...item, itemTotal: gst(priceLine({ quantity: item.quantity, unitPrice: item.unitPrice }).amount) };
}
// Square-foot dimensions are stored in feet throughout jobs, billing and stock.
// Inches are an input/display choice, converted at the form boundary.
const shownDimension = (feet: number | undefined, unit: 'ft' | 'in') =>
  feet ? Math.round(feet * (unit === 'in' ? 12 : 1) * 10000) / 10000 : '';
const storedDimension = (value: string, unit: 'ft' | 'in') => {
  const number = Number(value);
  return value !== '' && Number.isFinite(number) && number > 0
    ? number / (unit === 'in' ? 12 : 1)
    : undefined;
};

const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What picking the paper did: the rate × sheets line it added, or why it added none. */
function PaperHint({ paperType, paper, line, hasPaperStock }: {
  paperType: string;
  paper?: StockItem;
  line?: { quantity: number; unitPrice: number; gstRate: number };
  hasPaperStock: boolean;
}) {
  let text: React.ReactNode = null;
  if (paper && line && line.quantity > 0) {
    const unit = unitText(paper.unit) || "unit";
    const amount = line.quantity * (Number(line.unitPrice) || 0);
    text = Number(line.unitPrice) > 0
      ? <>{qtyText(line.quantity)} {unit} × {money(Number(line.unitPrice))} per {unit} = <span className="font-medium text-foreground">{money(amount)}</span>{line.gstRate ? ` + ${line.gstRate}% GST` : ""} · added to Inventory Items below; the invoice takes it out of stock.</>
      : <>This paper has no selling price yet. Enter the rate on its line under Inventory Items, or set a selling price on the stock item.</>;
  } else if (paper) {
    text = <>Enter the {unitText(paper.unit) || "quantity"} used to add {paper.name} at {money(sellingRate(paper))} per {unitText(paper.unit) || "unit"}. {qtyText(paper.quantity || 0)} in stock.</>;
  } else if (paperType.trim() && hasPaperStock) {
    text = <>Not a stock item: the rate is not filled in and no stock is taken. Pick a paper from the list to price it per sheet.</>;
  }
  if (!text) return null;
  return <p id="specPaperHint" className="mt-2 text-xs text-muted-foreground" aria-live="polite">{text}</p>;
}

interface CreateJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJobCreated: () => void;
  customers?: any[];
  onCustomersUpdate?: () => void;
  preselectedCustomer?: any;
  /** A full job (from GET /jobs/:id) to edit instead of creating a new one. */
  editingJob?: any;
  /** Set when the job is billed or finished: only title, priority, date and notes are saved. */
  editLockedReason?: string;
  onJobUpdated?: () => void;
}

interface InvoiceItem {
  itemName: string;
  /** A note for this item; it becomes the line's description on the invoice. */
  description?: string;
  quantity: number;
  unitPrice: number;
  hsnCode?: string;
  gstRate: number;
  itemTotal: number;
  itemType?: 'Numbers' | 'Square Feet';
  unit?: string; // unit from inventory (pieces, boxes, sqft, sqm, etc.)
  length?: number;
  width?: number;
  totalSquareFeet?: number;
  dimensionUnit?: 'ft' | 'in';
  lengthInput?: string;
  widthInput?: string;
  /** The line for the paper picked in the print specification (not saved). */
  fromPaper?: boolean;
}

// Saved on the job as `printSpecs` (backend/src/models/Job.js)
const EMPTY_PRINT_SPECS = {
  quantity: "",
  printSize: "",
  paperType: "",
  /** Sheets of the paper, when it is a stock item (adds the paper line to the items) */
  sheets: "",
  colorType: "color",
  lamination: "",
  binding: "",
};

const PAPER_SUGGESTIONS = [
  "Maplitho 70 GSM",
  "Maplitho 90 GSM",
  "Art Paper 130 GSM",
  "Art Paper 170 GSM",
  "Art Card 250 GSM",
  "Art Card 300 GSM",
  "Art Card 350 GSM",
  "Chromo Paper (sticker)",
  "NCR 2-ply",
  "NCR 3-ply",
  "Kraft 120 GSM",
  "Duplex Board 300 GSM",
  "Flex 10 oz",
  "Vinyl (self-adhesive)",
];

interface DesignCharge {
  amount: number;
  sacCode?: string;
  gstRate: number;
  totalAmount: number;
}

export function CreateJobDialog({
  open,
  onOpenChange,
  onJobCreated,
  customers = [],
  preselectedCustomer,
  onCustomersUpdate,
  editingJob,
  editLockedReason,
  onJobUpdated
}: CreateJobDialogProps) {
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    customerId: preselectedCustomer?.id || "",
    priority: "medium" as 'low' | 'medium' | 'high',
    status: "inquiry" as 'inquiry' | 'quotation_sent' | 'quotation_approved' | 'design_in_progress' | 'design_approved' | 'production_ready' | 'ready_for_print' | 'quality_check' | 'completed' | 'delivered' | 'cancelled',
    estimatedCost: "",
    dueDate: "",
    notes: "",
    items: [] as InvoiceItem[],
    designCharge: null as DesignCharge | null,
    printSpecs: { ...EMPTY_PRINT_SPECS }
  });

  const [loading, setLoading] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<any>(preselectedCustomer || null);
  const [showAddCustomerForm, setShowAddCustomerForm] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState<{ [key: number]: boolean }>({});
  const [tableView, setTableView] = useState(false);
  const [inventoryItems, setInventoryItems] = useState<(StockItem & { gstRate?: number; category?: string })[]>([]);
  const [hsnCodes, setHsnCodes] = useState<any[]>([]);
  const [sacCodes, setSacCodes] = useState<any[]>([]);
  const [newCustomerData, setNewCustomerData] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    customerType: "Walk-in"
  });
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [showInvoiceQuestion, setShowInvoiceQuestion] = useState(false);
  const [showInvoiceCreation, setShowInvoiceCreation] = useState(false);
  const [createdJobId, setCreatedJobId] = useState<string | null>(null);
  const [createdJob, setCreatedJob] = useState<any>(null);
  const [createdInvoice, setCreatedInvoice] = useState<any>(null);
  const [showInvoiceView, setShowInvoiceView] = useState(false);
  const [isGeneratingInvoice, setIsGeneratingInvoice] = useState(false);
  const generatingInvoice = useRef(false);
  const invoiceTriggerRef = useRef<HTMLButtonElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  // Set the moment a create starts, before React re-renders the button as
  // disabled, so a second Enter can never send a second job.
  const submittingRef = useRef(false);
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      fetchInventoryItems();
      fetchHsnCodes();
      fetchSacCodes();
    }
  }, [open]);

  const fetchInventoryItems = async () => {
    try {
      const response = await apiClient.getInventory();
      const inventoryData = Array.isArray(response) ? response : ((response as { inventory?: StockItem[] })?.inventory || []);
      setInventoryItems(inventoryData);
    } catch (error) {
      console.error('Error fetching inventory items:', error);
    }
  };

  const fetchHsnCodes = async () => {
    try {
      setHsnCodes(await apiClient.listAll('/hsn-codes', 'hsnCodes'));
    } catch (error) {
      console.error('Error fetching HSN codes:', error);
    }
  };

  const fetchSacCodes = async () => {
    try {
      setSacCodes(await apiClient.listAll('/sac-codes', 'sacCodes'));
    } catch (error) {
      console.error('Error fetching SAC codes:', error);
    }
  };

  // Editing: load the saved job into the form each time the dialog opens on one.
  useEffect(() => {
    if (!open || !editingJob) return;
    const job = editingJob;
    const customer = typeof job.customerId === 'object' && job.customerId ? job.customerId : null;
    if (customer) setSelectedCustomer({ ...customer, id: customer._id || customer.id });
    const paperName = job.printSpecs?.sheets > 0 ? job.printSpecs?.paperType : undefined;
    setFormData({
      title: job.title || "",
      description: job.description || "",
      customerId: String(customer?._id || customer?.id || job.customerId || ""),
      priority: normalizePriority(job.priority) as 'low' | 'medium' | 'high',
      status: job.status || "inquiry",
      estimatedCost: job.estimatedCost ? String(job.estimatedCost) : "",
      dueDate: job.dueDate ? String(job.dueDate).slice(0, 10) : "",
      notes: job.notes || "",
      items: (job.items || []).map((it: InvoiceItem, idx: number) => ({
        ...it,
        dimensionUnit: 'ft' as const,
        lengthInput: it.length ? String(it.length) : '',
        widthInput: it.width ? String(it.width) : '',
        fromPaper: !!paperName && it.itemName === paperName && (job.items || []).findIndex((x: InvoiceItem) => x.itemName === paperName) === idx
      })),
      designCharge: job.designCharge && job.designCharge.amount > 0 ? job.designCharge : null,
      printSpecs: {
        ...EMPTY_PRINT_SPECS,
        ...(job.printSpecs || {}),
        quantity: job.printSpecs?.quantity ? String(job.printSpecs.quantity) : "",
        sheets: job.printSpecs?.sheets ? String(job.printSpecs.sheets) : "",
      }
    });
  }, [open, editingJob]);

  // Update selected customer when preselectedCustomer changes
  useEffect(() => {
    if (preselectedCustomer) {
      setSelectedCustomer(preselectedCustomer);
      setFormData(prev => ({
        ...prev,
        customerId: preselectedCustomer.id || ""
      }));
    }
  }, [preselectedCustomer]);

  // Invoice Items Functions
  const blankItem = (): InvoiceItem => ({
    itemName: '',
    description: '',
    quantity: 1,
    unitPrice: '' as any,
    hsnCode: '',
    gstRate: 18,
    itemTotal: 0,
    itemType: 'Numbers',
    unit: 'pieces',
    length: undefined,
    width: undefined,
    totalSquareFeet: 0,
    dimensionUnit: 'ft'
  });

  const addItem = () => {
    setFormData(prev => ({ ...prev, items: [...prev.items, blankItem()] }));
  };

  const removeItem = (index: number) => {
    setFormData(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index),
      // Removing the paper line takes its sheets off the print specification too.
      printSpecs: prev.items[index]?.fromPaper ? { ...prev.printSpecs, sheets: "" } : prev.printSpecs
    }));
    setShowSuggestions(prev => {
      const newState = { ...prev };
      delete newState[index];
      return newState;
    });
  };

  const updateItem = (index: number, field: keyof InvoiceItem, value: any) => {
    setFormData(prev => {
      const newItems = [...prev.items];
      const wasPaper = newItems[index]?.fromPaper;
      newItems[index] = { ...newItems[index], [field]: value };
      // Renaming the paper line makes it an ordinary line.
      if (wasPaper && field === 'itemName') newItems[index].fromPaper = false;

      newItems[index] = priceJobItem(newItems[index]);

      // The paper line's quantity is the print specification's sheets.
      const printSpecs = wasPaper && field === 'quantity'
        ? { ...prev.printSpecs, sheets: value ? String(value) : "" }
        : wasPaper && field === 'itemName' ? { ...prev.printSpecs, sheets: "" } : prev.printSpecs;

      return { ...prev, items: newItems, printSpecs };
    });
  };

  // Typing a line's total (incl. GST) sets the unit price that gives it.
  const setItemTotal = (index: number, total: number) => {
    const item = formData.items[index];
    if (!item) return;
    const isArea = item.itemType === 'Square Feet';
    const solved = unitPriceForTotal({ total, gstRate: Number(item.gstRate) || 0, quantity: item.quantity, unit: isArea ? item.unit : undefined, length: item.length, width: item.width });
    if (!solved) {
      toast({ title: "Total not applied", description: total > 0 ? (isArea ? "Enter the length, width and pieces first." : "Enter the quantity first.") : "The total must be more than ₹0.", variant: "destructive" });
      return;
    }
    updateItem(index, 'unitPrice', solved.unitPrice);
    if (!solved.exact) {
      toast({ title: `Closest total is ₹${solved.total.toFixed(2)}`, description: `₹${total.toFixed(2)} can't be reached exactly with this quantity and GST, so the unit price is ₹${solved.unitPrice}.` });
    }
  };

  // Switching between a count unit and an area unit changes which fields the
  // row needs (Qty vs Length × Width), so itemType follows the unit.
  const changeItemUnit = (index: number, unit: string) => {
    const isAreaUnit = AREA_UNITS.includes(unit);

    updateItem(index, 'unit', unit);
    updateItem(index, 'itemType', isAreaUnit ? 'Square Feet' : 'Numbers');
    if (unit !== formData.items[index].unit) changeDimensionUnit(index, 'ft');
    // A count item needs a quantity, an area item a number of pieces: 1 unless one was entered.
    if (!formData.items[index].quantity) {
      updateItem(index, 'quantity', 1);
    }
  };

  const changeDimensionUnit = (index: number, unit: 'ft' | 'in') => {
    updateItem(index, 'dimensionUnit', unit);
    updateItem(index, 'lengthInput', undefined);
    updateItem(index, 'widthInput', undefined);
  };

  const updateDimension = (index: number, field: 'length' | 'width', value: string, unit: 'ft' | 'in') => {
    updateItem(index, field, storedDimension(value, unit));
    updateItem(index, field === 'length' ? 'lengthInput' : 'widthInput', value);
  };

  const selectInventoryItem = (index: number, invItem: StockItem & { gstRate?: number }) => {
    setFormData(prev => {
      const newItems = [...prev.items];
      const invUnit = invItem.unit || 'pieces';
      const isAreaUnit = AREA_UNITS.includes(invUnit);
      newItems[index] = priceJobItem({
        ...newItems[index],
        itemName: invItem.name,
        unitPrice: sellingRate(invItem),
        hsnCode: invItem.hsnCode || undefined,
        gstRate: invItem.gstRate || 18,
        unit: invUnit,
        itemType: isAreaUnit ? 'Square Feet' : 'Numbers',
        length: isAreaUnit ? newItems[index].length : undefined,
        width: isAreaUnit ? newItems[index].width : undefined,
        totalSquareFeet: isAreaUnit ? newItems[index].totalSquareFeet || 0 : 0,
        quantity: newItems[index].quantity || 1,
      });
      return { ...prev, items: newItems };
    });
  };

  const handleCustomerSelect = (customer: any) => {
    setSelectedCustomer(customer);
    setFormData(prev => ({
      ...prev,
      customerId: customerIdOf(customer)
    }));
  };

  const handleAddCustomer = async () => {
    if (!newCustomerData.name.trim()) {
      toast({
        title: "Invalid Input",
        description: "Please enter at least a customer name",
        variant: "destructive",
      });
      return;
    }

    setCreatingCustomer(true);
    try {
      // Another customer may already have this name; each one is its own record.
      const customerData = {
        name: newCustomerData.name.trim(),
        email: newCustomerData.email || undefined,
        phone: newCustomerData.phone || undefined,
        address: newCustomerData.address || undefined,
        customerType: newCustomerData.customerType,
      };

      const response = await apiClient.createCustomer(customerData);

      toast({
        title: newCustomerData.customerType === "Agency" ? "Agency added" : "Customer added",
        description: customerData.name,
      });

      const newCustomer = (response as { customer?: unknown })?.customer || response;

      setNewCustomerData({
        name: "",
        email: "",
        phone: "",
        address: "",
        customerType: "Walk-in"
      });
      setShowAddCustomerForm(false);

      if (onCustomersUpdate) {
        onCustomersUpdate();
      }

      handleCustomerSelect(newCustomer);

    } catch (error) {
      console.error('Error creating customer:', error);
      toast({
        title: "Customer not added",
        description: error instanceof Error ? error.message : "Failed to create customer",
        variant: "destructive",
      });
    } finally {
      setCreatingCustomer(false);
    }
  };

  // The job ticket's totals, worked out exactly as the invoice raised from it
  // will be (lib/billing.ts, the same as the server): each item before tax at
  // its GST rate and the design charge at its own, rounded to the paisa per
  // part. So the Grand Total here is the invoice total.
  const jobTotals = draftTotals(
    formData.items.map((item, i) => lineDraftFromJobItem(i, { ...item, gstRate: Number(item.gstRate) || 0 })),
    { amount: formData.designCharge?.amount || 0, gstRate: formData.designCharge?.gstRate || 0 }
  );
  const jobItemsGst = jobTotals.lines.reduce((sum, line) => sum + line.gstAmount, 0);

  const handleGenerateInvoiceDirectly = async () => {
    // One invoice per click: a second click while generating creates nothing.
    if (!createdJob || generatingInvoice.current) return;

    generatingInvoice.current = true;
    setIsGeneratingInvoice(true);
    try {
      // The server prices every line from its price before tax and the job
      // ticket's GST rate, and the design charge at its own rate, so the
      // invoice comes to the job ticket's total. An area item keeps its number
      // of pieces: length × width × pieces.
      const items = (createdJob.items || []).map((item: any) => ({
        itemName: item.itemName,
        description: item.description || '',
        hsnCode: item.hsnCode || '',
        itemType: item.itemType || 'Numbers',
        unit: item.unit || 'pieces',
        quantity: item.itemType === 'Square Feet' ? jobItemPieces(item) : item.quantity || 0,
        length: item.length || 0,
        width: item.width || 0,
        unitPrice: item.unitPrice,
        gstRate: item.gstRate ?? 0
      }));

      // Set invoice date to today and due date to 30 days from today
      const invoiceDate = localDate();
      const dueDate = localDate(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const invoiceData = {
        jobId: createdJob._id,
        customerId: createdJob.customerId,
        invoiceDate: invoiceDate,
        dueDate: dueDate,
        items: items,
        designCharge: createdJob.designCharge?.amount || 0,
        designChargeGstRate: createdJob.designCharge?.amount ? createdJob.designCharge.gstRate ?? 0 : 0,
        status: 'sent',
        paymentTerms: 'Immediate',
        notes: createdJob.notes || ''
      };

      const response = await apiClient.createInvoice(invoiceData);

      const created = response as { invoice?: { _id?: string; id?: string }; _id?: string; id?: string };
      const invoiceId = created?.invoice?._id || created?._id || created?.id;

      if (!invoiceId) {
        throw new Error('Invoice ID not received from server');
      }

      // Saved: close the question and offer Print / Download / Send.
      // Nothing is downloaded or printed until one is chosen.
      setCreatedInvoice({ ...(created?.invoice || created), _id: invoiceId });
      setShowInvoiceQuestion(false);
      setShowInvoiceCreation(false);
      setShowInvoiceView(true);

    } catch (error: any) {
      console.error('Error generating invoice:', error);
      if (error.stockCheck?.length > 0) {
        const lines = (error.details as string[]) || error.stockCheck.map((s: any) =>
          `"${s.itemName}": Available ${s.availableQuantity}, Required ${s.requiredQuantity} (${s.unit})`
        );
        toast({
          title: "Insufficient Stock",
          description: lines.join('\n'),
          variant: "destructive",
        });
      } else {
        toast({
          title: "Error",
          description: error.message || "Failed to generate invoice",
          variant: "destructive",
        });
      }
    } finally {
      generatingInvoice.current = false;
      setIsGeneratingInvoice(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;

    // Validate required fields
    if (!formData.title || !formData.title.trim()) {
      toast({
        title: "Validation Error",
        description: "Job title is required",
        variant: "destructive",
      });
      return;
    }

    if (!formData.customerId) {
      toast({
        title: "Validation Error",
        description: "Please select a customer",
        variant: "destructive",
      });
      return;
    }

    // Validate items if present
    if (formData.items && formData.items.length > 0) {
      for (let i = 0; i < formData.items.length; i++) {
        const item = formData.items[i];

        // Validate item name
        if (!item.itemName || !item.itemName.trim()) {
          toast({
            title: "Validation Error",
            description: `Item ${i + 1}: Item name is required`,
            variant: "destructive",
          });
          return;
        }

        // Validate based on item type
        if (item.itemType === 'Square Feet') {
          // Validate length and width for Square Feet items
          if (!item.length || item.length <= 0) {
            toast({
              title: "Validation Error",
              description: `Item ${i + 1}: Length is required for Square Feet items`,
              variant: "destructive",
            });
            return;
          }
          if (!item.width || item.width <= 0) {
            toast({
              title: "Validation Error",
              description: `Item ${i + 1}: Width is required for Square Feet items`,
              variant: "destructive",
            });
            return;
          }
          if (!Number.isInteger(Number(item.quantity)) || !(Number(item.quantity) >= 1)) {
            toast({
              title: "Validation Error",
              description: `Item ${i + 1}: the number of pieces must be a whole number, 1 or more`,
              variant: "destructive",
            });
            return;
          }
        } else {
          // Validate quantity for Numbers items
          if (!item.quantity || item.quantity <= 0) {
            toast({
              title: "Validation Error",
              description: `Item ${i + 1}: Quantity must be greater than 0`,
              variant: "destructive",
            });
            return;
          }
        }

        // A job item worth nothing is a mistake, not a free line.
        if (!(Number(item.unitPrice) > 0)) {
          toast({
            title: "Validation Error",
            description: `Item ${i + 1}: the price must be more than 0`,
            variant: "destructive",
          });
          return;
        }

        if (item.hsnCode && !HSN_PATTERN.test(item.hsnCode)) {
          toast({
            title: "Validation Error",
            description: `Item ${i + 1}: an HSN code is 4 to 8 digits`,
            variant: "destructive",
          });
          return;
        }

        // Validate GST Rate
        if (item.gstRate === undefined || item.gstRate === null || item.gstRate < 0 || item.gstRate > 100) {
          toast({
            title: "Validation Error",
            description: `Item ${i + 1}: GST Rate must be between 0 and 100`,
            variant: "destructive",
          });
          return;
        }
      }
    }

    // Validate design charge if present
    if (formData.designCharge) {
      if (!formData.designCharge.amount || formData.designCharge.amount <= 0) {
        toast({
          title: "Validation Error",
          description: "Design charge amount must be greater than 0",
          variant: "destructive",
        });
        return;
      }
    }

    submittingRef.current = true;
    setLoading(true);
    try {
      const jobData = {
        title: formData.title.trim(),
        description: formData.description.trim(),
        customerId: formData.customerId,
        priority: formData.priority,
        status: formData.status,
        estimatedCost: formData.estimatedCost ? parseFloat(formData.estimatedCost) : 0,
        dueDate: formData.dueDate || null,
        notes: formData.notes.trim(),
        // An area item's quantity is its number of pieces; its area and total
        // are length × width × pieces, priced again here so what is saved is
        // what the form showed.
        items: formData.items.map((item) => ({
          ...priceJobItem(item),
          dimensionUnit: undefined,
          lengthInput: undefined,
          widthInput: undefined,
          fromPaper: undefined,
          itemName: item.itemName.trim(),
          description: (item.description || '').trim()
        })),
        designCharge: formData.designCharge,
        printSpecs: {
          ...formData.printSpecs,
          quantity: Number(formData.printSpecs.quantity) || 1,
          // Sheets only mean something for a stock paper (its line carries them).
          sheets: formData.items.some((i) => i.fromPaper) ? Number(formData.printSpecs.sheets) : undefined,
        }
      };

      if (editingJob) {
        const id = editingJob._id || editingJob.id;
        // A billed or finished job keeps its billing fields; send only what can change.
        const payload = editLockedReason
          ? { title: jobData.title, description: jobData.description, customerId: jobData.customerId, priority: jobData.priority, dueDate: jobData.dueDate, notes: jobData.notes }
          : jobData;
        await apiClient.updateJob(id, payload);
        toast({ title: "Job updated", description: `${jobData.title} was saved` });
        onOpenChange(false);
        (onJobUpdated || onJobCreated)();
        return;
      }

      const response = await apiClient.createJob(jobData);

      toast({
        title: "Success",
        description: "Job has been created successfully",
      });

      // Store the created job and show invoice question dialog
      const createdJobData = (response as { job?: { _id?: string; id?: string } })?.job || (response as { _id?: string; id?: string });
      setCreatedJob(createdJobData);
      setCreatedJobId(createdJobData?._id || createdJobData?.id);
      setShowInvoiceQuestion(true);

      // Reset form
      setFormData({
        title: "",
        description: "",
        customerId: "",
        priority: "medium",
        status: "inquiry",
        estimatedCost: "",
        dueDate: "",
        notes: "",
        items: [],
        designCharge: null,
        printSpecs: { ...EMPTY_PRINT_SPECS }
      });
      setSelectedCustomer(null);
      setShowSuggestions({});
    } catch (error: any) {
      console.error('Error saving job:', error);
      const errorMessage = error?.message || (editingJob ? "Failed to update job" : "Failed to create job");
      const errorDetails = error?.errors?.join(", ") || errorMessage;

      toast({
        title: "Error",
        description: errorDetails,
        variant: "destructive",
      });
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  };

  // The browser only submits on Enter from a text box. Picking a customer from
  // the search results, or an option from a list, leaves focus on the dialog
  // itself, so Enter there did nothing. Enter on the dialog now presses Create
  // Job; fields, buttons and lists keep their own Enter. It clicks the button
  // rather than submitting the form, so the button's rule still holds: nothing
  // happens until a customer is set, or while a job is being created.
  const createJobOnEnter = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.target !== e.currentTarget || e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    submitButtonRef.current?.click();
  };

  // Enter while adding a customer adds that customer. Left to the browser it
  // would submit the job form, creating the job for the customer chosen before.
  const addCustomerOnEnter = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || (e.target as HTMLElement).tagName !== "INPUT" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!creatingCustomer && newCustomerData.name.trim()) handleAddCustomer();
  };

  // Names need not be unique, so a new customer can always be added — even
  // when the search finds someone with the same name.
  const openAddCustomerForm = (name: string) => {
    setNewCustomerData(prev => ({ ...prev, name }));
    setShowAddCustomerForm(true);
  };
  const today = localDate();

  // What each stock item on the ticket needs: an area item counted in the
  // stock's own area unit uses its length × width, anything else its quantity.
  const stockNeededFor = (item: InvoiceItem, stockUnit?: string) =>
    stockNeeded({ quantity: item.itemType === 'Square Feet' ? item.quantity || 1 : item.quantity, unit: item.unit, length: item.length, width: item.width }, stockUnit);
  const stockRows = formData.items.map((item, index) => {
    const stock = stockItemNamed(inventoryItems, item.itemName);
    return { key: index, name: item.itemName, item: stock, needed: stock ? stockNeededFor(item, stock.unit) : 0 };
  });

  const setPrintSpec = (field: keyof typeof EMPTY_PRINT_SPECS, value: string) =>
    setFormData(prev => ({ ...prev, printSpecs: { ...prev.printSpecs, [field]: value } }));

  // Paper from inventory: picking one and entering the sheets puts the paper
  // on the items at its selling rate per sheet (lib/paperStock.ts).
  const papers = paperStock(inventoryItems);
  const pickedPaper = stockItemNamed(papers, formData.printSpecs.paperType);
  const paperLine = formData.items.find((i) => i.fromPaper);
  const setPaper = (paperType: string, sheetsText: string) =>
    setFormData(prev => {
      const paper = stockItemNamed(paperStock(inventoryItems), paperType);
      const sheets = Number(sheetsText) || 0;
      const items = withPaperLine(prev.items, paper, paper ? sheets : 0, (p) => sellingRate(p), blankItem).map((i) => (i.fromPaper ? priceJobItem(i) : i));
      return { ...prev, items, printSpecs: { ...prev.printSpecs, paperType, sheets: sheetsText } };
    });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[95vw] max-w-[1200px] max-h-[90vh] overflow-y-auto" onKeyDown={createJobOnEnter}>
          <DialogHeader>
            <DialogTitle className="text-lg sm:text-xl">
              {editingJob ? `Edit Job Ticket — ${editingJob.title || ''}` : preselectedCustomer ? `New Job Ticket for ${preselectedCustomer.name}` : 'New Job Ticket'}
            </DialogTitle>
            <DialogDescription className="text-sm">
              {editingJob
                ? (editLockedReason || 'Change the order, print specification, paper, cost, priority, delivery date or instructions.')
                : preselectedCustomer
                ? `Create a new job for ${preselectedCustomer.name}. Customer is pre-selected and cannot be changed.`
                : 'Capture the order, its print specification and the delivery date.'
              }
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Job Title *</Label>
              <Input
                id="title"
                value={formData.title}
                onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                placeholder="Enter job title"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Enter job description"
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="customerSearch">Customer *</Label>
              {preselectedCustomer ? (
                <div className="flex flex-col sm:flex-row sm:items-center space-y-2 sm:space-y-0 sm:space-x-2 p-3 border rounded-md bg-muted/50">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{preselectedCustomer.name}</div>
                    {preselectedCustomer.email && (
                      <div className="text-sm text-muted-foreground truncate">{preselectedCustomer.email}</div>
                    )}
                    {preselectedCustomer.phone && (
                      <div className="text-sm text-muted-foreground truncate">{preselectedCustomer.phone}</div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground bg-background px-2 py-1 rounded border shrink-0">
                    Fixed Selection
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {!showAddCustomerForm ? (
                    <CustomerSearch
                      id="customerSearch"
                      value={formData.customerId}
                      customer={selectedCustomer}
                      onSelect={handleCustomerSelect}
                      onCreateNew={openAddCustomerForm}
                    />
                  ) : (
                    <div className="space-y-3 p-3 border rounded-md bg-muted/5" onKeyDown={addCustomerOnEnter}>
                      <div className="flex items-center justify-between">
                        <h4 className="font-medium text-sm">Add a customer</h4>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowAddCustomerForm(false)}
                        >
                          ×
                        </Button>
                      </div>

                      <div className="space-y-3">
                        <CustomerTypePicker
                          id="newCustomerType"
                          compact
                          value={newCustomerData.customerType}
                          onChange={(customerType) => setNewCustomerData(prev => ({ ...prev, customerType }))}
                        />
                        <div className="space-y-2">
                          <Label htmlFor="newCustomerName" className="text-xs">{newCustomerData.customerType === "Agency" ? "Agency name *" : "Name *"}</Label>
                          <Input
                            id="newCustomerName"
                            value={newCustomerData.name}
                            onChange={(e) => setNewCustomerData(prev => ({ ...prev, name: e.target.value }))}
                            placeholder={newCustomerData.customerType === "Agency" ? "Agency name" : "Customer name"}
                            className="text-sm"
                          />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label htmlFor="newCustomerEmail" className="text-xs">Email</Label>
                            <Input
                              id="newCustomerEmail"
                              type="email"
                              value={newCustomerData.email}
                              onChange={(e) => setNewCustomerData(prev => ({ ...prev, email: e.target.value }))}
                              placeholder="Email address"
                              className="text-sm"
                            />
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="newCustomerPhone" className="text-xs">Phone</Label>
                            <Input
                              id="newCustomerPhone"
                              value={newCustomerData.phone}
                              onChange={(e) => setNewCustomerData(prev => ({ ...prev, phone: e.target.value }))}
                              placeholder="Phone number"
                              className="text-sm"
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="newCustomerAddress" className="text-xs">Address</Label>
                          <Textarea
                            id="newCustomerAddress"
                            value={newCustomerData.address}
                            onChange={(e) => setNewCustomerData(prev => ({ ...prev, address: e.target.value }))}
                            placeholder="Customer address"
                            rows={2}
                            className="text-sm"
                          />
                        </div>

                        <div className="flex gap-2 pt-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setShowAddCustomerForm(false)}
                            className="flex-1"
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={handleAddCustomer}
                            disabled={creatingCustomer || !newCustomerData.name.trim()}
                            className="flex-1"
                          >
                            {creatingCustomer ? "Adding..." : "Add Customer"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Select value={formData.priority} onValueChange={(value: 'low' | 'medium' | 'high') =>
                  setFormData(prev => ({ ...prev, priority: value }))
                }>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Select value={formData.status} onValueChange={(value: 'inquiry' | 'quotation_sent' | 'quotation_approved' | 'design_in_progress' | 'design_approved' | 'production_ready' | 'ready_for_print' | 'quality_check' | 'completed' | 'delivered' | 'cancelled') =>
                  setFormData(prev => ({ ...prev, status: value }))
                }>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STAGES.map((stage) => (
                      <SelectItem key={stage.status} value={stage.status}>{stage.label}</SelectItem>
                    ))}
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="estimatedCost">Estimated Cost</Label>
                <Input
                  id="estimatedCost"
                  type="number"
                  step="0.01"
                  value={formData.estimatedCost}
                  onChange={(e) => setFormData(prev => ({ ...prev, estimatedCost: e.target.value }))}
                  placeholder="0.00"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="dueDate">Bill Date</Label>
                <div className="p-3 bg-muted/50 border rounded-md">
                  <div className="text-sm font-medium">
                    {new Date(today).toLocaleDateString('en-IN', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric'
                    })}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    (Auto-set to today's date)
                  </div>
                </div>
              </div>
            </div>

            {/* Print specification — what the shop floor needs on the job ticket */}
            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-semibold">Print specification</div>
                <div className="text-xs text-muted-foreground">Shown on the production board</div>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="specQuantity" className="text-xs">Quantity</Label>
                  <Input
                    id="specQuantity"
                    type="number"
                    min="1"
                    value={formData.printSpecs.quantity}
                    onChange={(e) => setPrintSpec("quantity", e.target.value)}
                    placeholder="e.g. 1000"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="specSize" className="text-xs">Finished size</Label>
                  <Input
                    id="specSize"
                    value={formData.printSpecs.printSize}
                    onChange={(e) => setPrintSpec("printSize", e.target.value)}
                    placeholder="e.g. A4, 3.5×2 in"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="specPaper" className="text-xs">Paper / stock</Label>
                  <Input
                    id="specPaper"
                    list="paper-stock-options"
                    value={formData.printSpecs.paperType}
                    onChange={(e) => setPaper(e.target.value, formData.printSpecs.sheets)}
                    placeholder="e.g. Art Card 300 GSM"
                    aria-describedby="specPaperHint"
                  />
                  <datalist id="paper-stock-options">
                    {papers.length > 0
                      ? papers.map((p) => <option key={p._id || p.id || p.name} value={p.name}>{`${qtyText(p.quantity || 0)} ${unitText(p.unit)} in stock · ₹${sellingRate(p)} per ${unitText(p.unit) || 'unit'}`}</option>)
                      : PAPER_SUGGESTIONS.map((p) => <option key={p} value={p} />)}
                  </datalist>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="specSheets" className="text-xs">
                    {pickedPaper && pickedPaper.unit && pickedPaper.unit !== 'sheets' ? `Paper used (${unitText(pickedPaper.unit)})` : 'Sheets'}
                  </Label>
                  <Input
                    id="specSheets"
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={formData.printSpecs.sheets}
                    onChange={(e) => setPaper(formData.printSpecs.paperType, e.target.value)}
                    disabled={!pickedPaper}
                    placeholder={pickedPaper ? "e.g. 250" : "Pick a paper from stock"}
                    aria-describedby="specPaperHint"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Colours</Label>
                  <Select value={formData.printSpecs.colorType} onValueChange={(v) => setPrintSpec("colorType", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="color">Colour (CMYK)</SelectItem>
                      <SelectItem value="black_white">Black & white</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Lamination</Label>
                  <Select value={formData.printSpecs.lamination || "none"} onValueChange={(v) => setPrintSpec("lamination", v === "none" ? "" : v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["none", "Gloss", "Matt", "Velvet", "Gloss + Spot UV", "Matt + Spot UV"].map((v) => (
                        <SelectItem key={v} value={v}>{v === "none" ? "None" : v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Binding / finishing</Label>
                  <Select value={formData.printSpecs.binding || "none"} onValueChange={(v) => setPrintSpec("binding", v === "none" ? "" : v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["none", "Centre stitch", "Perfect bind", "Wiro", "Spiral", "Pad / gum", "Hard case", "Die-cut", "Fold"].map((v) => (
                        <SelectItem key={v} value={v}>{v === "none" ? "None" : v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2 space-y-1.5 md:col-span-1">
                  <Label htmlFor="deliveryDue" className="text-xs">Delivery due</Label>
                  <Input
                    id="deliveryDue"
                    type="date"
                    min={today}
                    value={formData.dueDate}
                    onChange={(e) => setFormData(prev => ({ ...prev, dueDate: e.target.value }))}
                  />
                </div>
              </div>
              <PaperHint
                paperType={formData.printSpecs.paperType}
                paper={pickedPaper}
                line={paperLine}
                hasPaperStock={papers.length > 0}
              />
              {stockRows.some((r) => r.item) && (
                <div className="mt-4 space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">Stock for this job</div>
                  <StockCheckList rows={stockRows} />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={formData.notes}
                onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Additional notes (optional)"
                rows={3}
              />
            </div>

            {/* Invoice Items Section */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Inventory Items</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {tableView ? (
                  <div className="overflow-x-auto rounded-lg border" role="region" aria-label="Inventory items table" tabIndex={0}>
                    <table className="w-full min-w-[1700px] table-fixed text-sm">
                      <colgroup>
                        <col className="w-[250px]" /><col className="w-[150px]" />
                        <col className="w-[120px]" /><col className="w-[120px]" /><col className="w-[100px]" />
                        <col className="w-[100px]" /><col className="w-[120px]" /><col className="w-[110px]" />
                        <col className="w-[90px]" /><col className="w-[130px]" /><col className="w-[220px]" />
                      </colgroup>
                      <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                        <tr>
                          {['Item name', 'Unit', 'Length', 'Width', 'Area', 'Qty / copies', 'Unit price', 'HSN code', 'GST %', 'Net amount', 'Note'].map((heading) => (
                            <th key={heading} scope="col" className="border-b px-2 py-3">{heading}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {formData.items.map((item, index) => {
                          const isArea = item.itemType === 'Square Feet';
                          const dimensionUnit = item.unit === 'sqm' ? 'm' : item.dimensionUnit || 'ft';
                          const stock = stockItemNamed(inventoryItems, item.itemName);
                          return (
                            <tr key={index} className="align-top even:bg-muted/20">
                              <td className="border-b p-2">
                                <SuggestionPopover
                                  open={!!showSuggestions[index]}
                                  onOpenChange={(next) => setShowSuggestions(prev => ({ ...prev, [index]: next }))}
                                  items={(() => {
                                    const query = item.itemName.trim().toLowerCase();
                                    return (query ? inventoryItems.filter(inv => inv.name.toLowerCase().includes(query)) : inventoryItems).slice(0, MAX_SUGGESTIONS);
                                  })()}
                                  getKey={(invItem) => invItem._id || invItem.id || invItem.name}
                                  onSelect={(invItem) => selectInventoryItem(index, invItem)}
                                  listLabel="Inventory items"
                                  empty={<div className="p-2 text-sm text-muted-foreground">{inventoryItems.length === 0 ? 'No inventory items available' : 'No matching inventory item — will be added as a custom item'}</div>}
                                  renderItem={(invItem) => (
                                    <div className="flex flex-col items-start">
                                      <span className="font-medium">{invItem.name}</span>
                                      <span className="text-xs text-muted-foreground">In stock: {invItem.quantity || 0} {unitText(invItem.unit)} · ₹{sellingRate(invItem)}</span>
                                    </div>
                                  )}
                                >
                                  <Input
                                    aria-label={`Item ${index + 1} name`}
                                    value={item.itemName}
                                    onChange={(e) => { updateItem(index, 'itemName', e.target.value); setShowSuggestions(prev => ({ ...prev, [index]: true })); }}
                                    onFocus={() => setShowSuggestions(prev => ({ ...prev, [index]: true }))}
                                    placeholder="Type or pick item"
                                    autoComplete="off"
                                  />
                                </SuggestionPopover>
                                {stock && <StockAvailability className="mt-1" item={stock} needed={stockNeededFor(item, stock.unit)} />}
                              </td>
                              <td className="border-b p-2">
                                <Select value={item.unit || 'pieces'} onValueChange={(value) => changeItemUnit(index, value)}>
                                  <SelectTrigger aria-label={`Item ${index + 1} unit`}><SelectValue placeholder="Unit" /></SelectTrigger>
                                  <SelectContent>{UNITS_OF_MEASUREMENT.map((unit) => <SelectItem key={unit.value} value={unit.value}>{unit.label}</SelectItem>)}</SelectContent>
                                </Select>
                              </td>
                              <td className="border-b p-2">
                                {isArea ? <>
                                  <Input aria-label={`Item ${index + 1} length in ${dimensionUnit}`} type="number" min="0" step="any" value={item.unit === 'sqft' ? item.lengthInput ?? shownDimension(item.length, item.dimensionUnit || 'ft') : item.length || ''} onChange={(e) => item.unit === 'sqft' ? updateDimension(index, 'length', e.target.value, item.dimensionUnit || 'ft') : updateItem(index, 'length', parseFloat(e.target.value) || undefined)} />
                                  {item.unit === 'sqft' && <Select value={item.dimensionUnit || 'ft'} onValueChange={(value: 'ft' | 'in') => changeDimensionUnit(index, value)}><SelectTrigger aria-label={`Item ${index + 1} dimension unit`} className="mt-1 h-7 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ft">Feet</SelectItem><SelectItem value="in">Inches</SelectItem></SelectContent></Select>}
                                </> : <span className="block py-2 text-center text-muted-foreground">—</span>}
                              </td>
                              <td className="border-b p-2">{isArea ? <Input aria-label={`Item ${index + 1} width in ${dimensionUnit}`} type="number" min="0" step="any" value={item.unit === 'sqft' ? item.widthInput ?? shownDimension(item.width, item.dimensionUnit || 'ft') : item.width || ''} onChange={(e) => item.unit === 'sqft' ? updateDimension(index, 'width', e.target.value, item.dimensionUnit || 'ft') : updateItem(index, 'width', parseFloat(e.target.value) || undefined)} /> : <span className="block py-2 text-center text-muted-foreground">—</span>}</td>
                              <td className="border-b px-2 py-4 text-right tabular-nums">{isArea ? `${(item.totalSquareFeet || 0).toFixed(2)} ${item.unit === 'sqm' ? 'sq m' : 'sq ft'}` : '—'}</td>
                              <td className="border-b p-2"><Input aria-label={`Item ${index + 1} quantity`} type="number" min={isArea ? '1' : '0'} step={isArea ? '1' : 'any'} value={item.quantity || ''} onChange={(e) => updateItem(index, 'quantity', isArea ? Math.max(0, Math.floor(Number(e.target.value) || 0)) : parseFloat(e.target.value) || 0)} /></td>
                              <td className="border-b p-2"><Input aria-label={`Item ${index + 1} unit price`} type="number" min="0" step="0.01" value={item.unitPrice} onChange={(e) => updateItem(index, 'unitPrice', parseFloat(e.target.value) || 0)} /></td>
                              <td className="border-b p-2"><Input aria-label={`Item ${index + 1} HSN code`} list="job-hsn-options" inputMode="numeric" placeholder="e.g. 4911" value={item.hsnCode || ''} onChange={(e) => updateItem(index, 'hsnCode', e.target.value.replace(/\D/g, '').slice(0, 8) || undefined)} /></td>
                              <td className="border-b p-2"><Input aria-label={`Item ${index + 1} GST percentage`} type="number" min="0" max="100" step="0.01" value={item.gstRate} onChange={(e) => updateItem(index, 'gstRate', parseFloat(e.target.value) || 0)} /></td>
                              <td className="border-b px-2 py-3"><div className="flex items-center justify-between gap-1"><EditableLineTotal value={item.itemTotal} label={`Item ${index + 1} total including GST`} onCommit={(t) => setItemTotal(index, t)} className="-ml-1.5" /><Button type="button" variant="ghost" size="icon" aria-label={`Remove item ${index + 1}`} onClick={() => removeItem(index)}><Trash2 className="h-4 w-4" /></Button></div></td>
                              <td className="border-b p-2"><Input aria-label={`Item ${index + 1} note`} value={item.description || ''} onChange={(e) => updateItem(index, 'description', e.target.value)} placeholder="Finish, colour…" maxLength={500} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                <>
                {formData.items.map((item, index) => (
                  <div key={index} className="grid grid-cols-1 gap-2 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor={`job-item-${index}`} className="text-xs">Item Name</Label>
                      <SuggestionPopover
                        open={!!showSuggestions[index]}
                        onOpenChange={(next) => setShowSuggestions(prev => ({ ...prev, [index]: next }))}
                        items={(() => {
                          const query = item.itemName.trim().toLowerCase();
                          return (query ? inventoryItems.filter(inv => inv.name.toLowerCase().includes(query)) : inventoryItems).slice(0, MAX_SUGGESTIONS);
                        })()}
                        getKey={(invItem) => invItem._id || invItem.id || invItem.name}
                        onSelect={(invItem) => selectInventoryItem(index, invItem)}
                        listLabel="Inventory items"
                        empty={
                          <div className="p-2 text-sm text-muted-foreground">
                            {inventoryItems.length === 0 ? "No inventory items available" : "No matching inventory item — will be added as a custom item"}
                          </div>
                        }
                        renderItem={(invItem) => (
                          <div className="flex flex-col items-start">
                            <span className="font-medium">{invItem.name}</span>
                            <span className="text-xs text-muted-foreground">
                              In stock: {invItem.quantity || 0} {unitText(invItem.unit)} · ₹{sellingRate(invItem)}
                              {invItem.hsnCode ? ` · HSN ${invItem.hsnCode}` : ''}
                            </span>
                          </div>
                        )}
                      >
                        <Input
                          id={`job-item-${index}`}
                          value={item.itemName}
                          onChange={(e) => {
                            updateItem(index, 'itemName', e.target.value);
                            setShowSuggestions(prev => ({ ...prev, [index]: true }));
                          }}
                          onFocus={() => {
                            setShowSuggestions(prev => ({ ...prev, [index]: true }));
                          }}
                          placeholder="Type or pick an inventory item"
                          autoComplete="off"
                        />
                      </SuggestionPopover>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">Unit</Label>
                      <Select
                        value={item.unit || 'pieces'}
                        onValueChange={(value) => changeItemUnit(index, value)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select unit" />
                        </SelectTrigger>
                        <SelectContent>
                          {UNITS_OF_MEASUREMENT.map((unit) => (
                            <SelectItem key={unit.value} value={unit.value}>
                              {unit.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Conditional fields based on item unit */}
                    {item.itemType === 'Square Feet' ? (
                      <>
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-1">
                            <Label className="text-xs">Length ({item.unit === 'sqm' ? 'm' : item.dimensionUnit || 'ft'})</Label>
                            {item.unit === 'sqft' && (
                              <Select value={item.dimensionUnit || 'ft'} onValueChange={(value: 'ft' | 'in') => changeDimensionUnit(index, value)}>
                                <SelectTrigger aria-label="Dimension unit" className="h-7 w-[76px] px-2 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="ft">Feet</SelectItem>
                                  <SelectItem value="in">Inches</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                          <Input
                            type="number"
                            step="any"
                            value={item.unit === 'sqft' ? item.lengthInput ?? shownDimension(item.length, item.dimensionUnit || 'ft') : item.length || ''}
                            onChange={(e) => item.unit === 'sqft' ? updateDimension(index, 'length', e.target.value, item.dimensionUnit || 'ft') : updateItem(index, 'length', parseFloat(e.target.value) || undefined)}
                            placeholder="Enter length"
                            min="0"
                          />
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs">Width ({item.unit === 'sqm' ? 'm' : item.dimensionUnit || 'ft'})</Label>
                          <Input
                            type="number"
                            step="any"
                            value={item.unit === 'sqft' ? item.widthInput ?? shownDimension(item.width, item.dimensionUnit || 'ft') : item.width || ''}
                            onChange={(e) => item.unit === 'sqft' ? updateDimension(index, 'width', e.target.value, item.dimensionUnit || 'ft') : updateItem(index, 'width', parseFloat(e.target.value) || undefined)}
                            placeholder="Enter width"
                            min="0"
                          />
                        </div>

                        <div className="space-y-1">
                          <Label htmlFor={`job-pieces-${index}`} className="text-xs">Number of Pieces</Label>
                          <Input
                            id={`job-pieces-${index}`}
                            type="number"
                            inputMode="numeric"
                            step="1"
                            min="1"
                            value={item.quantity || ''}
                            onChange={(e) => updateItem(index, 'quantity', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                            placeholder="1"
                          />
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs">
                            {item.unit === 'sqm' ? 'Price per Sq M' : 'Price per Sq Ft'}
                          </Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={item.unitPrice}
                            onChange={(e) => updateItem(index, 'unitPrice', parseFloat(e.target.value) || 0)}
                            min="0"
                            placeholder={item.unit === 'sqm' ? 'Price per sq m' : 'Price per sq ft'}
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="space-y-1">
                          <Label className="text-xs">
                            {item.unit === 'boxes' ? 'Qty (Boxes)'
                              : item.unit === 'reams' ? 'Qty (Reams)'
                              : item.unit === 'kg' ? 'Qty (kg)'
                              : item.unit === 'grams' ? 'Qty (g)'
                              : item.unit === 'liters' ? 'Qty (L)'
                              : item.unit === 'meters' ? 'Qty (m)'
                              : item.unit === 'rolls' ? 'Qty (Rolls)'
                              : item.unit === 'sheets' ? 'Qty (Sheets)'
                              : 'Qty (Pcs)'}
                          </Label>
                          <Input
                            type="number"
                            value={item.quantity}
                            onChange={(e) => updateItem(index, 'quantity', parseFloat(e.target.value) || 0)}
                            min="0"
                          />
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs">Unit Price</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={item.unitPrice}
                            onChange={(e) => updateItem(index, 'unitPrice', parseFloat(e.target.value) || 0)}
                            min="0"
                          />
                        </div>
                      </>
                    )}

                    <div className="space-y-1">
                      {/* Filled from the stock item when one is picked; any code can be typed. */}
                      <Label htmlFor={`job-hsn-${index}`} className="text-xs">HSN Code (Optional)</Label>
                      <Input
                        id={`job-hsn-${index}`}
                        list="job-hsn-options"
                        value={item.hsnCode || ''}
                        onChange={(e) => updateItem(index, 'hsnCode', e.target.value.replace(/\D/g, '').slice(0, 8) || undefined)}
                        inputMode="numeric"
                        placeholder="e.g. 4911"
                      />
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">GST %</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={item.gstRate}
                        onChange={(e) => updateItem(index, 'gstRate', parseFloat(e.target.value) || 0)}
                        min="0"
                        max="100"
                      />
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">
                        {item.itemType === 'Square Feet'
                          ? (item.unit === 'sqm' ? 'Area / Amount' : 'Sq Ft / Amount')
                          : 'Total'}
                      </Label>
                      <div className="flex flex-col items-start space-y-1">
                        {item.itemType === 'Square Feet' && (
                          <span className="text-xs text-muted-foreground">
                            {item.length && item.width
                              ? `${item.totalSquareFeet?.toFixed(2)} ${item.unit === 'sqm' ? 'sq m' : 'sq ft'} (${item.unit === 'sqm' ? item.length : shownDimension(item.length, item.dimensionUnit || 'ft')} × ${item.unit === 'sqm' ? item.width : shownDimension(item.width, item.dimensionUnit || 'ft')} ${item.unit === 'sqm' ? 'm' : item.dimensionUnit || 'ft'} × ${item.quantity || 0} ${Number(item.quantity) === 1 ? 'pc' : 'pcs'})`
                              : 'Set L & W'}
                          </span>
                        )}
                        <div className="flex items-center space-x-1 w-full">
                          <EditableLineTotal value={item.itemTotal} label={`Item ${index + 1} total including GST`} onCommit={(t) => setItemTotal(index, t)} className="-ml-1.5" />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => removeItem(index)}
                            className="h-8 w-8 p-0 ml-auto"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-1 sm:col-span-2 lg:col-span-4">
                      <Label htmlFor={`job-note-${index}`} className="text-xs">Note for this item</Label>
                      <Input
                        id={`job-note-${index}`}
                        value={item.description || ''}
                        onChange={(e) => updateItem(index, 'description', e.target.value)}
                        placeholder="Finish, colour, cutting or other instructions (optional)"
                        maxLength={500}
                      />
                    </div>
                    {(() => {
                      const stock = stockItemNamed(inventoryItems, item.itemName);
                      return stock ? <StockAvailability className="sm:col-span-2 lg:col-span-4" item={stock} needed={stockNeededFor(item, stock.unit)} /> : null;
                    })()}
                  </div>
                ))}
                </>
                )}
                <datalist id="job-hsn-options">
                  {hsnCodes.map((hsn) => (
                    <option key={hsn._id || hsn.id} value={hsn.hsnCode}>{hsn.description}</option>
                  ))}
                </datalist>

                {formData.items.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    No inventory items added. You can bill a design charge on its own.
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" aria-pressed={tableView} onClick={() => { setShowSuggestions({}); setTableView((current) => !current); }}>
                    {tableView ? 'Card View' : 'Table View'}
                  </Button>
                  <Button type="button" onClick={addItem} size="sm">
                    <Plus className="h-4 w-4" />
                    Add Item
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Design Charge Section */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  <span>Design Charge</span>
                  {!formData.designCharge ? (
                    <Button
                      type="button"
                      onClick={() => {
                        setFormData(prev => ({
                          ...prev,
                          designCharge: {
                            amount: 0,
                            sacCode: '',
                            gstRate: 18,
                            totalAmount: 0
                          }
                        }));
                      }}
                      size="sm"
                    >
                      <Plus className="h-4 w-4" />
                      Add Design Charge
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setFormData(prev => ({
                          ...prev,
                          designCharge: null
                        }));
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      Remove
                    </Button>
                  )}
                </CardTitle>
              </CardHeader>
              {formData.designCharge && (
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 border rounded-lg">
                    <div className="space-y-2">
                      <Label htmlFor="designChargeAmount">Design Charge Amount *</Label>
                      <Input
                        id="designChargeAmount"
                        type="number"
                        step="0.01"
                        min="0"
                        value={formData.designCharge.amount === 0 ? '' : formData.designCharge.amount}
                        onChange={(e) => {
                          const amount = parseFloat(e.target.value) || 0;
                          setFormData(prev => {
                            if (!prev.designCharge) return prev;
                            const subtotal = amount;
                            const gstAmount = (subtotal * prev.designCharge.gstRate) / 100;
                            const totalAmount = subtotal + gstAmount;
                            return {
                              ...prev,
                              designCharge: {
                                ...prev.designCharge,
                                amount,
                                totalAmount
                              }
                            };
                          });
                        }}
                        placeholder="Enter amount"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="designChargeSac">SAC Code (Optional)</Label>
                      <Select
                        value={formData.designCharge.sacCode || 'no-sac'}
                        onValueChange={(value) => {
                          setFormData(prev => {
                            if (!prev.designCharge) return prev;
                            return {
                              ...prev,
                              designCharge: {
                                ...prev.designCharge,
                                sacCode: value === 'no-sac' ? undefined : value
                              }
                            };
                          });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Optional - Select SAC" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="no-sac">No SAC Code</SelectItem>
                          {sacCodes.map((sac) => (
                            <SelectItem key={sac._id || sac.id} value={sac.sacCode}>
                              {sac.sacCode} - {sac.description}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="designChargeGst">GST % *</Label>
                      <Input
                        id="designChargeGst"
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        value={formData.designCharge.gstRate}
                        onChange={(e) => {
                          const gstRate = parseFloat(e.target.value) || 0;
                          setFormData(prev => {
                            if (!prev.designCharge) return prev;
                            const subtotal = prev.designCharge.amount;
                            const gstAmount = (subtotal * gstRate) / 100;
                            const totalAmount = subtotal + gstAmount;
                            return {
                              ...prev,
                              designCharge: {
                                ...prev.designCharge,
                                gstRate,
                                totalAmount
                              }
                            };
                          });
                        }}
                      />
                    </div>
                  </div>

                  <div className="flex justify-end p-4 border-t">
                    <div className="text-right">
                      <div className="text-sm text-muted-foreground mb-1">
                        Subtotal: ₹{formData.designCharge.amount.toFixed(2)}
                      </div>
                      <div className="text-lg font-semibold">
                        Total: ₹{formData.designCharge.totalAmount.toFixed(2)}
                      </div>
                    </div>
                  </div>
                </CardContent>
              )}
            </Card>

            {/* Total Amount Summary — only when there is something to total.
                Rendered unconditionally it showed as an empty grey box above
                the buttons on a new job ticket. */}
            {(formData.items.length > 0 || !!formData.designCharge) && (
            <Card className="bg-muted/50">
              <CardContent className="pt-6">
                <div className="space-y-3">
                  {formData.items.length > 0 && (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Items Subtotal:</span>
                        <span>₹{jobTotals.subtotal.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Items Tax (GST):</span>
                        <span>₹{jobItemsGst.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between font-semibold border-t pt-2">
                        <span>Items Total:</span>
                        <span>₹{(jobTotals.subtotal + jobItemsGst).toFixed(2)}</span>
                      </div>
                    </>
                  )}

                  {formData.designCharge && (
                    <div className="flex justify-between font-semibold border-t pt-2">
                      <span>Design Charge Total:</span>
                      <span>₹{(jobTotals.designCharge + jobTotals.design.gstAmount).toFixed(2)}</span>
                    </div>
                  )}

                  {(formData.items.length > 0 || formData.designCharge) && (
                    <div className="flex justify-between text-lg font-bold border-t pt-3 text-primary">
                      <span>Grand Total:</span>
                      <span>₹{jobTotals.total.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
            )}

            <DialogFooter className="flex flex-col sm:flex-row gap-2 sm:gap-0 sm:justify-end">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
                Cancel
              </Button>
              <Button ref={submitButtonRef} type="submit" disabled={loading || !formData.customerId} className="w-full sm:w-auto">
                {loading ? (editingJob ? "Saving..." : "Creating...") : (editingJob ? "Save Changes" : "Create Job")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Invoice Choice Dialog */}
      <Dialog open={showInvoiceQuestion} onOpenChange={(open) => {
        if (!open) {
          setShowInvoiceQuestion(false);
          onOpenChange(false);
          setCreatedJob(null);
          setCreatedJobId(null);
          onJobCreated();
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generate Invoice</DialogTitle>
            <DialogDescription>
              Would you like to generate an invoice for this job?
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              Create an invoice now, or find this job later under To invoice on the Invoices page.
            </p>
          </div>
          <DialogFooter className="flex flex-col sm:flex-row gap-2 sm:gap-0 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                toast({ title: "Job saved for later", description: "Find it under To invoice on the Invoices page." });
                setShowInvoiceQuestion(false);
                onOpenChange(false);
                setCreatedJob(null);
                setCreatedJobId(null);
                onJobCreated();
              }}
              className="w-full sm:w-auto"
            >
              Skip for Now
            </Button>
            <Button
              type="button"
              onClick={handleGenerateInvoiceDirectly}
              disabled={isGeneratingInvoice}
              className="w-full sm:w-auto"
            >
              {isGeneratingInvoice ? "Generating..." : "Generate Invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invoice Generation Dialog */}
      {createdJob && showInvoiceCreation && (
        <JobInvoiceDialog
          job={createdJob}
          onInvoiceGenerated={(invoice) => {
            // Saved: the same Print / Download / Send actions as a direct invoice.
            setShowInvoiceCreation(false);
            setShowInvoiceQuestion(false);
            setCreatedInvoice(invoice);
            setShowInvoiceView(true);
          }}
        >
          <button ref={invoiceTriggerRef} style={{ display: 'none' }} />
        </JobInvoiceDialog>
      )}

      {/* The saved invoice's actions: Print, Download, Send or Close */}
      <InvoiceSavedDialog
        invoice={showInvoiceView ? createdInvoice : null}
        title={createdInvoice ? `${createdInvoice.invoiceNumber || "Invoice"} generated` : undefined}
        onClose={() => {
          setShowInvoiceView(false);
          setCreatedInvoice(null);
          setCreatedJob(null);
          setCreatedJobId(null);
          onOpenChange(false);
          onJobCreated();
        }}
      />
    </>
  );
}
