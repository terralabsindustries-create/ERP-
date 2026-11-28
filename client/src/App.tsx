import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Layout } from "@/components/layout/Layout";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { PermissionRoute } from "@/components/auth/PermissionRoute";
import Auth from "./pages/Auth";
import { PageErrorBoundary } from "@/components/common/LoadState";
import { Skeleton } from "@/components/ui/skeleton";

// Each page is its own chunk: the first load downloads the app shell and the
// page being opened, not all forty-odd screens.
const Index = lazy(() => import("./pages/Index"));
const Customers = lazy(() => import("./pages/Customers"));
const Jobs = lazy(() => import("./pages/Jobs"));
const Invoices = lazy(() => import("./pages/Invoices"));
const Inventory = lazy(() => import("./pages/Inventory"));
const Vendors = lazy(() => import("./pages/Vendors"));
const PurchaseBills = lazy(() => import("./pages/PurchaseBills"));
const PurchaseOrders = lazy(() => import("./pages/PurchaseOrders"));
const Staff = lazy(() => import("./pages/Staff"));
const CalendarPage = lazy(() => import("./pages/CalendarPage"));
const Proofing = lazy(() => import("./pages/Proofing"));
const Reports = lazy(() => import("./pages/Reports"));
const GstReports = lazy(() => import("./pages/GstReports"));
const RecurringInvoices = lazy(() => import("./pages/RecurringInvoices"));
const TallyExport = lazy(() => import("./pages/TallyExport"));
const WhatsApp = lazy(() => import("./pages/WhatsApp"));
const WalkInJobs = lazy(() => import("./pages/WalkInJobs"));
const Delivery = lazy(() => import("./pages/Delivery"));
const DesignerTimer = lazy(() => import("./pages/DesignerTimer"));
const HsnCodes = lazy(() => import("./pages/HsnCodes"));
const SacCodes = lazy(() => import("./pages/SacCodes"));
const PricingMaster = lazy(() => import("./pages/PricingMaster"));
const Discounts = lazy(() => import("./pages/Discounts"));
const SalesOrders = lazy(() => import("./pages/SalesOrders"));
const ProductRates = lazy(() => import("./pages/ProductRates"));
const EmergencyOrders = lazy(() => import("./pages/EmergencyOrders"));
const Costs = lazy(() => import("./pages/Costs"));
const Payments = lazy(() => import("./pages/Payments"));
const Portal = lazy(() => import("./pages/Portal"));
const Subscription = lazy(() => import("@/pages/Subscription"));
const Settings = lazy(() => import("./pages/Settings"));
const ActivityLog = lazy(() => import("./pages/ActivityLog"));
const Accounts = lazy(() => import("./pages/Accounts"));
const Quotations = lazy(() => import("./pages/Quotations"));
const Employees = lazy(() => import("./pages/Employees"));
const Attendance = lazy(() => import("./pages/Attendance"));
const Leaves = lazy(() => import("./pages/Leaves"));
const Payroll = lazy(() => import("./pages/Payroll"));
const NotFound = lazy(() => import("./pages/NotFound"));
const UserManagement = lazy(() => import("./pages/UserManagement"));
const TermsAndConditions = lazy(() => import("./pages/TermsAndConditions"));
const PrivacyPolicy = lazy(() => import("./pages/PrivacyPolicy"));
const DataPolicy = lazy(() => import("./pages/DataPolicy"));
const PaymentReminders = lazy(() => import("./pages/PaymentReminders"));
const AcceptInvitation = lazy(() => import("./pages/AcceptInvitation"));
const ProductionBoard = lazy(() => import("./pages/ProductionBoard"));
const PrintEstimator = lazy(() => import("./pages/PrintEstimator"));
const CustomerPortal = lazy(() => import("./pages/CustomerPortal"));
const TaskDetail = lazy(() => import("./pages/TaskDetail"));
const TeamOverview = lazy(() => import("./pages/TeamOverview"));

/*
  Shared data defaults. Data counts as fresh for 30 s, so moving between pages
  reuses it instead of asking again; failed requests retry twice with backoff,
  except answers that retrying cannot change (401/402/403/404/validation).
*/
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failures, error: any) =>
        failures < 2 && !["auth", "forbidden", "not_found", "validation", "subscription", "cancelled"].includes(error?.kind),
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
  },
});

function PageFallback() {
  return (
    <div className="space-y-4 p-6" aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20" />)}
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

/** Lazy page with its own error boundary, reset when the address changes. */
function Page({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <PageErrorBoundary resetKey={location.pathname}>
      <Suspense fallback={<PageFallback />}>{children}</Suspense>
    </PageErrorBoundary>
  );
}

const App = () => (
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              <Route path="/auth" element={<Auth />} />
              <Route path="/accept-invitation/:token" element={<Page><AcceptInvitation /></Page>} />
              <Route path="/terms-and-conditions" element={<Page><TermsAndConditions /></Page>} />
              <Route path="/privacy-policy" element={<Page><PrivacyPolicy /></Page>} />
              <Route path="/data-security-policy" element={<Page><DataPolicy /></Page>} />
              {/* Customer-facing portal: opened with a personal link, no staff login */}
              <Route path="/customer-portal/:token" element={<Page><CustomerPortal /></Page>} />
              <Route
                path="/*"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Page>
                      <Routes>
                        <Route path="/" element={<PermissionRoute permission="Dashboard"><Index /></PermissionRoute>} />
                        <Route path="/customers" element={<PermissionRoute permission="Customers"><Customers /></PermissionRoute>} />
                        <Route path="/jobs" element={<PermissionRoute permission="Jobs"><Jobs /></PermissionRoute>} />
                        <Route path="/production" element={<PermissionRoute permission="Jobs"><ProductionBoard /></PermissionRoute>} />
                        <Route path="/estimator" element={<PermissionRoute permission="Quotations"><PrintEstimator /></PermissionRoute>} />
                        <Route path="/quotations" element={<PermissionRoute permission="Quotations"><Quotations /></PermissionRoute>} />
                        <Route path="/pricing" element={<PermissionRoute permission="Pricing Master"><PricingMaster /></PermissionRoute>} />
                        <Route path="/sales-orders" element={<PermissionRoute permission="Sales Orders"><SalesOrders /></PermissionRoute>} />
                        <Route path="/product-rates" element={<PermissionRoute permission="Product Rates"><ProductRates /></PermissionRoute>} />
                        <Route path="/discounts" element={<PermissionRoute permission="Discounts"><Discounts /></PermissionRoute>} />
                        <Route path="/invoices" element={<PermissionRoute permission="Invoicing"><Invoices /></PermissionRoute>} />
                        <Route path="/recurring-invoices" element={<PermissionRoute permission="Invoicing"><RecurringInvoices /></PermissionRoute>} />
                        {/* One invoice list now; older No GST bills appear in it for logins allowed to see them. */}
                        <Route path="/invoices-no-gst" element={<Navigate to="/invoices" replace />} />
                        <Route path="/inventory" element={<PermissionRoute permission="Inventory"><Inventory /></PermissionRoute>} />
                        <Route path="/vendors" element={<PermissionRoute permission="Vendors"><Vendors /></PermissionRoute>} />
                        <Route path="/purchase-orders" element={<PermissionRoute permission={["Inventory", "Purchase Bills", "Vendors"]}><PurchaseOrders /></PermissionRoute>} />
                        <Route path="/purchase-bills" element={<PermissionRoute permission="Purchase Bills"><PurchaseBills /></PermissionRoute>} />
                        <Route path="/staff" element={<PermissionRoute permission="Staff & Tasks"><Staff /></PermissionRoute>} />
                        <Route path="/team" element={<PermissionRoute permission="Staff & Tasks"><TeamOverview /></PermissionRoute>} />
                        {/* Any login may open a task; the API decides whether they can see it */}
                        <Route path="/tasks/:taskId" element={<TaskDetail />} />
                        <Route path="/calendar" element={<PermissionRoute permission="Calendar"><CalendarPage /></PermissionRoute>} />
                        <Route path="/proofing" element={<PermissionRoute permission="Job Proofing"><Proofing /></PermissionRoute>} />
                        <Route path="/reports" element={<PermissionRoute permission="Reports"><Reports /></PermissionRoute>} />
                        <Route path="/gst-reports" element={<PermissionRoute permission={["Reports", "Accounts"]}><GstReports /></PermissionRoute>} />
                        <Route path="/whatsapp" element={<PermissionRoute permission="WhatsApp"><WhatsApp /></PermissionRoute>} />
                        <Route path="/payment-reminders" element={<PermissionRoute permission="Payment Reminders"><PaymentReminders /></PermissionRoute>} />
                        <Route path="/walk-in-jobs" element={<PermissionRoute permission="Walk-In Jobs"><WalkInJobs /></PermissionRoute>} />
                        <Route path="/delivery" element={<PermissionRoute permission="Delivery"><Delivery /></PermissionRoute>} />
                        <Route path="/emergency-orders" element={<PermissionRoute permission="Emergency Orders"><EmergencyOrders /></PermissionRoute>} />
                        <Route path="/designer-timer" element={<PermissionRoute permission="Designer Timer"><DesignerTimer /></PermissionRoute>} />
                        <Route path="/hsn-codes" element={<PermissionRoute permission="HSN Codes"><HsnCodes /></PermissionRoute>} />
                        <Route path="/sac-codes" element={<PermissionRoute permission="SAC Codes"><SacCodes /></PermissionRoute>} />
                        <Route path="/costs" element={<PermissionRoute permission="Cost & Profit"><Costs /></PermissionRoute>} />
                        <Route path="/payments" element={<PermissionRoute permission="Payments"><Payments /></PermissionRoute>} />
                        {/* General Ledger merged into Accounts — redirect old links */}
                        <Route path="/general-ledger" element={<Navigate to="/accounts" replace />} />
                        <Route path="/accounts" element={<PermissionRoute permission="Accounts"><Accounts /></PermissionRoute>} />
                        <Route path="/tally" element={<PermissionRoute permission="Accounts"><TallyExport /></PermissionRoute>} />
                        <Route path="/portal" element={<PermissionRoute permission="Customer Portal"><Portal /></PermissionRoute>} />
                        <Route path="/employees" element={<PermissionRoute permission="Human Resources"><Employees /></PermissionRoute>} />
                        <Route path="/attendance" element={<PermissionRoute permission={["Human Resources", "Attendance"]}><Attendance /></PermissionRoute>} />
                        <Route path="/leaves" element={<PermissionRoute permission="Human Resources"><Leaves /></PermissionRoute>} />
                        <Route path="/payroll" element={<PermissionRoute permission="Payroll"><Payroll /></PermissionRoute>} />
                        <Route path="/subscription" element={<Subscription />} />
                        <Route path="/settings" element={<PermissionRoute permission="Settings"><Settings /></PermissionRoute>} />
                        <Route path="/activity-log" element={<PermissionRoute permission="Activity Log"><ActivityLog /></PermissionRoute>} />
                        <Route path="/users" element={<PermissionRoute permission="User Management"><UserManagement /></PermissionRoute>} />
                        {/* The old address of User Management */}
                        <Route path="/create-login" element={<Navigate to="/users" replace />} />
                        <Route path="/hidden-create-login" element={<Navigate to="/users" replace />} />
                        <Route path="*" element={<NotFound />} />
                      </Routes>
                      </Page>
                    </Layout>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
