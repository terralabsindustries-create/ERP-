import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import Subscription from "@/pages/Subscription";
import { ErrorState } from "@/components/common/LoadState";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading, signOut, sessionCheckError, retrySessionCheck, forgetSession } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    );
  }

  // The saved session could not be checked (slow or unreachable server): keep
  // it and offer a retry, rather than sending a signed-in person to sign in.
  if (!user && sessionCheckError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2">
        <ErrorState error={sessionCheckError} what="your account" onRetry={retrySessionCheck} />
        <Button variant="ghost" size="sm" onClick={forgetSession}>Sign in with another account</Button>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  if (user.subscription?.isActive === false) {
    return (
      <div className="min-h-screen bg-background">
        <header className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <div className="text-lg font-semibold">Carbon Print Flow</div>
            <p className="text-sm text-muted-foreground">Your business plan has ended. Renew to continue using the app.</p>
          </div>
          <Button variant="outline" onClick={() => void signOut()}>Sign out</Button>
        </header>
        <Subscription />
      </div>
    );
  }

  return <>{children}</>;
}
