import { useState, useEffect } from "react";
import { Plus, Search, Building, Building2, Phone, Mail, DollarSign, Users, BarChart3, Edit } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CreateVendorDialog } from "@/components/vendors/CreateVendorDialog";
import { VendorBillDialog } from "@/components/vendors/VendorBillDialog";
import { VendorLedgerDialog } from "@/components/vendors/VendorLedgerDialog";
import { VendorPaymentDialog } from "@/components/vendors/VendorPaymentDialog";
import { VendorDialog as EditVendorDialog } from "@/components/vendors/EditVendorDialog";
import { VendorAnalytics } from "@/components/vendors/VendorAnalytics";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";

export default function Vendors() {
  const [vendors, setVendors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingVendor, setEditingVendor] = useState<any>(null);
  const { toast } = useToast();

  useEffect(() => {
    fetchVendors();
  }, []);

  const fetchVendors = async () => {
    setLoading(true);
    try {
      const response = await apiClient.getVendors();
      setVendors(response.vendors || []);
    } catch (error) {
      console.error('Error fetching vendors:', error);
      toast({
        title: "Error",
        description: "Failed to fetch vendors",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const filteredVendors = vendors.filter(vendor => 
    vendor.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (vendor.contactPerson || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (vendor.email || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (vendor.vendorType || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totalVendors = vendors.length;
  const activeVendors = vendors.filter(vendor => vendor.status === "active").length;
  const totalPendingAmount = vendors.reduce((sum, vendor) => sum + (vendor.pendingAmount || 0), 0);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Vendor Management</h1>
          <p className="text-muted-foreground text-sm">Manage suppliers and service providers</p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          Add Vendor
        </Button>
      </div>

      <Tabs defaultValue="vendors" className="space-y-6">
        <TabsList>
          <TabsTrigger value="vendors" className="gap-2">
            <Building className="h-4 w-4" />
            Vendors
          </TabsTrigger>
          <TabsTrigger value="analytics" className="gap-2">
            <BarChart3 className="h-4 w-4" />
            Analytics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="vendors" className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <Building className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Total Vendors</p>
                  <p className="text-xl font-bold">{totalVendors}</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <DollarSign className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Pending Amount</p>
                  <p className="text-xl font-bold">₹{totalPendingAmount.toLocaleString()}</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <Users className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Active Vendors</p>
                  <p className="text-xl font-bold">{activeVendors}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Search */}
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search vendors..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Vendors Table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">All Vendors</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
                  Loading vendors...
                </div>
              ) : filteredVendors.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                  <Building className="h-10 w-10 text-muted-foreground opacity-40" />
                  <h3 className="text-lg font-semibold">No vendors found</h3>
                  <p className="text-muted-foreground text-sm max-w-sm">
                    {vendors.length === 0
                      ? "Add your first vendor to get started"
                      : "No vendors match your search criteria."}
                  </p>
                  {vendors.length === 0 && (
                    <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
                      <Plus className="h-4 w-4" />
                      Add Vendor
                    </Button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-4 py-3 font-medium">Vendor</th>
                        <th className="text-left px-4 py-3 font-medium">Contact</th>
                        <th className="text-left px-4 py-3 font-medium">GST Number</th>
                        <th className="text-left px-4 py-3 font-medium">Total Amount</th>
                        <th className="text-left px-4 py-3 font-medium">Pending</th>
                        <th className="text-left px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredVendors.map((vendor) => (
                        <tr key={vendor._id} className="border-b hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-3">
                            <div className="font-medium">{vendor.name}</div>
                            <div className="text-xs text-muted-foreground capitalize">{vendor.vendorType}</div>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {vendor.contactPerson && (
                              <div className="flex items-center gap-1">
                                <Building2 className="h-3 w-3" />
                                {vendor.contactPerson}
                              </div>
                            )}
                            {vendor.phone && (
                              <div className="flex items-center gap-1 text-xs">
                                <Phone className="h-3 w-3" />
                                {vendor.phone}
                              </div>
                            )}
                            {vendor.email && (
                              <div className="flex items-center gap-1 text-xs">
                                <Mail className="h-3 w-3" />
                                {vendor.email}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">
                            {vendor.gstNumber || <span className="text-muted-foreground font-sans">Not provided</span>}
                          </td>
                          <td className="px-4 py-3 font-medium">₹{(vendor.totalAmount || 0).toLocaleString()}</td>
                          <td className="px-4 py-3">
                            <span className={(vendor.pendingAmount || 0) > 0 ? "text-warning font-medium" : "text-success"}>
                              ₹{(vendor.pendingAmount || 0).toLocaleString()}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={vendor.status === "active" ? "success" : "secondary"}>
                              {vendor.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              <VendorBillDialog
                                vendor={{ id: vendor._id || vendor.id, name: vendor.name }}
                                onBillCreated={fetchVendors}
                              />
                              <VendorLedgerDialog
                                vendor={{
                                  id: vendor._id || vendor.id,
                                  name: vendor.name,
                                  total_purchases: vendor.totalAmount || 0,
                                  pending_amount: vendor.pendingAmount || 0
                                }}
                              />
                              {(vendor.pendingAmount || 0) > 0 && (
                                <VendorPaymentDialog
                                  vendor={{
                                    id: vendor._id || vendor.id,
                                    name: vendor.name,
                                    pending_amount: vendor.pendingAmount || 0
                                  }}
                                  onPaymentMade={fetchVendors}
                                />
                              )}
                              <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => setEditingVendor(vendor)}>
                                <Edit className="h-4 w-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="analytics">
          <VendorAnalytics />
        </TabsContent>
      </Tabs>

      <EditVendorDialog
        open={!!editingVendor}
        onOpenChange={(open) => !open && setEditingVendor(null)}
        onSuccess={() => {
          setEditingVendor(null);
          fetchVendors();
        }}
        vendor={editingVendor}
      />

      <CreateVendorDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onVendorCreated={fetchVendors}
      />
    </div>
  );
}