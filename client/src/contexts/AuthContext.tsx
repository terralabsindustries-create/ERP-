import React, { createContext, useContext, useEffect, useState } from 'react';
import apiClient, { ApiResponse } from '@/lib/apiClient';
import { useToast } from '@/hooks/use-toast';
import { SubscriptionModal } from '@/components/subscription/SubscriptionModal';

// Gates the general "your subscription lapsed" auto-check (sign in, page
// reload, refreshUser). Hidden for now. Flip to `true` to re-enable it.
// The signup-page pricing modal below is intentionally NOT gated by this —
// it always shows once right after a brand-new account is created.
const SUBSCRIPTION_PLANS_ENABLED = false;

interface User {
  id: string;
  email: string;
  fullName: string;
  phone?: string;
  role: string;
  companyName?: string;
  preferences: any;
  permissions?: string[]; // Array of permission strings
  canViewAllData?: boolean; // Sees every team member's invoices, not just their own
  subscription?: {
    isActive: boolean;
    plan: string;
    startDate?: string;
    endDate?: string;
    autoRenew?: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

interface AuthContextType {
  user: User | null;
  session: any | null; // For compatibility, but not used with new backend
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: any }>;
  signUp: (email: string, password: string, fullName?: string) => Promise<{ error: any }>;
  signOut: () => Promise<void>;
  hasPermission: (permission: string) => boolean; // Check if user has a specific permission
  refreshUser: () => Promise<User | undefined>;
  showSubscriptionModal: boolean;
  setShowSubscriptionModal: (show: boolean) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const { toast } = useToast();

  // Check subscription status and show modal if needed
  const checkSubscriptionStatus = (userData: User) => {
    if (!SUBSCRIPTION_PLANS_ENABLED) return;

    // Subscriptions belong to the admin who signed up — manager/staff logins
    // are created via User Management, never carry their own subscription,
    // and must never be shown the paywall.
    if (userData.role !== 'admin') {
      setShowSubscriptionModal(false);
      return;
    }

    // Show modal if subscription is not active or doesn't exist
    if (!userData.subscription || !userData.subscription.isActive) {
      setShowSubscriptionModal(true);
    } else {
      setShowSubscriptionModal(false);
    }
  };

  // Determine if modal can be closed (only if subscription exists and is not undefined)
  const canCloseModal = user?.subscription !== undefined;

  useEffect(() => {
    // Check for existing token and user
    const checkAuthStatus = async () => {
      try {
        const token = localStorage.getItem('token');
        if (token) {
          const userData = await apiClient.getCurrentUser();
          setUser(userData);
          setSession({ user: userData });
          checkSubscriptionStatus(userData);
        }
      } catch (error) {
        // Token is invalid, clear it
        apiClient.clearToken();
      } finally {
        setLoading(false);
      }
    };

    checkAuthStatus();
  }, []);

  const signIn = async (email: string, password: string) => {
    try {
      const response = await apiClient.login(email, password);
      
      console.log(' AuthContext signIn response:', response);
      console.log('🔑 AuthContext signIn response:', response);
      
      setUser(response.user);
      setSession({ user: response.user });
      checkSubscriptionStatus(response.user);
      
      console.log('🔑 User set in AuthContext:', response.user);
      
      toast({
        title: "Welcome back!",
        description: "You've been signed in successfully.",
      });

      return { error: null };
    } catch (error: any) {
      console.error('🔑 AuthContext signIn error:', error);
      toast({
        title: "Sign In Failed",
        description: error.message || "An unexpected error occurred.",
        variant: "destructive",
      });
      return { error };
    }
  };

  const signUp = async (email: string, password: string, fullName?: string) => {
    try {
      const response = await apiClient.register(email, password, fullName || '');
      
      setUser(response.user);
      setSession({ user: response });

      toast({
        title: "Account Created!",
        description: "Welcome to SerpY ERP System.",
      });

      return { error: null };
    } catch (error: any) {
      toast({
        title: "Sign Up Failed",
        description: error.message || "An unexpected error occurred.",
        variant: "destructive",
      });
      return { error };
    }
  };

  const signOut = async () => {
    try {
      await apiClient.logout();
      setUser(null);
      setSession(null);
      
      toast({
        title: "Signed out",
        description: "You've been signed out successfully.",
      });
    } catch (error) {
      // Even if logout fails on server, clear local state
      setUser(null);
      setSession(null);
      apiClient.clearToken();
      
      toast({
        title: "Signed out",
        description: "You've been signed out successfully.",
      });
    }
  };

  /**
   * Works for both a MODULE ("Customers") and an ACTION ("Customers: Delete").
   * Mirrors backend/src/middleware/requirePermission.js exactly — keep the two
   * in step or the UI will offer buttons the API rejects.
   */
  const hasPermission = (permission: string): boolean => {
    // Admin has full access to everything
    if (user?.role === 'admin') {
      return true;
    }

    const granted = user?.permissions || [];
    const sep = permission.indexOf(': ');
    const module = sep === -1 ? permission : permission.slice(0, sep);

    if (!granted.includes(module)) return false;
    if (sep === -1) return true;

    // Logins created before granular actions existed have a module grant and no
    // actions — they keep full access to that module until they are re-saved.
    const hasAnyActionForModule = granted.some((p) => p.startsWith(`${module}: `));
    if (!hasAnyActionForModule) return true;

    return granted.includes(permission);
  };

  // Re-fetch the current user (e.g. after a successful subscription payment)
  // so the subscription gate updates immediately and stays correct on refresh.
  const refreshUser = async () => {
    try {
      const userData = await apiClient.getCurrentUser();
      setUser(userData);
      setSession({ user: userData });
      checkSubscriptionStatus(userData);
      return userData;
    } catch (error) {
      console.error('Failed to refresh user:', error);
    }
  };

  const value = {
    user,
    session,
    loading,
    signIn,
    signUp,
    signOut,
    hasPermission,
    refreshUser,
    showSubscriptionModal,
    setShowSubscriptionModal,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
      {/* Not gated by SUBSCRIPTION_PLANS_ENABLED: this modal is only ever
          opened explicitly, right after a brand-new account is created on
          the signup page (see OTPVerification). */}
      <SubscriptionModal
        open={showSubscriptionModal}
        onClose={() => setShowSubscriptionModal(false)}
        userPlan={user?.subscription?.plan}
        onPaymentSuccess={refreshUser}
      />
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}