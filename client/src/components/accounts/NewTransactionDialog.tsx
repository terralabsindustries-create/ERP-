import { useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { usePaymentAccounts } from "@/components/payments/PaymentAccountSelect";
import type { PaymentAccount } from "@/lib/api/paymentAccounts";

interface NewTransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTransactionCreated: () => void;
}

type TransactionType = "income" | "expense" | "transfer" | "opening_balance";
type AccountType = "cash" | "bank";

// The Accounts page shows cash and bank balances, so entries go to one of those.
const ACCOUNT_TYPES: { value: AccountType; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "bank", label: "Bank" }
];

// Mirrors the server: "HDFC bank " and "hdfc Bank" are one account.
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

const emptyForm = () => ({
  transactionType: "income" as TransactionType,
  category: "",
  amount: "",
  description: "",
  postedAt: format(new Date(), "yyyy-MM-dd"),
  paymentMethod: "cash" as "cash" | "bank_transfer" | "cheque" | "card" | "upi",
  accountType: "cash" as AccountType,
  accountName: "",
  toAccountType: "bank" as AccountType,
  toAccountName: "",
  // Payment accounts (Cash, Paytm, banks) the entry is tied to, if any.
  paymentAccountId: "",
  toPaymentAccountId: "",
  reference: "",
  notes: ""
});

export function NewTransactionDialog({ open, onOpenChange, onTransactionCreated }: NewTransactionDialogProps) {
  const [formData, setFormData] = useState(emptyForm);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const { accounts: paymentAccounts } = usePaymentAccounts(open);
  const NONE = "none";
  const columnOf = (a: PaymentAccount): AccountType => (a.kind === "cash" ? "cash" : "bank");
  // Choosing a payment account fills in its column and name.
  const pickAccount = (side: "from" | "to", id: string) => {
    const a = paymentAccounts.find((x) => x._id === id);
    setFormData((prev) =>
      side === "from"
        ? { ...prev, paymentAccountId: a ? a._id : "", ...(a ? { accountType: columnOf(a), accountName: a.nickname } : {}) }
        : { ...prev, toPaymentAccountId: a ? a._id : "", ...(a ? { toAccountType: columnOf(a), toAccountName: a.nickname } : {}) }
    );
  };
  const accountPicker = (side: "from" | "to", label: string) =>
    paymentAccounts.length > 0 && (
      <div className="space-y-2">
        <Label htmlFor={`${side}-payment-account`}>{label}</Label>
        <Select value={(side === "from" ? formData.paymentAccountId : formData.toPaymentAccountId) || NONE} onValueChange={(v) => v && pickAccount(side, v === NONE ? "" : v)}>
          <SelectTrigger id={`${side}-payment-account`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None — type the account below</SelectItem>
            {paymentAccounts.map((a) => (
              <SelectItem key={a._id} value={a._id}>
                {a.nickname}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );

  const isTransfer = formData.transactionType === "transfer";
  // Transfers and opening balances have a fixed category.
  const category = isTransfer ? "transfer" : formData.transactionType === "opening_balance" ? "opening_balance" : formData.category;

  const invalid = (description: string) => {
    toast({ title: "Invalid Input", description, variant: "destructive" });
    return false;
  };

  const validate = () => {
    if (!category || !formData.amount || !formData.description.trim() || !formData.accountName.trim()) {
      return invalid("Please fill in all required fields");
    }
    if (!(parseFloat(formData.amount) > 0)) return invalid("The amount must be more than 0");
    if (isTransfer) {
      if (!formData.toAccountName.trim()) return invalid("Choose the account the money goes to");
      if (formData.paymentAccountId && formData.paymentAccountId === formData.toPaymentAccountId) return invalid("A transfer must go to a different account");
      if (formData.toAccountType === formData.accountType && sameName(formData.toAccountName, formData.accountName)) {
        return invalid("A transfer must go to a different account");
      }
    }
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    try {
      await apiClient.createAccountTransaction({
        transactionType: formData.transactionType,
        category,
        amount: parseFloat(formData.amount),
        description: formData.description.trim(),
        postedAt: formData.postedAt,
        paymentMethod: formData.paymentMethod,
        accountType: formData.accountType,
        accountName: formData.accountName.trim(),
        ...(formData.paymentAccountId && { paymentAccountId: formData.paymentAccountId }),
        ...(isTransfer && {
          transferDetails: {
            toAccountType: formData.toAccountType,
            toAccount: formData.toAccountName.trim(),
            ...(formData.toPaymentAccountId && { toPaymentAccountId: formData.toPaymentAccountId })
          }
        }),
        reference: formData.reference,
        notes: formData.notes,
        status: "completed"
      });

      toast({
        title: "Transaction Created",
        description: isTransfer ? "The transfer has been recorded on both accounts" : "Transaction has been recorded successfully"
      });

      onTransactionCreated();
      onOpenChange(false);
      setFormData(emptyForm());
    } catch (error) {
      console.error("Error creating transaction:", error);
      toast({
        title: "Transaction not saved",
        description: error instanceof Error && error.message ? error.message : "Failed to create transaction",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const accountSelect = (id: string, value: AccountType, onChange: (v: AccountType) => void, disabled = false) => (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ACCOUNT_TYPES.map((a) => (
          <SelectItem key={a.value} value={a.value}>
            {a.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Transaction</DialogTitle>
          <DialogDescription>Record income, an expense, an opening balance or a transfer between your accounts</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="postedAt">Transaction date *</Label>
              <Input id="postedAt" type="date" value={formData.postedAt} onChange={(e) => setFormData((prev) => ({ ...prev, postedAt: e.target.value }))} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="transactionType">Transaction Type *</Label>
              <Select
                value={formData.transactionType}
                onValueChange={(value: TransactionType) =>
                  setFormData((prev) => ({
                    ...prev,
                    transactionType: value,
                    category: "",
                    paymentMethod: value === "transfer" && prev.paymentMethod === "cash" ? "bank_transfer" : prev.paymentMethod
                  }))
                }
              >
                <SelectTrigger id="transactionType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="income">Income</SelectItem>
                  <SelectItem value="expense">Expense</SelectItem>
                  <SelectItem value="transfer">Transfer between accounts</SelectItem>
                  <SelectItem value="opening_balance">Opening balance</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">Amount *</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                min="0"
                value={formData.amount}
                onChange={(e) => setFormData((prev) => ({ ...prev, amount: e.target.value }))}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description *</Label>
            <Input
              id="description"
              value={formData.description}
              onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
              placeholder={isTransfer ? "e.g., Cash deposited to bank" : "Enter transaction description"}
            />
          </div>

          {(formData.transactionType === "income" || formData.transactionType === "expense") && (
            <div className="space-y-2">
              <Label htmlFor="category">Category *</Label>
              <Select value={formData.category} onValueChange={(value) => setFormData((prev) => ({ ...prev, category: value }))}>
                <SelectTrigger id="category">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {formData.transactionType === "income" ? (
                    <>
                      <SelectItem value="sales">Sales</SelectItem>
                      <SelectItem value="service">Service Income</SelectItem>
                      <SelectItem value="printing">Printing Jobs</SelectItem>
                      <SelectItem value="other_income">Other Income</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="materials">Materials</SelectItem>
                      <SelectItem value="rent">Rent</SelectItem>
                      <SelectItem value="utilities">Utilities</SelectItem>
                      <SelectItem value="salaries">Salaries</SelectItem>
                      <SelectItem value="equipment">Equipment</SelectItem>
                      <SelectItem value="services">Services</SelectItem>
                      <SelectItem value="other_expense">Other Expense</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="paymentMethod">Payment Method *</Label>
            <Select value={formData.paymentMethod} onValueChange={(value: typeof formData.paymentMethod) => setFormData((prev) => ({ ...prev, paymentMethod: value }))}>
              <SelectTrigger id="paymentMethod">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                <SelectItem value="cheque">Cheque</SelectItem>
                <SelectItem value="card">Card</SelectItem>
                <SelectItem value="upi">UPI</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {accountPicker("from", isTransfer ? "From payment account" : "Payment account")}
          <div className="grid grid-cols-[120px_1fr] gap-4">
            <div className="space-y-2">
              <Label htmlFor="accountType">{isTransfer ? "From *" : "Account *"}</Label>
              {accountSelect("accountType", formData.accountType, (v) => setFormData((prev) => ({ ...prev, accountType: v })), !!formData.paymentAccountId)}
            </div>
            <div className="space-y-2">
              <Label htmlFor="accountName">{isTransfer ? "From account name *" : "Account Name *"}</Label>
              <Input
                id="accountName"
                value={formData.accountName}
                onChange={(e) => setFormData((prev) => ({ ...prev, accountName: e.target.value }))}
                placeholder="e.g., Main Cash Account, HDFC Bank"
                disabled={!!formData.paymentAccountId}
              />
            </div>
          </div>

          {isTransfer && accountPicker("to", "To payment account")}
          {isTransfer && (
            <div className="grid grid-cols-[120px_1fr] gap-4">
              <div className="space-y-2">
                <Label htmlFor="toAccountType">To *</Label>
                {accountSelect("toAccountType", formData.toAccountType, (v) => setFormData((prev) => ({ ...prev, toAccountType: v })), !!formData.toPaymentAccountId)}
              </div>
              <div className="space-y-2">
                <Label htmlFor="toAccountName">To account name *</Label>
                <Input
                  id="toAccountName"
                  value={formData.toAccountName}
                  onChange={(e) => setFormData((prev) => ({ ...prev, toAccountName: e.target.value }))}
                  placeholder="e.g., HDFC Bank"
                  disabled={!!formData.toPaymentAccountId}
                />
              </div>
              <p className="col-span-2 text-xs text-muted-foreground">
                Taken out of the first account and added to the second. Your total balance stays the same.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="reference">Reference</Label>
            <Input
              id="reference"
              value={formData.reference}
              onChange={(e) => setFormData((prev) => ({ ...prev, reference: e.target.value }))}
              placeholder="Invoice number, receipt, etc."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
              placeholder="Additional notes (optional)"
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Creating..." : "Create Transaction"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
