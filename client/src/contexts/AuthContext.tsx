import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import apiClient, { ApiResponse } from '@/lib/apiClient';
import { useToast } from '@/hooks/use-toast';

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
  accessRole?: string | null; // The named role their permissions come from (User Management → Roles)
  accessRoleName?: string | null;
  subscription?: {
    isActive: boolean;
    plan: string;
    startDate?: string;
    endDate?: string;
    autoRenew?: boolean;
    status?: 'paid' | 'trial' | 'legacy' | 'expired';
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
  /** Drop the local session without calling the server (the login no longer exists). */
  forgetSession: () => void;
  /** Set when the saved session could not be checked (server slow or offline) — not signed out. */
  sessionCheckError: Error | null;
  retrySessionCheck: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const [sessionCheckError, setSessionCheckError] = useState<Error | null>(null);
  const checkAuthStatus = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setSessionCheckError(null);
    try {
      const userData = await apiClient.getCurrentUser();
      setUser(userData);
      setSession({ user: userData });
    } catch (error: any) {
      // Only a rejected token ends the session. A timeout, a dropped
      // connection or a server error says nothing about the login, so the
      // token is kept and the person can retry instead of being signed out.
      if (error?.kind === 'auth' || error?.status === 401) {
        apiClient.clearToken();
      } else {
        setSessionCheckError(error instanceof Error ? error : new Error('Could not check your session'));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  // apiClient fires this when the server answers 401 to a signed-in request
  // (expired token, deactivated or deleted login): drop the session so the
  // routes send the person back to the sign-in page.
  const signedInRef = useRef(false);
  useEffect(() => {
    signedInRef.current = !!user;
  }, [user]);
  useEffect(() => {
    const onExpired = () => {
      // Several requests can fail at once; tell the person only once.
      if (!signedInRef.current) return;
      signedInRef.current = false;
      setUser(null);
      setSession(null);
      toast({ title: "You've been signed out", description: "Your session ended. Please sign in again.", variant: "destructive" });
    };
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, [toast]);

  useEffect(() => {
    const onPlanExpired = () => setUser((current) => current ? {
      ...current,
      subscription: { ...current.subscription, isActive: false, plan: current.subscription?.plan || 'free', status: 'expired' }
    } : current);
    window.addEventListener('subscription:expired', onPlanExpired);
    return () => window.removeEventListener('subscription:expired', onPlanExpired);
  }, []);

  const signIn = async (email: string, password: string) => {
    try {
      const response = await apiClient.login(email, password);
      
      
      setUser(response.user);
      setSession({ user: response.user });
      
      
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
        description: "Welcome to Carbon.",
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
  const hasPermission = useCallback((permission: string): boolean => {
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
  }, [user]);

  // Re-fetch the current user (e.g. right after signup) so the app treats
  // them as signed in.
  // Stable identities: consumers' effects that list these as dependencies
  // (the plan checkout, pages) must not re-run, and re-fetch, on every render.
  const refreshUser = useCallback(async () => {
    try {
      const userData = await apiClient.getCurrentUser();
      setUser(userData);
      setSession({ user: userData });
      return userData;
    } catch (error) {
      console.error('Failed to refresh user:', error);
    }
  }, []);

  const forgetSession = useCallback(() => {
    signedInRef.current = false;
    apiClient.clearToken();
    setUser(null);
    setSession(null);
  }, []);

  const signInRef = useRef(signIn);
  const signUpRef = useRef(signUp);
  const signOutRef = useRef(signOut);
  signInRef.current = signIn;
  signUpRef.current = signUp;
  signOutRef.current = signOut;
  const stableSignIn = useCallback((email: string, password: string) => signInRef.current(email, password), []);
  const stableSignUp = useCallback((email: string, password: string, fullName?: string) => signUpRef.current(email, password, fullName), []);
  const stableSignOut = useCallback(() => signOutRef.current(), []);

  const value = useMemo(() => ({
    user,
    session,
    loading,
    signIn: stableSignIn,
    signUp: stableSignUp,
    signOut: stableSignOut,
    hasPermission,
    refreshUser,
    forgetSession,
    sessionCheckError,
    retrySessionCheck: checkAuthStatus,
  }), [user, session, loading, stableSignIn, stableSignUp, stableSignOut, hasPermission, refreshUser, forgetSession, sessionCheckError, checkAuthStatus]);

  return (
    <AuthContext.Provider value={value}>
      {children}
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
