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
    apiClient
      .listAll<{ hsnCode?: string; gstRate?: number }>("/hsn-codes", "hsnCodes")
      .then((codes) => {
        if (cancelled) return;
        const map = new Map<string, number>();
        for (const c of codes) {
          if (c.hsnCode && typeof c.gstRate === "number") map.set(String(c.hsnCode).trim().toUpperCase(), c.gstRate);
        }
        setRates(map);
      })
      .catch(() => {
        /* No access to the HSN master: rates are typed by hand. */
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
