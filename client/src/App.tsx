import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "@/components/layout/Layout";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { PermissionRoute } from "@/components/auth/PermissionRoute";
import Index from "./pages/Index";
import Customers from "./pages/Customers";
import Jobs from "./pages/Jobs";
import Invoices from "./pages/Invoices";
import Inventory from "./pages/Inventory";
import Vendors from "./pages/Vendors";
import PurchaseBills from "./pages/PurchaseBills";
import PurchaseOrders from "./pages/PurchaseOrders";
import Staff from "./pages/Staff";
import CalendarPage from "./pages/CalendarPage";
import Proofing from "./pages/Proofing";
import Reports from "./pages/Reports";
import WhatsApp from "./pages/WhatsApp";
import WalkInJobs from "./pages/WalkInJobs";
import Delivery from "./pages/Delivery";
import DesignerTimer from "./pages/DesignerTimer";
import HsnCodes from "./pages/HsnCodes";
import SacCodes from "./pages/SacCodes";
import Discounts from "./pages/Discounts";
import EmergencyOrders from "./pages/EmergencyOrders";
import Costs from "./pages/Costs";
import Payments from "./pages/Payments";
import Portal from "./pages/Portal";
import Settings from "./pages/Settings";
import ActivityLog from "./pages/ActivityLog";
import Auth from "./pages/Auth";
import Accounts from "./pages/Accounts";
import Quotations from "./pages/Quotations";
import Employees from "./pages/Employees";
import Attendance from "./pages/Attendance";
import Leaves from "./pages/Leaves";
import Payroll from "./pages/Payroll";
import NotFound from "./pages/NotFound";
import UserManagement from "./pages/UserManagement";
import TermsAndConditions from "./pages/TermsAndConditions";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import DataPolicy from "./pages/DataPolicy";
import PaymentReminders from "./pages/PaymentReminders";
import AcceptInvitation from "./pages/AcceptInvitation";
import ProductionBoard from "./pages/ProductionBoard";
import PrintEstimator from "./pages/PrintEstimator";
import CustomerPortal from "./pages/CustomerPortal";
import TaskDetail from "./pages/TaskDetail";
import TeamOverview from "./pages/TeamOverview";

const queryClient = new QueryClient();

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
              <Route path="/accept-invitation/:token" element={<AcceptInvitation />} />
              <Route path="/terms-and-conditions" element={<TermsAndConditions />} />
              <Route path="/privacy-policy" element={<PrivacyPolicy />} />
              <Route path="/data-security-policy" element={<DataPolicy />} />
              {/* Customer-facing portal: opened with a personal link, no staff login */}
              <Route path="/customer-portal/:token" element={<CustomerPortal />} />
              <Route
                path="/*"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Routes>
                        <Route path="/" element={<PermissionRoute permission="Dashboard"><Index /></PermissionRoute>} />
                        <Route path="/customers" element={<PermissionRoute permission="Customers"><Customers /></PermissionRoute>} />
                        <Route path="/jobs" element={<PermissionRoute permission="Jobs"><Jobs /></PermissionRoute>} />
                        <Route path="/production" element={<PermissionRoute permission="Jobs"><ProductionBoard /></PermissionRoute>} />
                        <Route path="/estimator" element={<PermissionRoute permission="Quotations"><PrintEstimator /></PermissionRoute>} />
                        <Route path="/quotations" element={<PermissionRoute permission="Quotations"><Quotations /></PermissionRoute>} />
                        <Route path="/discounts" element={<PermissionRoute permission="Discounts"><Discounts /></PermissionRoute>} />
                        <Route path="/invoices" element={<PermissionRoute permission="Invoicing"><Invoices /></PermissionRoute>} />
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
                        <Route path="/portal" element={<PermissionRoute permission="Customer Portal"><Portal /></PermissionRoute>} />
                        <Route path="/employees" element={<PermissionRoute permission="Human Resources"><Employees /></PermissionRoute>} />
                        <Route path="/attendance" element={<PermissionRoute permission="Human Resources"><Attendance /></PermissionRoute>} />
                        <Route path="/leaves" element={<PermissionRoute permission="Human Resources"><Leaves /></PermissionRoute>} />
                        <Route path="/payroll" element={<PermissionRoute permission="Payroll"><Payroll /></PermissionRoute>} />
                        <Route path="/settings" element={<PermissionRoute permission="Settings"><Settings /></PermissionRoute>} />
                        <Route path="/activity-log" element={<PermissionRoute permission="Activity Log"><ActivityLog /></PermissionRoute>} />
                        <Route path="/users" element={<PermissionRoute permission="User Management"><UserManagement /></PermissionRoute>} />
                        {/* The old address of User Management */}
                        <Route path="/create-login" element={<Navigate to="/users" replace />} />
                        <Route path="/hidden-create-login" element={<Navigate to="/users" replace />} />
                        <Route path="*" element={<NotFound />} />
                      </Routes>
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
