import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fitsMethod, KIND_LABEL, paymentAccountsApi, type PaymentAccount } from "@/lib/api/paymentAccounts";

/**
 * The business's active payment accounts, loaded when `active` turns true
 * (e.g. when a payment form opens). `error` is set if they could not be loaded.
 */
export function usePaymentAccounts(active: boolean) {
  const [state, setState] = useState<{ accounts: PaymentAccount[]; loading: boolean; error: string }>({ accounts: [], loading: false, error: "" });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: "" }));
    paymentAccountsApi
      .list(true)
      .then((accounts) => !cancelled && setState({ accounts, loading: false, error: "" }))
      .catch((e) => !cancelled && setState({ accounts: [], loading: false, error: e instanceof Error ? e.message : "Payment accounts could not be loaded" }));
    return () => {
      cancelled = true;
    };
  }, [active]);
  return state;
}

/**
 * Why a payment form cannot be saved yet, as far as its account goes:
 * once the business has accounts, the one the money went into is required.
 */
export const paymentAccountProblem = (accounts: PaymentAccount[], method: string, value: string) => {
  if (!accounts.length) return "";
  if (!value) return "Choose the account the payment was received into.";
  const account = accounts.find((a) => a._id === value);
  if (account && !fitsMethod(account.kind, method)) return `${account.nickname} can't receive a ${method === "cash" ? "cash" : "non-cash"} payment. Choose another account.`;
  return "";
};

/**
 * "Payment received into": the account the money actually arrived in — Cash,
 * Paytm, a bank. Only accounts that fit the method are offered (cash into
 * cash; everything else into a bank or wallet), by nickname, never by number.
 * When exactly one account fits it is chosen; a choice that stops fitting
 * when the method changes is cleared.
 */
export function PaymentAccountSelect({
  id = "pay-account",
  accounts,
  loading,
  method,
  value,
  onChange,
  label = "Payment received into",
  disabled
}: {
  id?: string;
  accounts: PaymentAccount[];
  loading?: boolean;
  method: string;
  value: string;
  onChange: (id: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const fitting = accounts.filter((a) => fitsMethod(a.kind, method));
  const fittingKey = fitting.map((a) => a._id).join(",");

  useEffect(() => {
    if (value && !fitting.some((a) => a._id === value)) onChange("");
    else if (!value && fitting.length === 1) onChange(fitting[0]._id);
    // Re-run only when the accounts that fit, or the choice, change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fittingKey, value]);

  if (!loading && accounts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No payment accounts are set up, so this payment is filed by its method.{" "}
        <Link to="/accounts?view=payment-accounts" className="underline underline-offset-2">
          Add Cash, Paytm and bank accounts
        </Link>{" "}
        to track where money is received.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label} <span className="text-destructive">*</span>
      </Label>
      {/* Radix resets a controlled value it has no option for yet by calling
          this with ""; no real choice is "", so that call is ignored. */}
      <Select value={value} onValueChange={(v) => v && onChange(v)} disabled={disabled || loading}>
        <SelectTrigger id={id} aria-required="true">
          <SelectValue placeholder={loading ? "Loading accounts…" : fitting.length ? "Choose the account" : "No account fits this method"} />
        </SelectTrigger>
        <SelectContent>
          {fitting.map((a) => (
            <SelectItem key={a._id} value={a._id}>
              {a.nickname}
              <span className="ml-2 text-xs text-muted-foreground">{a.kind === "wallet" ? a.provider || KIND_LABEL.wallet : a.kind === "bank" ? a.bankName || "Bank" : "Cash"}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!loading && accounts.length > 0 && fitting.length === 0 && (
        <p className="text-xs text-destructive-strong">
          {method === "cash" ? "There is no active cash account." : "There is no active bank or wallet account."} Add one in Accounts → Payment accounts.
        </p>
      )}
    </div>
  );
}
