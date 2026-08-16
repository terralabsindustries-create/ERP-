import { useState, useEffect } from "react";
import { Plus, Search, Package, AlertTriangle, TrendingDown, ShoppingCart, Calculator, BarChart3, Download, DollarSign, MoreHorizontal, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CreateItemDialog } from "@/components/inventory/CreateItemDialog";
import { StockMovementDialog } from "@/components/inventory/StockMovementDialog";
import { PurchaseOrderDialog } from "@/components/inventory/PurchaseOrderDialog";
import { UnitConverterDialog } from "@/components/inventory/UnitConverterDialog";
import { InventoryAnalytics } from "@/components/inventory/InventoryAnalytics";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";

// Auto-calculated from quantity vs. minimum stock — independent of the item's
// lifecycle `status` field (active/inactive/discontinued), which is a different concept.
function getStockStatus(item: any): "critical" | "low" | "adequate" {
  const current = item.quantity || 0;
  const minimum = item.minStockLevel || item.min_stock_level || 0;
  if (current <= minimum / 2) return "critical";
  if (current <= minimum) return "low";
  return "adequate";
}

const stockStatusConfig = {
  adequate: { label: "Adequate", variant: "success" as const },
  low: { label: "Low Stock", variant: "warning" as const },
  critical: { label: "Critical", variant: "destructive" as const },
};

export default function Inventory() {
  const [inventory, setInventory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    fetchInventory();
  }, []);

  const fetchInventory = async () => {
    setLoading(true);
    try {
      const response = await apiClient.getInventory();
      console.log('📦 Inventory response:', response);
      setInventory(response || []);
    } catch (error) {
      console.error('Error fetching inventory:', error);
      toast({
        title: "Error",
        description: "Failed to fetch inventory",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; item: any | null }>({ open: false, item: null });

  const confirmDeleteItem = async () => {
    if (!deleteDialog.item) return;
    const { item } = deleteDialog;
    try {
      await apiClient.deleteInventoryItem(item._id || item.id);
      toast({
        title: "Item Deleted",
        description: `"${item.name}" has been removed from inventory`,
      });
      fetchInventory();
    } catch (error) {
      console.error("Error deleting item:", error);
      toast({
        title: "Error",
        description: "Failed to delete inventory item",
        variant: "destructive",
      });
    } finally {
      setDeleteDialog({ open: false, item: null });
    }
  };

  const [restockDialog, setRestockDialog] = useState<{ open: boolean; item: any | null }>({ open: false, item: null });
  const [restockQty, setRestockQty] = useState("10");
  const [restockLoading, setRestockLoading] = useState(false);

  const openRestockDialog = (item: any) => {
    setRestockQty("10");
    setRestockDialog({ open: true, item });
  };

  const handleRestock = async () => {
    if (!restockDialog.item) return;
    const qty = parseInt(restockQty, 10);
    if (!qty || qty <= 0) {
      toast({ title: "Error", description: "Enter a quantity greater than 0", variant: "destructive" });
      return;
    }
    setRestockLoading(true);
    try {
      const item = restockDialog.item;
      const newQuantity = (item.quantity || 0) + qty;
      await apiClient.adjustInventory(item._id || item.id, newQuantity, "Quick restock", `Added ${qty} units`);
      toast({ title: "Restock Complete", description: `Added ${qty} units to ${item.name}` });
      setRestockDialog({ open: false, item: null });
      fetchInventory();
    } catch (error) {
      console.error('Error restocking:', error);
      toast({ title: "Error", description: "Failed to restock item", variant: "destructive" });
    } finally {
      setRestockLoading(false);
    }
  };

  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showStockDialog, setShowStockDialog] = useState(false);
  const [showPurchaseDialog, setShowPurchaseDialog] = useState(false);
  const [showConverterDialog, setShowConverterDialog] = useState(false);

  const filteredInventory = inventory.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (item.category || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (item.sku || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = categoryFilter === "all" || item.category === categoryFilter;
    const matchesStatus = statusFilter === "all" || getStockStatus(item) === statusFilter;

    return matchesSearch && matchesCategory && matchesStatus;
  });

  // Calculate inventory statistics
  const totalValue = inventory.reduce((sum, item) => sum + ((item.quantity || 0) * (item.unitCost || item.unit_cost || 0)), 0);
  const lowStockItems = inventory.filter(item => (item.quantity || 0) <= (item.minStockLevel || item.min_stock_level || 0)).length;
  const criticalItems = inventory.filter(item => (item.quantity || 0) <= ((item.minStockLevel || item.min_stock_level || 0) * 0.5)).length;

  const exportInventoryAudit = async () => {
    try {
      const csvContent = "data:text/csv;charset=utf-8," + 
        "Name,Category,SKU,Quantity,Unit Cost,Min Stock,Supplier,Location\n" +
        inventory.map(item => 
          `"${item.name}","${item.category || ''}","${item.sku || ''}",${item.quantity || 0},${item.unitCost || item.unit_cost || 0},${item.minStockLevel || item.min_stock_level || 0},"${item.supplier || ''}","${item.location || ''}"`
        ).join("\n");

      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `inventory_audit_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      toast({
        title: "Export Complete",
        description: "Inventory audit has been exported to CSV",
      });
    } catch (error) {
      console.error('Error exporting inventory:', error);
      toast({
        title: "Export Failed",
        description: "Failed to export inventory audit",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Inventory Management</h1>
          <p className="text-muted-foreground text-sm">Track materials with auto-deduction, purchase orders, and analytics</p>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <MoreHorizontal className="h-4 w-4" />
                More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setShowStockDialog(true)}>
                <Package className="h-4 w-4 mr-2" />
                Stock Movement
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowPurchaseDialog(true)}>
                <ShoppingCart className="h-4 w-4 mr-2" />
                Purchase Order
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowConverterDialog(true)}>
                <Calculator className="h-4 w-4 mr-2" />
                Unit Converter
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={exportInventoryAudit}>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            Add Item
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Package className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Items</p>
              <p className="text-xl font-bold">{inventory.length}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <DollarSign className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Inventory Value</p>
              <p className="text-xl font-bold">₹{totalValue.toLocaleString()}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-warning" />
            <div>
              <p className="text-xs text-muted-foreground">Low Stock</p>
              <p className="text-xl font-bold text-warning">{lowStockItems}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <TrendingDown className="w-5 h-5 text-destructive" />
            <div>
              <p className="text-xs text-muted-foreground">Critical Stock</p>
              <p className="text-xl font-bold text-destructive">{criticalItems}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center space-x-4 flex-wrap gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search inventory..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>

        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="Materials">Materials</SelectItem>
            <SelectItem value="Paper">Paper</SelectItem>
            <SelectItem value="Consumables">Consumables</SelectItem>
            <SelectItem value="Equipment">Equipment</SelectItem>
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="adequate">Adequate</SelectItem>
            <SelectItem value="low">Low Stock</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Main Content with Tabs */}
      <Tabs defaultValue="inventory" className="space-y-6">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="inventory" className="gap-2">
            <Package className="h-4 w-4" />
            Inventory Items
          </TabsTrigger>
          <TabsTrigger value="analytics" className="gap-2">
            <BarChart3 className="h-4 w-4" />
            Analytics & Reports
          </TabsTrigger>
        </TabsList>

        <TabsContent value="inventory" className="space-y-6">
          {/* Inventory Table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">All Inventory</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
                  Loading inventory...
                </div>
              ) : filteredInventory.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                  <Package className="h-10 w-10 text-muted-foreground opacity-40" />
                  <h3 className="text-lg font-semibold">No inventory items found</h3>
                  <p className="text-muted-foreground text-sm max-w-sm">
                    {searchTerm || categoryFilter !== "all" || statusFilter !== "all"
                      ? "Try adjusting your search or filter criteria"
                      : "Start by adding your first inventory item"
                    }
                  </p>
                  <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
                    <Plus className="h-4 w-4" />
                    Add First Item
                  </Button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-4 py-3 font-medium">Item</th>
                        <th className="text-left px-4 py-3 font-medium">Category</th>
                        <th className="text-left px-4 py-3 font-medium">Stock</th>
                        <th className="text-left px-4 py-3 font-medium">Min Stock</th>
                        <th className="text-left px-4 py-3 font-medium">Unit Cost</th>
                        <th className="text-left px-4 py-3 font-medium">Total Value</th>
                        <th className="text-left px-4 py-3 font-medium">Supplier / Location</th>
                        <th className="px-4 py-3 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredInventory.map((item) => {
                        const itemId = item._id || item.id;
                        const status = getStockStatus(item);
                        const statusCfg = stockStatusConfig[status];
                        const unitCost = item.unitCost || item.unit_cost || 0;
                        const itemValue = (item.quantity || 0) * unitCost;

                        return (
                          <tr key={itemId} className="border-b hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-3">
                              <div className="font-medium">{item.name}</div>
                              {item.sku && <div className="text-xs text-muted-foreground font-mono">SKU: {item.sku}</div>}
                            </td>
                            <td className="px-4 py-3">
                              <Badge variant="outline">{item.category || "Uncategorized"}</Badge>
                            </td>
                            <td className="px-4 py-3">
                              <div className="font-medium">{item.quantity || 0} units</div>
                              <Badge variant={statusCfg.variant} className="mt-1">{statusCfg.label}</Badge>
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {item.minStockLevel || item.min_stock_level || 0} units
                            </td>
                            <td className="px-4 py-3">₹{unitCost.toLocaleString()}</td>
                            <td className="px-4 py-3 font-medium">₹{itemValue.toLocaleString()}</td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {item.supplier || "-"}
                              {item.location && <div className="text-xs">{item.location}</div>}
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
                                  <DropdownMenuItem onClick={() => openRestockDialog(item)}>
                                    <RefreshCw className="h-4 w-4 mr-2" />
                                    Restock
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => setDeleteDialog({ open: true, item })}
                                    className="text-destructive focus:text-destructive"
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    Delete
                                  </DropdownMenuItem>
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
        </TabsContent>

        <TabsContent value="analytics">
          <InventoryAnalytics />
        </TabsContent>
      </Tabs>

      {/* Restock Dialog */}
      <Dialog open={restockDialog.open} onOpenChange={(open) => !open && setRestockDialog({ open: false, item: null })}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Restock Item
            </DialogTitle>
            <DialogDescription>
              {restockDialog.item && `Add stock to "${restockDialog.item.name}"`}
            </DialogDescription>
          </DialogHeader>
          {restockDialog.item && (
            <div className="space-y-4">
              <div className="rounded-md bg-muted px-3 py-2 text-sm flex justify-between">
                <span className="text-muted-foreground">Current stock</span>
                <span className="font-medium">{restockDialog.item.quantity || 0} units</span>
              </div>
              <div className="space-y-2">
                <Label htmlFor="restock-qty">Quantity to add</Label>
                <Input
                  id="restock-qty"
                  type="number"
                  min="1"
                  value={restockQty}
                  onChange={(e) => setRestockQty(e.target.value)}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestockDialog({ open: false, item: null })}>
              Cancel
            </Button>
            <Button onClick={handleRestock} disabled={restockLoading} className="gap-2">
              <Plus className="h-4 w-4" />
              {restockLoading ? "Adding..." : "Add Stock"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialog.open} onOpenChange={(open) => !open && setDeleteDialog({ open: false, item: null })}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete Item
            </DialogTitle>
            <DialogDescription>
              {deleteDialog.item && `Are you sure you want to delete "${deleteDialog.item.name}" from inventory? This action cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setDeleteDialog({ open: false, item: null })}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDeleteItem} className="gap-2">
              <Trash2 className="h-4 w-4" />
              Delete Item
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialogs */}
      <CreateItemDialog
        open={showCreateDialog} 
        onOpenChange={setShowCreateDialog}
        onItemCreated={fetchInventory}
      />
      <StockMovementDialog 
        open={showStockDialog} 
        onOpenChange={setShowStockDialog}
      />
      <PurchaseOrderDialog 
        open={showPurchaseDialog} 
        onOpenChange={setShowPurchaseDialog}
        onOrderCreated={fetchInventory}
      />
      <UnitConverterDialog 
        open={showConverterDialog} 
        onOpenChange={setShowConverterDialog}
      />
    </div>
  );
}