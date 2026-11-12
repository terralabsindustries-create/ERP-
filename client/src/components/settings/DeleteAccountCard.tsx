import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";

/**
 * The owner (admin) deletes their own account. That closes the business:
 * every login, record and uploaded file goes with it. Nobody else sees this.
 */
export function DeleteAccountCard() {
  const { user, forgetSession } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (user?.role !== "admin") return null;

  const reset = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) {
      setPassword("");
      setConfirmText("");
      setError("");
    }
  };

  const ready = password.length > 0 && confirmText === "DELETE";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      await apiClient.deleteOwnAccount(password);
      forgetSession();
      toast({ title: "Account deleted", description: "Your business and all its data have been removed." });
      navigate("/auth", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the account. Please try again.");
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="border-danger-border/40">
        <CardHeader>
          <CardTitle className="text-destructive-strong">Delete account</CardTitle>
          <CardDescription>
            Permanently delete your owner account and close {user.companyName || "your business"}. Every staff login,
            customer, job, quotation, invoice, payment, file and setting is removed. This can't be undone.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-end">
          <Button variant="destructive" onClick={() => reset(true)}>
            <Trash2 className="h-4 w-4" />
            Delete account
          </Button>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={reset}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Delete your account and business?</DialogTitle>
              <DialogDescription>
                All of {user.companyName || "your business"}'s data and every staff login will be deleted for good. Download
                anything you need to keep first.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label htmlFor="delete-account-password">Your password</Label>
              <Input
                id="delete-account-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="delete-account-confirm">
                Type <span className="font-mono font-semibold">DELETE</span> to confirm
              </Label>
              <Input
                id="delete-account-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
                disabled={busy}
              />
            </div>
            {error && <p className="text-sm text-destructive-strong" role="alert">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => reset(false)} disabled={busy}>
                Keep my account
              </Button>
              <Button type="submit" variant="destructive" disabled={!ready || busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete everything
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
