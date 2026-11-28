import { useState, useEffect } from "react";
import { fmtDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, TrendingUp, TrendingDown, IndianRupee, CreditCard, Receipt } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import apiClient from "@/lib/apiClient";

interface AccountReport {
  period: string;
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
  cashFlow: number;
  bankBalance: number;
  cashBalance: number;
}

interface Transaction {
  _id: string;
  transactionNumber: string;
  description: string;
  transactionType: string;
  amount: number;
  category: string;
  paymentMethod: string;
  createdAt: string;
  postedAt?: string;
  status: string;
}

// Income adds, expense subtracts; the other types do not change profit.
const TYPE_LABEL: Record<string, string> = { income: "Income", expense: "Expense", transfer: "Transfer", opening_balance: "Opening balance", adjustment: "Adjustment" };
const SIGN: Record<string, string> = { income: "+", expense: "-" };

export function AccountsReports() {
  const [reportData, setReportData] = useState<AccountReport | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState("month");
  const [recentTransactions, setRecentTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  // The report is for the whole business. Entries record which login typed
  // them, not whose income or cost they are, so there is no per-user profit.
  useEffect(() => {
    generateReport();
  }, [selectedPeriod]);

  const generateReport = async () => {
    setLoading(true);
    try {
      // Fetch recent transactions
      const params = {
        limit: '10',
        sortBy: 'createdAt',
        sortOrder: 'desc'
      };

      // Fetch recent transactions + the period-aware financial summary in parallel
      const [transactionsResponse, reportResponse] = (await Promise.all([
        apiClient.getAccountTransactions(params),
        apiClient.getAccountReportSummary(selectedPeriod),
      ])) as [{ transactions?: Transaction[] } | undefined, { report?: Partial<AccountReport> } | undefined];

      const transactions = transactionsResponse?.transactions || [];
      setRecentTransactions(transactions);

      const report: Partial<AccountReport> = reportResponse?.report || {};
      setReportData({
        period: selectedPeriod,
        totalIncome: report.totalIncome || 0,
        totalExpenses: report.totalExpenses || 0,
        netProfit: report.netProfit || 0,
        cashFlow: report.cashFlow || 0,
        bankBalance: report.bankBalance || 0,
        cashBalance: report.cashBalance || 0,
      });
    } catch (error) {
      console.error('Error generating report:', error);
      toast({
        title: "Error",
        description: "Failed to generate accounts report",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const exportReport = async () => {
    try {
      setLoading(true);

      const params = {
        period: selectedPeriod,
        format: 'excel'
      };

      // Download the Excel report
      await apiClient.downloadAccountReport(params);

      toast({
        title: "Export Complete",
        description: `Transactions report (Excel) for ${selectedPeriod} has been downloaded successfully`,
      });
    } catch (error) {
      console.error('Error exporting report:', error);
      toast({
        title: "Export Failed",
        description: "Failed to export transactions report",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="animate-pulse">
          <div className="h-8 bg-muted rounded w-1/4 mb-4"></div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[...new Array(4)].map((_, i) => (
              <div key={`skeleton-${i}`} className="h-32 bg-muted rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Profit & loss</h2>
          <p className="text-muted-foreground">Income, expenses and net profit. Only the owner sees this report.</p>
        </div>
        <div className="flex items-center space-x-2">
          <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
            <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
              <SelectItem value="week">This Week</SelectItem>
              <SelectItem value="month">This Month</SelectItem>
              <SelectItem value="quarter">This Quarter</SelectItem>
              <SelectItem value="year">This Year</SelectItem>
              </SelectContent>
            </Select>
          <Button onClick={exportReport} variant="outline" className="gap-2" disabled={loading}>
            <Download className="h-4 w-4" />
            {loading ? 'Exporting...' : 'Export to Excel'}
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-success" />
              Total Income
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">₹{reportData?.totalIncome.toLocaleString('en-IN') || 0}</div>
            <p className="text-xs text-muted-foreground">this {selectedPeriod}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-destructive" />
              Total Expenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">₹{reportData?.totalExpenses.toLocaleString('en-IN') || 0}</div>
            <p className="text-xs text-muted-foreground">this {selectedPeriod}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <IndianRupee className="h-4 w-4 text-info" />
              Net Profit
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">₹{reportData?.netProfit.toLocaleString('en-IN') || 0}</div>
            <p className="text-xs text-muted-foreground">profit margin</p>
          </CardContent>
      </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" />
              Cash Flow
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">₹{reportData?.cashFlow.toLocaleString('en-IN') || 0}</div>
            <p className="text-xs text-muted-foreground">operating cash flow</p>
          </CardContent>
        </Card>
      </div>

      {/* Balance Summary */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Current Balances</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Total Balance</span>
              <span className="text-xl font-bold">
                ₹{((reportData?.cashBalance || 0) + (reportData?.bankBalance || 0)).toLocaleString('en-IN')}
              </span>
            </div>
          </CardContent>
            </Card>

        <Card>
          <CardHeader>
            <CardTitle>Financial Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Income</span>
              <span className="text-lg font-bold text-success-strong">
                ₹{reportData?.totalIncome.toLocaleString('en-IN') || 0}
              </span>
                </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Expenses</span>
              <span className="text-lg font-bold text-destructive-strong">
                ₹{reportData?.totalExpenses.toLocaleString('en-IN') || 0}
              </span>
              </div>
            <div className="border-t pt-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Net Profit</span>
                <span className="text-xl font-bold text-info-strong">
                  ₹{reportData?.netProfit.toLocaleString('en-IN') || 0}
                </span>
              </div>
                </div>
          </CardContent>
            </Card>
          </div>

      {/* Recent Transactions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            Latest entries
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentTransactions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Receipt className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No transactions yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-4">Transaction Date</th>
                    <th className="text-left py-3 px-4">Transaction #</th>
                    <th className="text-left py-3 px-4">Description</th>
                    <th className="text-left py-3 px-4">Category</th>
                    <th className="text-left py-3 px-4">Type</th>
                    <th className="text-right py-3 px-4">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTransactions.map((transaction) => (
                    <tr key={transaction._id} className="border-b hover:bg-muted">
                      <td className="py-3 px-4 text-sm text-muted-foreground">
                        {fmtDate(transaction.postedAt || transaction.createdAt)}
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-sm font-medium text-info-strong">
                          {transaction.transactionNumber}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-sm">{transaction.description}</td>
                      <td className="py-3 px-4 text-sm text-muted-foreground">{transaction.category}</td>
                      <td className="py-3 px-4">
                        <Badge
                          variant={transaction.transactionType === 'income' ? 'default' : transaction.transactionType === 'expense' ? 'destructive' : 'secondary'}
                          className={transaction.transactionType === 'income' ? 'bg-success text-success-foreground hover:bg-success/90' : ''}
                        >
                          {TYPE_LABEL[transaction.transactionType] || transaction.transactionType}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className={`text-sm font-semibold ${
                          transaction.transactionType === 'income' ? 'text-success-strong' : transaction.transactionType === 'expense' ? 'text-destructive-strong' : 'text-muted-foreground'
                        }`}>
                          {SIGN[transaction.transactionType] || ''}₹{transaction.amount.toLocaleString('en-IN')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}