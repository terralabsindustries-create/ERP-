import { useEffect, useState } from "react";
import apiClient from "@/lib/apiClient";

/**
 * The GST rate of each HSN code in the business's HSN master (Settings → HSN
 * Codes), so a line given an HSN code can start at that code's rate. Loaded
 * while `enabled`; a login without access to the master simply gets no
 * suggestions.
 */
export function useHsnGstRates(enabled: boolean) {
  const [rates, setRates] = useState<Map<string, number>>(() => new Map());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // HSN (goods) and SAC (services, e.g. design work: 9983xx) masters both
    // carry a rate; a line's code field takes either.
    Promise.allSettled([
      apiClient.listAll<{ hsnCode?: string; gstRate?: number }>("/hsn-codes", "hsnCodes"),
      apiClient.listAll<{ sacCode?: string; gstRate?: number }>("/sac-codes", "sacCodes"),
    ]).then(([hsn, sac]) => {
      if (cancelled) return;
      const map = new Map<string, number>();
      if (sac.status === "fulfilled") for (const c of sac.value) if (c.sacCode && typeof c.gstRate === "number") map.set(String(c.sacCode).trim().toUpperCase(), c.gstRate);
      if (hsn.status === "fulfilled") for (const c of hsn.value) if (c.hsnCode && typeof c.gstRate === "number") map.set(String(c.hsnCode).trim().toUpperCase(), c.gstRate);
      setRates(map);
      /* No access to a master: rates are typed by hand (and a blank rate is refused). */
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  /** The rate for an HSN code as text for a GST field, or "" when it is not in the master. */
  return (hsnCode?: string) => {
    const rate = hsnCode ? rates.get(hsnCode.trim().toUpperCase()) : undefined;
    return rate === undefined ? "" : String(rate);
  };
}

/**
 * The GST % for a line after a stock item is picked. The HSN master rate wins
 * (it is the configured, specific rate); otherwise the stock item's own rate;
 * otherwise the line keeps what was typed. An explicit 0 is a real rate and is
 * never replaced. Returns "" only when nothing is known, which the form then
 * refuses to save until the rate is entered.
 */
export function pickedGstRate(masterRate: string, itemRate: unknown, current: string): string {
  if (masterRate !== "") return masterRate;
  if (typeof itemRate === "number" && Number.isFinite(itemRate)) return String(itemRate);
  return current;
}
