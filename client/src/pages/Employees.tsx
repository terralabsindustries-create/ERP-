import { useState, useEffect } from "react";
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, SearchField, Stack, StatusPill, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { fmtDate, formatINR, plural } from "@/lib/format";

const emptyEmployee = () => ({
  name: "", email: "", phone: "", gender: "", dateOfBirth: "", address: "",
  designation: "", department: "", dateOfJoining: "", employmentType: "full-time", status: "active",
  salary: { basic: 0, hra: 0, allowances: 0, specialAllowance: 0 },
  deductions: { pf: 0, professionalTax: 0, esi: 0, other: 0 },
  bankDetails: { accountName: "", accountNumber: "", ifscCode: "", bankName: "", upiId: "" },
  panNumber: "", aadhaarNumber: "", pfNumber: "", notes: "",
});

const inr = (n: number) =>
  "₹" + (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Employees() {
  const [employees, setEmployees] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<any>(emptyEmployee());
  const [saving, setSaving] = useState(false);
  const [department, setDepartment] = useState("all");
  const [deleting, setDeleting] = useState<any>(null);
  const { toast } = useToast();

  useEffect(() => { fetchAll(); }, []);
  useEffect(() => {
    const t = setTimeout(fetchEmployees, 300);
    return () => clearTimeout(t);
  }, [search, statusFilter]);

  const fetchAll = async () => { await Promise.all([fetchEmployees(), fetchStats()]); };

  const fetchEmployees = async () => {
    try {
      const params: any = {};
      if (search) params.search = search;
      if (statusFilter !== "all") params.status = statusFilter;
      const res: any = await apiClient.getEmployees(params);
      setEmployees(res.employees || []);
    } catch (e) {
      console.error(e);
      toast({ title: "Error", description: "Failed to load employees", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const res: any = await apiClient.getEmployeeStats();
      setStats(res || {});
    } catch (e) { console.error(e); }
  };

  const openCreate = () => { setEditing(null); setForm(emptyEmployee()); setDialogOpen(true); };
  const openEdit = (emp: any) => {
    setEditing(emp);
    setForm({
      ...emptyEmployee(),
      ...emp,
      dateOfBirth: emp.dateOfBirth ? emp.dateOfBirth.substring(0, 10) : "",
      dateOfJoining: emp.dateOfJoining ? emp.dateOfJoining.substring(0, 10) : "",
      salary: { ...emptyEmployee().salary, ...(emp.salary || {}) },
      deductions: { ...emptyEmployee().deductions, ...(emp.deductions || {}) },
      bankDetails: { ...emptyEmployee().bankDetails, ...(emp.bankDetails || {}) },
    });
    setDialogOpen(true);
  };

  const gross = (form.salary?.basic || 0) + (form.salary?.hra || 0) + (form.salary?.allowances || 0) + (form.salary?.specialAllowance || 0);
  const totalDed = (form.deductions?.pf || 0) + (form.deductions?.professionalTax || 0) + (form.deductions?.esi || 0) + (form.deductions?.other || 0);
  const net = gross - totalDed;

  const save = async () => {
    if (!form.name.trim()) {
      toast({ title: "Name required", description: "Please enter the employee name", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form };
      if (!payload.dateOfBirth) delete payload.dateOfBirth;
      if (!payload.dateOfJoining) delete payload.dateOfJoining;
      if (editing) {
        await apiClient.updateEmployee(editing._id || editing.id, payload);
        toast({ title: "Updated", description: "Employee updated successfully" });
      } else {
        await apiClient.createEmployee(payload);
        toast({ title: "Created", description: "Employee added successfully" });
      }
      setDialogOpen(false);
      fetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message || "Failed to save employee", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const emp = deleting;
    if (!emp) return;
    try {
      const response: any = await apiClient.deleteEmployee(emp._id || emp.id);
      toast({ title: "Deleted", description: response?.message || "Employee removed" });
      setDeleting(null);
      fetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message || "Failed to delete", variant: "destructive" });
      throw e;
    }
  };

  const setSalary = (k: string, v: string) => setForm({ ...form, salary: { ...form.salary, [k]: Number(v) || 0 } });
  const setDed = (k: string, v: string) => setForm({ ...form, deductions: { ...form.deductions, [k]: Number(v) || 0 } });
  const setBank = (k: string, v: string) => setForm({ ...form, bankDetails: { ...form.bankDetails, [k]: v } });

  const STATUS: Record<string, { label: string; tone: PillTone }> = {
    active: { label: "Active", tone: "success" },
    "on-leave": { label: "On leave", tone: "warning" },
    inactive: { label: "Inactive", tone: "neutral" },
    terminated: { label: "Left", tone: "danger" }
  };
  const TYPE: Record<string, string> = { "full-time": "Full-time", "part-time": "Part-time", contract: "Contract", intern: "Intern" };
  const seesSalary = employees.some((e) => e.netSalary !== undefined);
  const departments = Array.from(new Set(employees.map((e) => e.department).filter(Boolean))).sort() as string[];
  const rows = employees.filter((e) => department === "all" || e.department === department);

  const columns: Column<any>[] = [
    {
      id: "name",
      header: "Employee",
      cell: (e) => <EntityCell avatar={e.name} title={e.name} subtitle={e.email || e.phone} />,
      sortValue: (e) => (e.name || "").toLowerCase(),
      className: "min-w-[220px]"
    },
    { id: "code", header: "Code", cell: (e) => <span className="font-mono text-xs">{e.employeeCode || "—"}</span>, sortValue: (e) => e.employeeCode || "", hideBelow: "lg" },
    { id: "role", header: "Role", cell: (e) => <Stack top={e.designation || "—"} bottom={e.department} />, sortValue: (e) => e.designation || "" },
    { id: "type", header: "Type", cell: (e) => TYPE[e.employmentType] || e.employmentType || "—", hideBelow: "xl" },
    { id: "joined", header: "Joined", cell: (e) => <span className="whitespace-nowrap">{fmtDate(e.dateOfJoining)}</span>, sortValue: (e) => e.dateOfJoining || "", hideBelow: "lg" },
    ...(seesSalary
      ? [{ id: "net", header: "Net / month", align: "right" as const, cell: (e: any) => <span className="font-medium">{inr(e.netSalary)}</span>, sortValue: (e: any) => e.netSalary || 0 }]
      : []),
    {
      id: "status",
      header: "Status",
      cell: (e) => {
        const st = STATUS[e.status] || { label: e.status, tone: "neutral" as PillTone };
        return <StatusPill tone={st.tone}>{st.label}</StatusPill>;
      },
      sortValue: (e) => e.status,
      className: "w-[110px]"
    }
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="People"
        title="Employees"
        description="Everyone on the payroll — role, department, salary structure and bank details."
        actions={
          <Button onClick={openCreate}>
            <Plus />
            Add employee
          </Button>
        }
      />

      <MetricBar
        loading={loading}
        metrics={[
          { label: "Employees", value: stats.total ?? 0, hint: `${stats.active ?? 0} active` },
          { label: "On leave", value: employees.filter((e) => e.status === "on-leave").length, hint: "Marked on leave", tone: "warning" },
          { label: "Departments", value: stats.departments ?? departments.length, hint: departments.slice(0, 3).join(" · ") || "—" },
          ...(stats.monthlyPayroll !== null && stats.monthlyPayroll !== undefined
            ? [{ label: "Monthly payroll", value: formatINR(stats.monthlyPayroll, { compact: stats.monthlyPayroll >= 1e5 }), hint: "Net pay of active staff", tone: "info" as const }]
            : [])
        ]}
      />

      <div className="space-y-4">
        <ViewTabs
          value={statusFilter}
          onChange={setStatusFilter}
          tabs={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "on-leave", label: "On leave" },
            { value: "inactive", label: "Inactive" },
            { value: "terminated", label: "Left" }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search name, code or designation" />}>
              {departments.length > 1 && <FilterSelect label="Department" value={department} onChange={setDepartment} options={departments.map((d) => ({ value: d, label: d }))} />}
            </Toolbar>
          }
          footer={!loading && rows.length > 0 && plural(rows.length, "employee")}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(e) => e._id || e.id}
            loading={loading}
            onRowClick={openEdit}
            actions={(e) => [
              { label: "Edit employee", icon: Pencil, onClick: () => openEdit(e) },
              { label: "Delete employee", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(e) }
            ]}
            actionsLabel={(e) => `Actions for ${e.name}`}
            defaultSort={{ id: "name", dir: "asc" }}
            mobile={(e) => (
              <div className="flex items-start justify-between gap-3">
                <EntityCell avatar={e.name} title={e.name} subtitle={[e.designation, e.department].filter(Boolean).join(" · ") || e.phone} />
                <StatusPill tone={(STATUS[e.status] || { tone: "neutral" }).tone as PillTone}>{(STATUS[e.status] || { label: e.status }).label}</StatusPill>
              </div>
            )}
            empty={
              search || statusFilter !== "all" ? (
                <EmptyState compact icon={Users} title="No employees in this view" />
              ) : (
                <EmptyState
                  icon={Users}
                  title="No employees yet"
                  description="Add the people on your payroll, with their salary structure, to run payroll and track attendance."
                  action={
                    <Button onClick={openCreate}>
                      <Plus />
                      Add employee
                    </Button>
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : "Add Employee"}</DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="personal" className="w-full">
            <TabsList className="grid grid-cols-3 w-full">
              <TabsTrigger value="personal">Personal & Job</TabsTrigger>
              <TabsTrigger value="salary">Salary</TabsTrigger>
              <TabsTrigger value="bank">Bank & IDs</TabsTrigger>
            </TabsList>

            <TabsContent value="personal" className="space-y-4 pt-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Full Name *"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
                <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
                <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
                <Field label="Gender">
                  <Select value={form.gender || "none"} onValueChange={(v) => setForm({ ...form, gender: v === "none" ? "" : v })}>
                    <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">—</SelectItem>
                      <SelectItem value="male">Male</SelectItem>
                      <SelectItem value="female">Female</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Date of Birth"><Input type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} /></Field>
                <Field label="Date of Joining"><Input type="date" value={form.dateOfJoining} onChange={(e) => setForm({ ...form, dateOfJoining: e.target.value })} /></Field>
                <Field label="Designation"><Input value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} /></Field>
                <Field label="Department"><Input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></Field>
                <Field label="Employment Type">
                  <Select value={form.employmentType} onValueChange={(v) => setForm({ ...form, employmentType: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full-time">Full-time</SelectItem>
                      <SelectItem value="part-time">Part-time</SelectItem>
                      <SelectItem value="contract">Contract</SelectItem>
                      <SelectItem value="intern">Intern</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Status">
                  <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="inactive">Inactive</SelectItem>
                      <SelectItem value="on-leave">On Leave</SelectItem>
                      <SelectItem value="terminated">Terminated</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label="Address"><Textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
            </TabsContent>

            <TabsContent value="salary" className="space-y-4 pt-3">
              <p className="text-sm font-medium text-muted-foreground">Monthly Earnings</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Basic"><Input type="number" placeholder="0" value={form.salary.basic || ""} onChange={(e) => setSalary("basic", e.target.value)} /></Field>
                <Field label="HRA"><Input type="number" placeholder="0" value={form.salary.hra || ""} onChange={(e) => setSalary("hra", e.target.value)} /></Field>
                <Field label="Allowances"><Input type="number" placeholder="0" value={form.salary.allowances || ""} onChange={(e) => setSalary("allowances", e.target.value)} /></Field>
                <Field label="Special Allowance"><Input type="number" placeholder="0" value={form.salary.specialAllowance || ""} onChange={(e) => setSalary("specialAllowance", e.target.value)} /></Field>
              </div>
              <p className="text-sm font-medium text-muted-foreground pt-2">Monthly Deductions</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Provident Fund (PF)"><Input type="number" placeholder="0" value={form.deductions.pf || ""} onChange={(e) => setDed("pf", e.target.value)} /></Field>
                <Field label="Professional Tax"><Input type="number" placeholder="0" value={form.deductions.professionalTax || ""} onChange={(e) => setDed("professionalTax", e.target.value)} /></Field>
                <Field label="ESI"><Input type="number" placeholder="0" value={form.deductions.esi || ""} onChange={(e) => setDed("esi", e.target.value)} /></Field>
                <Field label="Other Deductions"><Input type="number" placeholder="0" value={form.deductions.other || ""} onChange={(e) => setDed("other", e.target.value)} /></Field>
              </div>
              <div className="rounded-lg bg-muted p-4 grid grid-cols-3 gap-2 text-center">
                <div><div className="text-xs text-muted-foreground">Gross</div><div className="font-semibold">{inr(gross)}</div></div>
                <div><div className="text-xs text-muted-foreground">Deductions</div><div className="font-semibold">{inr(totalDed)}</div></div>
                <div><div className="text-xs text-muted-foreground">Net / month</div><div className="font-bold text-primary">{inr(net)}</div></div>
              </div>
            </TabsContent>

            <TabsContent value="bank" className="space-y-4 pt-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Account Holder Name"><Input value={form.bankDetails.accountName} onChange={(e) => setBank("accountName", e.target.value)} /></Field>
                <Field label="Account Number"><Input value={form.bankDetails.accountNumber} onChange={(e) => setBank("accountNumber", e.target.value)} /></Field>
                <Field label="IFSC Code"><Input value={form.bankDetails.ifscCode} onChange={(e) => setBank("ifscCode", e.target.value)} /></Field>
                <Field label="Bank Name"><Input value={form.bankDetails.bankName} onChange={(e) => setBank("bankName", e.target.value)} /></Field>
                <Field label="UPI ID"><Input value={form.bankDetails.upiId} onChange={(e) => setBank("upiId", e.target.value)} /></Field>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="PAN Number"><Input value={form.panNumber} onChange={(e) => setForm({ ...form, panNumber: e.target.value })} /></Field>
                <Field label="Aadhaar Number"><Input value={form.aadhaarNumber} onChange={(e) => setForm({ ...form, aadhaarNumber: e.target.value })} /></Field>
                <Field label="PF Number"><Input value={form.pfNumber} onChange={(e) => setForm({ ...form, pfNumber: e.target.value })} /></Field>
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : editing ? "Update" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description={
          deleting?.linkedUserId
            ? `Their login is removed as well, freeing ${deleting.email} to be invited again. Payroll and attendance history go with the record. This can't be undone.`
            : "Payroll and attendance history go with the record. This can't be undone."
        }
        onConfirm={remove}
      />
    </PageShell>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
