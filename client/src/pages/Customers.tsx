import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Search, Plus, Users, Building2, User, Edit, Tag, DollarSign, AlertTriangle, CheckCircle, Download, FileText, Briefcase, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";
import { EditCustomerDialog } from "@/components/customers/EditCustomerDialog";
import { CreateJobDialog } from "@/components/jobs/CreateJobDialog";
import apiClient from "@/lib/apiClient";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { exportToCSV, formatCustomersForExport } from "@/utils/exportUtils";

interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  company: string | null;
  notes: string | null;
  gstNumber: string | null;
  customerType: string;
  tags: string[];
  status: string;
  createdAt: string;
  totalSpent: number;
  totalRevenue: number;
  totalOrders: number;
  lastOrderDate: string | null;
  lastPaymentDate: string | null;
  lastPaymentAmount: number;
  paymentStatus: string;
  isBlacklisted: boolean;
  blacklistReason: string | null;
  gstVerified: boolean;
  outstandingBalance: number;
  creditLimit: number;
  preferredJobTypes: string[];
}

export default function Customers() {
  const { user, hasPermission } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get("q") || "");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [filterTag, setFilterTag] = useState("all");
  const [filterGST, setFilterGST] = useState("all");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showCreateJobDialog, setShowCreateJobDialog] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedCustomerForJob, setSelectedCustomerForJob] = useState<Customer | null>(null);

  const fetchCustomers = async () => {
    if (!user) return;

    try {
      const response = await apiClient.getCustomer({ status: 'all', limit: 100 });
      console.log('👥 Customers response:', response);
      const customersData = (response as any)?.data?.customers || (response as any)?.customers || [];
      console.log('👥 Processed customers:', customersData);
      console.log('👥 Customers count:', customersData.length);
      // Map customers to ensure consistent ID field (handle both id and _id)
      const mappedCustomers = customersData.map((customer: any) => ({
        ...customer,
        id: customer.id || customer._id
      }));
      setCustomers(mappedCustomers);
    } catch (error: any) {
      console.error('Error fetching customers:', error);
      toast({
        title: "Error fetching customers",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCustomers();
  }, [user]);

  const filteredCustomers = customers.filter((customer) => {
    // Enhanced search with partial matching
    const searchLower = searchTerm.toLowerCase();
    const matchesSearch = 
      customer.name.toLowerCase().includes(searchLower) ||
      (customer.phone && customer.phone.includes(searchTerm)) ||
      (customer.email && customer.email.toLowerCase().includes(searchLower)) ||
      (customer.company && customer.company.toLowerCase().includes(searchLower)) ||
      (customer.gstNumber && customer.gstNumber.toLowerCase().includes(searchLower)) ||
      // Partial phone number matching
      (customer.phone && customer.phone.replace(/\D/g, '').includes(searchTerm.replace(/\D/g, ''))) ||
      // Partial name matching (supports "john doe" finding "John M. Doe")
      searchTerm.split(' ').every(term => 
        customer.name.toLowerCase().includes(term.toLowerCase())
      );
    
    const matchesFilter = filterStatus === "all" || customer.status === filterStatus;
    const matchesType = filterType === "all" || customer.customerType === filterType;
    const matchesTag = filterTag === "all" || (customer.tags && customer.tags.includes(filterTag));
    
    // GST status filtering
    const matchesGST = filterGST === "all" || (() => {
      switch (filterGST) {
        case "verified": return customer.gstVerified;
        case "unverified": return customer.gstNumber && !customer.gstVerified;
        case "none": return !customer.gstNumber;
        default: return true;
      }
    })();
    
    return matchesSearch && matchesFilter && matchesType && matchesTag && matchesGST;
  });

  const handleEditCustomer = (customer: Customer) => {
    setSelectedCustomer(customer);
    // EditCustomerDialog manages its own open state
  };

  const handleCreateJob = (customer: Customer) => {
    setSelectedCustomerForJob(customer);
    setShowCreateJobDialog(true);
  };

  const handleJobCreated = () => {
    setShowCreateJobDialog(false);
    setSelectedCustomerForJob(null);
    toast({
      title: "Job Created Successfully",
      description: `Job created for ${selectedCustomerForJob?.name}`,
    });
    // Navigate to jobs section
    navigate('/jobs');
  };

  const getCustomerType = (customer: Customer) => {
    return customer.customerType || "Individual";
  };

  const getTypeConfig = (type: string) => {
    const configs = {
      "Individual": { variant: "secondary" as const, icon: User },
      "Business": { variant: "default" as const, icon: Building2 },
      "Corporate": { variant: "default" as const, icon: Building2 },
      "Walk-in": { variant: "secondary" as const, icon: User },
    };
    return configs[type as keyof typeof configs] || configs["Individual"];
  };

  const getPaymentStatusConfig = (status: string) => {
    const configs = {
      "current": { variant: "success" as const, label: "Current" },
      "due": { variant: "warning" as const, label: "Due" },
      "advance_paid": { variant: "default" as const, label: "Advance Paid" },
      "overdue": { variant: "destructive" as const, label: "Overdue" },
    };
    return configs[status as keyof typeof configs] || configs["current"];
  };

  const stats = {
    total: customers.length,
    business: customers.filter(c => c.customerType === "Business" || c.customerType === "Corporate").length,
    individual: customers.filter(c => c.customerType === "Individual" || c.customerType === "Walk-in").length,
    active: customers.filter(c => c.status === "active").length,
    withGST: customers.filter(c => c.gstNumber).length,
    blacklisted: customers.filter(c => c.isBlacklisted).length,
    highValue: customers.filter(c => (c.totalRevenue || 0) >= 50000).length,
    totalRevenue: customers.reduce((sum, c) => sum + (c.totalRevenue || 0), 0),
    outstanding: customers.reduce((sum, c) => sum + (c.outstandingBalance || 0), 0),
  };

  // Get all unique tags for filter
  const allTags = Array.from(new Set(customers.flatMap(c => c.tags || [])));

  // Export functions
  const handleExportCSV = () => {
    try {
      const exportData = formatCustomersForExport(filteredCustomers);
      exportToCSV(exportData, `customers_export_${new Date().toISOString().split('T')[0]}`);
      toast({
        title: "Export Successful",
        description: `Exported ${filteredCustomers.length} customers to CSV`,
      });
    } catch (error: any) {
      toast({
        title: "Export Failed",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleExportAll = () => {
    try {
      const exportData = formatCustomersForExport(customers);
      exportToCSV(exportData, `all_customers_export_${new Date().toISOString().split('T')[0]}`);
      toast({
        title: "Export Successful",
        description: `Exported ${customers.length} customers to CSV`,
      });
    } catch (error: any) {
      toast({
        title: "Export Failed",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Customer Management</h1>
          <p className="text-muted-foreground text-sm">
            Manage your clients and track their information
          </p>
        </div>
        {user ? (
          <div className="flex items-center gap-2">
            {hasPermission("Customers: Export") && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="gap-2">
                    <MoreHorizontal className="h-4 w-4" />
                    More
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Export</DropdownMenuLabel>
                  <DropdownMenuItem onClick={handleExportCSV} disabled={filteredCustomers.length === 0}>
                    <Download className="h-4 w-4 mr-2" />
                    Export Filtered ({filteredCustomers.length})
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportAll} disabled={customers.length === 0}>
                    <FileText className="h-4 w-4 mr-2" />
                    Export All ({customers.length})
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {hasPermission("Customers: Create & Edit") && (
              <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
                <Plus className="w-4 h-4" />
                Add Customer
              </Button>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Please log in to add customers</div>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Users className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Customers</p>
              <p className="text-xl font-bold">{stats.total}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Building2 className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Business Clients</p>
              <p className="text-xl font-bold">{stats.business}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <User className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Individual</p>
              <p className="text-xl font-bold">{stats.individual}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <DollarSign className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Revenue</p>
              <p className="text-xl font-bold">₹{stats.totalRevenue.toLocaleString()}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">High Value (≥₹50K)</p>
              <p className="text-xl font-bold">{stats.highValue}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Enhanced Search and Filters */}
      <div className="flex items-center space-x-4 flex-wrap gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, phone, email, company, or GST..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
        
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="Individual">Individual</SelectItem>
            <SelectItem value="Business">Business</SelectItem>
            <SelectItem value="Corporate">Corporate</SelectItem>
            <SelectItem value="Walk-in">Walk-in</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterGST} onValueChange={setFilterGST}>
          <SelectTrigger className="w-[140px]">
            <CheckCircle className="h-4 w-4 mr-2" />
            <SelectValue placeholder="GST Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All GST</SelectItem>
            <SelectItem value="verified">Verified</SelectItem>
            <SelectItem value="unverified">Unverified</SelectItem>
            <SelectItem value="none">No GST</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterTag} onValueChange={setFilterTag}>
          <SelectTrigger className="w-[140px]">
            <Tag className="h-4 w-4 mr-2" />
            <SelectValue placeholder="Tags" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tags</SelectItem>
            {allTags.map((tag) => (
              <SelectItem key={tag} value={tag}>{tag}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Customer Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">All Customers</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
              Loading customers...
            </div>
          ) : filteredCustomers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <Users className="h-10 w-10 text-muted-foreground opacity-40" />
              <h3 className="text-lg font-semibold">
                {customers.length === 0 ? "No customers yet" : "No customers found"}
              </h3>
              <p className="text-muted-foreground text-sm max-w-sm">
                {customers.length === 0
                  ? "Add your first customer to get started"
                  : "Try adjusting your search or filter criteria"
                }
              </p>
              {customers.length === 0 && hasPermission("Customers: Create & Edit") && (
                <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Add Your First Customer
                </Button>
              )}
              {customers.length > 0 && (
                <Button variant="outline" onClick={() => {
                  setSearchTerm("");
                  setFilterStatus("all");
                }}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-3 font-medium">Customer</th>
                    <th className="text-left px-4 py-3 font-medium">Contact</th>
                    <th className="text-left px-4 py-3 font-medium">Type</th>
                    <th className="text-left px-4 py-3 font-medium">GST</th>
                    <th className="text-left px-4 py-3 font-medium">Activity</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map((customer) => {
                    const customerType = getCustomerType(customer);
                    const typeConfig = getTypeConfig(customerType);
                    const paymentConfig = getPaymentStatusConfig(customer.paymentStatus);

                    return (
                      <tr key={customer.id} className="border-b hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{customer.name}</span>
                            {customer.isBlacklisted && (
                              <Badge variant="destructive" className="gap-1 text-[10px] px-1.5 py-0">
                                <AlertTriangle className="h-3 w-3" />
                                Blacklisted
                              </Badge>
                            )}
                          </div>
                          {customer.company && (
                            <div className="text-xs text-muted-foreground">{customer.company}</div>
                          )}
                          {customer.tags && customer.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {customer.tags.map((tag) => (
                                <Badge
                                  key={tag}
                                  variant={tag === "Blacklisted" ? "destructive" : "outline"}
                                  className="text-[10px] px-1.5 py-0"
                                >
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {customer.phone && <div>{customer.phone}</div>}
                          {customer.email && <div className="text-xs">{customer.email}</div>}
                          {!customer.phone && !customer.email && "-"}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={typeConfig.variant} className="gap-1">
                            <typeConfig.icon className="h-3 w-3" />
                            {customerType}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          {customer.gstNumber ? (
                            <span className="font-mono text-xs flex items-center gap-1">
                              {customer.gstNumber}
                              {customer.gstVerified && <CheckCircle className="h-3 w-3 text-success" />}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div>{customer.totalOrders || 0} orders</div>
                          <div className="text-xs text-muted-foreground">
                            ₹{(customer.totalRevenue || 0).toLocaleString()} revenue
                          </div>
                          {customer.outstandingBalance > 0 && (
                            <div className="text-xs text-warning">
                              Outstanding: ₹{customer.outstandingBalance.toLocaleString()}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={customer.status === "active" ? "success" : "secondary"}>
                            {customer.status}
                          </Badge>
                          {customer.paymentStatus !== 'current' && (
                            <Badge variant={paymentConfig.variant} className="mt-1">
                              {paymentConfig.label}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              {hasPermission("Customers: Create & Edit") && (
                                <DropdownMenuItem onClick={() => handleEditCustomer(customer)}>
                                  <Edit className="h-4 w-4 mr-2" />
                                  Edit
                                </DropdownMenuItem>
                              )}
                              {hasPermission("Jobs: Create & Edit") && (
                                <DropdownMenuItem onClick={() => handleCreateJob(customer)}>
                                  <Briefcase className="h-4 w-4 mr-2" />
                                  Create Job
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* Create and Edit Customer Dialogs */}
      <CreateCustomerDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCustomerCreated={fetchCustomers}
      />
      
      <EditCustomerDialog
        customer={selectedCustomer}
        onCustomerUpdated={fetchCustomers}
        onCustomerDeleted={fetchCustomers}
      />

      {/* Create Job Dialog */}
      <CreateJobDialog
        open={showCreateJobDialog}
        onOpenChange={setShowCreateJobDialog}
        onJobCreated={handleJobCreated}
        customers={customers}
        preselectedCustomer={selectedCustomerForJob}
      />
    </div>
  );
}