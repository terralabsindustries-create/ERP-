import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import Subscription from "@/pages/Subscription";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading, signOut } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
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
