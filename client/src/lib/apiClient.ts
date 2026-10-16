// In the Electron app the backend runs on this machine on a port picked at
// startup, so the preload hands us the address. In a browser `serpyDesktop` does
// not exist and this falls straight through to the build-time value.
const desktopApiBase = (globalThis as any).serpyDesktop?.apiBaseUrl;

export const BASE_URL =
  // TODO: switch back to production URL when done testing locally
  // desktopApiBase || import.meta.env.VITE_API_URL || 'https://serpy.synxautomate.com/api';
  desktopApiBase || import.meta.env.VITE_API_URL || 'http://localhost:4001/api';

interface ApiResponse<T = any> {
  status: 'success' | 'error';
  message?: string;
  data?: T;
  errors?: string[];
}

class ApiClient {
  private baseURL: string;
  private token: string | null = null;

  constructor(baseURL: string = BASE_URL) {
    this.baseURL = baseURL;
    this.token = localStorage.getItem('token');
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    
    // Always get the latest token from localStorage
    const currentToken = localStorage.getItem('token');

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    // Caller options first, so the merged headers (with the token) and the
    // timeout signal are not replaced by a caller's own `headers`.
    const config: RequestInit = {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(currentToken && { Authorization: `Bearer ${currentToken}` }),
        ...options.headers,
      },
      signal: controller.signal,
    };

    try {
      const response = await fetch(url, config);
      clearTimeout(timeoutId);

      // A proxy error page or an empty reply is not JSON; report it plainly.
      let data: ApiResponse<T>;
      try {
        data = await response.json();
      } catch {
        if (!response.ok) throw new Error(response.status >= 500 ? 'The server is not responding. Please try again in a moment.' : `Request failed (${response.status})`);
        data = {} as ApiResponse<T>;
      }

      if (!response.ok) {
        // The session ended (token expired or the login was removed): sign out
        // everywhere instead of failing every request with the same error.
        if (response.status === 401 && currentToken && !endpoint.startsWith('/auth/') && !endpoint.startsWith('/portal/')) {
          this.clearToken();
          window.dispatchEvent(new CustomEvent('auth:expired'));
        }
        const err = new Error(data.message || 'API request failed') as any;
        err.status = response.status;
        err.details = (data as any).details;
        err.stockCheck = (data as any).stockCheck;
        err.code = (data as any).code;
        throw err;
      }

      // If the API returns data directly, return it
      // For auth endpoints, return the full response to preserve token
      if (endpoint.includes('/auth/')) {
        return data as unknown as T;
      }
      return data.data || (data as unknown as T);
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Request timed out. Please try again.');
      }
      console.error(`API Error (${endpoint}):`, error);
      throw error;
    }
  }

  // Authentication methods
  async login(email: string, password: string) {
    const response = await this.request<{ user: any; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    
    
    // The backend returns token at root level, not in response.token
    if (response && typeof response === 'object' && 'token' in response) {
      this.setToken(response.token);
      return {
        user: (response as any).data?.user || (response as any).user,
        token: response.token
      };
    }
    
    return response;
  }

  async register(email: string, password: string, fullName: string, phone?: string, companyName?: string) {
    const response = await this.request<{ user: any; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, fullName, phone, companyName }),
    });
    
    
    // The backend returns token at root level, not in response.token
    if (response && typeof response === 'object' && 'token' in response) {
      this.setToken(response.token);
      return {
        user: (response as any).data?.user || (response as any).user,
        token: response.token
      };
    }
    
    return response;
  }

  async logout() {
    await this.request('/auth/logout', { method: 'POST' });
    this.clearToken();
  }

  async getCurrentUser() {
    const response = await this.request<any>('/auth/me');
    // Extract user from the response data structure
    return response?.data?.user || response?.user || response;
  }

  // Utility methods
  setToken(token: string) {
    this.token = token;
    localStorage.setItem('token', token);
  }

  clearToken() {
    this.token = null;
    localStorage.removeItem('token');
  }

  // Generic CRUD methods
  async get<T>(endpoint: string, params?: Record<string, any>): Promise<T> {
    // Leave out empty values instead of sending "undefined" or "null".
    const clean = params ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])) : {};
    const searchParams = new URLSearchParams(clean).toString();
    const url = searchParams ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}${searchParams}` : endpoint;

    return this.request<T>(url);
  }

  /**
   * Every record of a paged list endpoint, fetched 100 at a time — for pickers
   * and exports, which must not stop at the first page. `key` names the array
   * in the response (e.g. "customers"); endpoints that answer with a bare
   * array need no key.
   */
  async listAll<T = any>(endpoint: string, key?: string, params: Record<string, any> = {}, max = 5000): Promise<T[]> {
    const pageSize = 100;
    const all: T[] = [];
    for (let page = 1; all.length < max; page++) {
      const res: any = await this.get(endpoint, { ...params, page, limit: pageSize });
      const rows: T[] = Array.isArray(res) ? res : (key ? res?.[key] : null) || [];
      all.push(...rows);
      if (rows.length < pageSize) break;
    }
    return all;
  }

  async post<T>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async put<T>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'DELETE',
    });
  }

  async patch<T>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  // Business entity methods
  // Customers

   

  async getCustomer(params?: { status?: string; search?: string; page?: number; limit?: number }) {
    return this.get(`/customers`, params);
  }

  async createCustomer(data: any) {
    return this.post('/customers', data);
  }

  async updateCustomer(id: string, data: any) {
    return this.put(`/customers/${id}`, data);
  }

  async deleteCustomer(id: string) {
    return this.delete(`/customers/${id}`);
  }

  // Jobs
  async getJobs(params?: { status?: string; priority?: string; search?: string; page?: number; limit?: number }) {
    return this.get('/jobs', params);
  }

  async getJob(id: string) {
    return this.get(`/jobs/${id}`);
  }

  async createJob(data: any) {
    return this.post('/jobs', data);
  }

  async updateJob(id: string, data: any) {
    return this.put(`/jobs/${id}`, data);
  }

  async deleteJob(id: string) {
    return this.delete(`/jobs/${id}`);
  }

  async updateJobStatus(id: string, status: string, remarks?: string) {
    return this.post(`/jobs/${id}/update-status`, { status, remarks });
  }

  async assignJob(id: string, operatorId: string, operatorName: string) {
    return this.post(`/jobs/${id}/assign`, { operatorId, operatorName });
  }

  async updateFlowStage(id: string, stage: string, remarks?: string) {
    return this.post(`/jobs/${id}/update-flow-stage`, { stage, remarks });
  }

  async getJobStats() {
    return this.get('/jobs/stats/dashboard');
  }

  async getCalendarJobStatus(year: number, month: number) {
    return this.get(`/jobs/calendar-status?year=${year}&month=${month}`);
  }

  async getDashboardStats() {
    return this.get('/dashboard/stats');
  }

  // Inventory Management
  async getInventory(params?: any) {
    return this.get('/inventory', params);
  }

  async getInventoryStats() {
    return this.get('/inventory/stats');
  }

  async createInventoryItem(data: any) {
    return this.post('/inventory', data);
  }
  async updateInventoryItem(id: string, data: any) {
    return this.put(`/inventory/${id}`, data);
  }

  async deleteInventoryItem(id: string) {
    return this.delete(`/inventory/${id}`);
  }

  /** Set the counted quantity of a stock item (recorded as a stock movement). */
  async adjustInventory(id: string, quantity: number, reason?: string, notes?: string) {
    return this.post(`/inventory/${id}/adjust`, { quantity, reason, notes });
  }

  /** Add (+) or take out (−) stock, recorded as a movement of the given type. */
  async moveStock(id: string, data: { change: number; type: 'purchase' | 'adjustment' | 'return' | 'damage' | 'sale'; reason?: string; reference?: string; notes?: string }) {
    return this.post(`/inventory/${id}/adjust`, data);
  }

  async updateStaff(id: string, data: any) {
    return this.put(`/users/${id}`, data);
  }

  // Staff Email and Password Management
  async changeStaffEmail(staffId: string, newEmail: string) {
    return this.put(`/staff/${staffId}/email`, { newEmail });
  }

  async changeStaffPassword(staffId: string, newPassword: string) {
    return this.put(`/staff/${staffId}/password`, { newPassword });
  }

  async getStaffList(params?: { search?: string; isActive?: boolean }) {
    const searchParams = params ? new URLSearchParams() : new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          searchParams.append(key, value.toString());
        }
      });
    }
    const queryString = searchParams ? '?' + searchParams.toString() : '';
    return this.get(`/staff/list${queryString}`);
  }

  // Schedule Management
  async getStaffSchedule(staffId: string, params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/staff/${staffId}/schedule${queryString}`);
  }

  async saveStaffSchedule(staffId: string, schedules: any[]) {
    return this.post(`/staff/${staffId}/schedule`, { schedules });
  }

  async updateStaffSchedule(staffId: string, scheduleId: string, data: any) {
    return this.put(`/staff/${staffId}/schedule/${scheduleId}`, data);
  }

  async deleteStaffSchedule(staffId: string, scheduleId: string) {
    return this.delete(`/staff/${staffId}/schedule/${scheduleId}`);
  }

  async getScheduleOverview(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/staff/schedule/overview${queryString}`);
  }

  // Tasks
  async getTasks(params?: any) {
    return this.get('/tasks', params);
  }

  async getTask(taskId: string) {
    return this.get(`/tasks/${taskId}`);
  }

  async getTaskStats() {
    return this.get('/tasks/stats');
  }

  async getTaskAnalytics() {
    return this.get('/tasks/analytics');
  }

  async getOverdueTasks() {
    return this.get('/tasks/overdue');
  }

  async getTasksByPriority(priority: string) {
    return this.get(`/tasks/by-priority/${priority}`);
  }

  async getTasksByStaff(staffId: string) {
    return this.get(`/tasks/by-staff/${staffId}`);
  }

  async createTask(data: any) {
    return this.post('/tasks', data);
  }

  async updateTask(taskId: string, data: any) {
    return this.put(`/tasks/${taskId}`, data);
  }

  async deleteTask(id: string) {
    return this.delete(`/tasks/${id}`);
  }

  async updateTaskStatus(id: string, status: string, notes?: string) {
    return this.put(`/tasks/${id}/status`, { status, notes });
  }

  async addComment(taskId: string, text: string) {
    return this.post(`/tasks/${taskId}/comments`, { text });
  }

  async updateTaskProgress(id: string, progress: number, actualHours?: number) {
    return this.put(`/tasks/${id}/progress`, { progress, actualHours });
  }

  async addTaskComment(id: string, text: string) {
    return this.post(`/tasks/${id}/comments`, { text });
  }

  // Reports
  async getRevenueReports(params?: any) {
    return this.get('/reports/revenue', params);
  }

  /** Design charges per month of a year, from issued invoices and from quotations (kept apart). */
  async getDesignChargeReport(year: number) {
    return this.get('/reports/design-charges', { year: String(year) });
  }

  /** Email the monthly summary (built on the server, CSV attached). */
  async emailRevenueReport(data: { month: string; email: string; subject?: string; message?: string; notes?: string }) {
    return this.request<{ messageId: string }>('/reports/revenue/email', { method: 'POST', body: JSON.stringify(data) });
  }

  // HSN Code Management
  async getHsnCodes(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/hsn-codes${queryString}`);
  }

  async getHsnCode(id: string) {
    return this.get(`/hsn-codes/${id}`);
  }

  async createHsnCode(data: any) {
    return this.post('/hsn-codes', data);
  }

  async updateHsnCode(id: string, data: any) {
    return this.put(`/hsn-codes/${id}`, data);
  }

  async deleteHsnCode(id: string) {
    return this.delete(`/hsn-codes/${id}`);
  }

  async getHsnCategories() {
    return this.get('/hsn-codes/categories/list');
  }

  async getHsnGstRatesSummary() {
    return this.get('/hsn-codes/gst-rates/summary');
  }

  async bulkImportHsnCodes(data: any) {
    return this.post('/hsn-codes/bulk-import', { hsnCodes: data });
  }

  // SAC Code Management
  async getSacCodes(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/sac-codes${queryString}`);
  }

  async getSacCode(id: string) {
    return this.get(`/sac-codes/${id}`);
  }

  async createSacCode(data: any) {
    return this.post('/sac-codes', data);
  }

  async updateSacCode(id: string, data: any) {
    return this.put(`/sac-codes/${id}`, data);
  }

  async deleteSacCode(id: string) {
    return this.delete(`/sac-codes/${id}`);
  }

  async getSacCategories() {
    return this.get('/sac-codes/categories/list');
  }

  async getSacGstRatesSummary() {
    return this.get('/sac-codes/gst-rates/summary');
  }

  async bulkImportSacCodes(data: any) {
    return this.post('/sac-codes/bulk-import', { sacCodes: data });
  }

  // Vendor Management
  async getVendors(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/vendors${queryString}`);
  }

  async getVendor(id: string) {
    return this.get(`/vendors/${id}`);
  }

  async createVendor(data: any) {
    return this.post('/vendors', data);
  }

  async updateVendor(id: string, data: any) {
    return this.put(`/vendors/${id}`, data);
  }

  async deleteVendor(id: string) {
    return this.delete(`/vendors/${id}`);
  }

  async getVendorStats() {
    return this.get('/vendors/stats/summary');
  }

  // Purchase Bills
  async getPurchaseBills(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/purchase-bills${queryString}`);
  }

  async getPurchaseBill(id: string) {
    return this.get(`/purchase-bills/${id}`);
  }

  async createPurchaseBill(data: any) {
    return this.post('/purchase-bills', data);
  }

  async updatePurchaseBill(id: string, data: any) {
    return this.put(`/purchase-bills/${id}`, data);
  }

  async deletePurchaseBill(id: string) {
    return this.delete(`/purchase-bills/${id}`);
  }

  async getPurchaseBillStats() {
    return this.get('/purchase-bills/stats/summary');
  }

  async downloadPurchaseBillPDF(billId: string) {
    const token = localStorage.getItem('token');
    const response = await fetch(`${this.baseURL}/purchase-bills/${billId}/pdf`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const errorData = await response.json();
        throw new Error(errorData.message || `Failed to download PDF: ${response.status}`);
      }
      throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
    }

    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error('PDF is empty - generation may have failed');
    }

    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;

    const contentDisposition = response.headers.get('content-disposition');
    let filename = `PurchaseBill_${billId}.pdf`;
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="(.+)"/);
      if (filenameMatch && filenameMatch[1]) {
        filename = filenameMatch[1];
      }
    }

    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    }, 100);
  }

  // Payment Management
  async getPayments(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/payments${queryString}`);
  }

  async getPayment(id: string) {
    return this.get(`/payments/${id}`);
  }

  async createPayment(data: any) {
    return this.post('/payments', data);
  }

  async updatePayment(id: string, data: any) {
    return this.put(`/payments/${id}`, data);
  }

  async deletePayment(id: string) {
    return this.delete(`/payments/${id}`);
  }

  async getPaymentStats() {
    return this.get('/payments/stats/summary');
  }

  async createCost(data: any) {
    return this.post('/costs', data);
  }

  async updateCost(id: string, data: any) {
    return this.put(`/costs/${id}`, data);
  }

  async deleteCost(id: string) {
    return this.delete(`/costs/${id}`);
  }

  // Quotation Management
  async downloadQuotationPDF(id: string): Promise<Blob> {
    const token = localStorage.getItem('token');
    const response = await fetch(`${this.baseURL}/quotations/${id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: 'Failed to download PDF' }));
      throw new Error(err.message || 'Failed to download PDF');
    }
    return response.blob();
  }

  async getQuotations(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/quotations${queryString}`);
  }

  async getQuotation(id: string) {
    return this.get(`/quotations/${id}`);
  }

  async createQuotation(data: any) {
    return this.post('/quotations', data);
  }

  async updateQuotationStatus(id: string, status: string) {
    return this.patch(`/quotations/${id}/status`, { status });
  }

  async convertQuotationToInvoice(id: string) {
    return this.post(`/quotations/${id}/convert-to-invoice`, {});
  }

  async deleteQuotation(id: string) {
    return this.delete(`/quotations/${id}`);
  }

  async sendQuotationEmail(id: string, recipientEmail: string, message?: string) {
    return this.post(`/quotations/${id}/send-email`, { recipientEmail, message });
  }

  async sendQuotationWhatsApp(
    id: string,
    phone: string,
    metaTemplateName: string,
    templateVariableMapping?: Record<string, string>,
    metaTemplateLanguage?: string
  ) {
    return this.post(`/quotations/${id}/send-whatsapp`, {
      phone,
      metaTemplateName,
      metaTemplateLanguage,
      templateVariableMapping
    });
  }

  // Invoice Management
  async getInvoices(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/invoices${queryString}`);
  }

  async getInvoice(id: string) {
    return this.get(`/invoices/${id}`);
  }

  async createInvoice(data: any) {
    return this.post('/invoices', data);
  }

  async updateInvoice(id: string, data: any) {
    return this.put(`/invoices/${id}`, data);
  }

  async deleteInvoice(id: string) {
    return this.delete(`/invoices/${id}`);
  }

  async getInvoiceStats() {
    return this.get('/invoices/stats/summary');
  }

  /** Counts and amounts for the invoice list's views (all / unpaid / overdue…). */
  async getInvoiceViewStats() {
    return this.get<{ stats: Record<string, number> }>('/invoices/stats/views');
  }

  async cancelInvoice(invoiceId: string, reason?: string) {
    return this.patch(`/invoices/${invoiceId}/cancel`, { reason });
  }

  async getInvoiceMovements(invoiceId: string) {
    return this.get(`/invoices/${invoiceId}/movements`);
  }

  /** Stock in/out history: { movements, pagination }. */
  async getInventoryMovements(filters?: { item?: string; type?: string; from?: string; to?: string; page?: number; limit?: number }) {
    return this.get(`/inventory/movements`, filters);
  }

  // Inventory Analytics
  async getInventoryAnalytics() {
    return this.get('/inventory/analytics');
  }

  async getLowStockReport() {
    return this.get('/inventory/reports/low-stock');
  }

  async getCriticalStockReport() {
    return this.get('/inventory/reports/critical-stock');
  }

  async getInventoryValuationReport(category?: string) {
    const params = new URLSearchParams();
    if (category) params.append('category', category);
    return this.get(`/inventory/reports/valuation?${params.toString()}`);
  }

  async getInventoryMovementSummaryReport(days?: number) {
    const params = new URLSearchParams();
    if (days) params.append('days', days.toString());
    return this.get(`/inventory/reports/movement-summary?${params.toString()}`);
  }

  async updatePurchaseOrderStatus(id: string, status: string, notes?: string) {
    return this.patch(`/purchase-orders/${id}/status`, { status, notes });
  }

  async deletePurchaseOrder(id: string) {
    return this.delete(`/purchase-orders/${id}`);
  }

  // Invoice PDF and Email
  async downloadInvoicePDF(invoiceId: string) {
    try {
      const token = localStorage.getItem('token');
      console.log('📥 Starting PDF download for invoice:', invoiceId);

      const response = await fetch(`${this.baseURL}/invoices/${invoiceId}/pdf`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      console.log('📥 Response status:', response.status);
      console.log('📥 Response headers:', response.headers.get('content-type'));

      if (!response.ok) {
        // Try to parse JSON error response
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const errorData = await response.json();
          console.error('📥 Error response:', errorData);
          throw new Error(errorData.message || `Failed to download PDF: ${response.status}`);
        }
        const errorText = await response.text();
        console.error('📥 Error response:', errorText);
        throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();
      console.log('📥 Blob size:', blob.size, 'bytes');

      if (blob.size === 0) {
        throw new Error('PDF is empty - generation may have failed');
      }

      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;

      // Get filename from Content-Disposition header or use default
      const contentDisposition = response.headers.get('content-disposition');
      let filename = `Invoice_${invoiceId}.pdf`;

      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="(.+)"/);
        if (filenameMatch && filenameMatch[1]) {
          filename = filenameMatch[1];
          console.log('📥 Using filename from server:', filename);
        }
      }

      link.download = filename;
      document.body.appendChild(link);

      console.log('📥 Triggering download for:', link.download);
      link.click();

      // Wait a bit before removing to ensure download starts
      setTimeout(() => {
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
        console.log('📥 Download completed and cleanup done');
      }, 100);
    } catch (error) {
      console.error('❌ PDF download error:', error);
      throw error;
    }
  }

  async sendInvoiceEmail(invoiceId: string, email: string, message?: string) {
    return this.post(`/invoices/${invoiceId}/send-email`, { email, message });
  }

  async sendInvoiceWhatsApp(
    invoiceId: string,
    phone: string,
    metaTemplateName: string,
    templateVariableMapping?: Record<string, string>,
    metaTemplateLanguage?: string
  ) {
    return this.post(`/invoices/${invoiceId}/send-whatsapp`, {
      phone,
      metaTemplateName,
      metaTemplateLanguage,
      templateVariableMapping
    });
  }

  async getInvoicePrintData(invoiceId: string) {
    return this.get(`/invoices/${invoiceId}/print-data`);
  }

  async updateInvoicePaymentStatus(invoiceId: string, data: { paymentStatus: string; amountPaid?: number }) {
    return this.patch(`/invoices/${invoiceId}/payment-status`, data);
  }

  // WhatsApp Integration
  /** Sends an approved Meta template; variables are {{1}}, {{2}}… by number. */
  async sendWhatsAppMessage(phoneNumber: string, templateId: string, variables: Record<string, string>, language?: string, customerId?: string) {
    return this.post('/whatsapp/send', { phoneNumber, templateId, variables, language, customerId });
  }

  // Meta WhatsApp API Integration
  async getWhatsAppSettings() {
    return this.get('/whatsapp/settings');
  }

  async setupWhatsApp(data: { enabled: boolean; wabaId: string; phoneNumberId: string; accessToken: string }) {
    return this.post('/whatsapp/settings', data);
  }

  async getMetaTemplates() {
    return this.get('/whatsapp/meta-templates');
  }

  async createMetaTemplate(data: { name: string; language: string; category: string; components: any[] }) {
    return this.post('/whatsapp/meta-templates', data);
  }

  async deleteMetaTemplate(name: string) {
    return this.delete(`/whatsapp/meta-templates/${name}`);
  }

  // WhatsApp Embedded Signup
  async exchangeWhatsAppToken(code: string, wabaId: string, phoneNumberId: string) {
    return this.post<any>('/embedded-signup/exchange-token', {
      code,
      waba_id: wabaId,
      phone_number_id: phoneNumberId
    });
  }

  async getEmbeddedSignupStatus() {
    return this.get<any>('/embedded-signup/status');
  }

  async resetEmbeddedSignupConfiguration() {
    return this.delete<any>('/embedded-signup/reset');
  }

  // Payment Reminders
  async getPaymentReminderStats() {
    return this.get('/payment-reminders/stats');
  }

  async getOverdueInvoices() {
    return this.get('/payment-reminders/overdue-invoices');
  }

  async getPaymentReminders(params?: { status?: string; customerId?: string; startDate?: string; endDate?: string; page?: number; limit?: number }) {
    return this.get('/payment-reminders', params);
  }

  async sendPaymentReminder(invoiceId: string, templateOverride?: { metaTemplateName?: string; metaTemplateLanguage?: string; templateVariableMapping?: Record<string, string> }) {
    return this.post(`/payment-reminders/send/${invoiceId}`, templateOverride || {});
  }

  async sendBulkPaymentReminders() {
    return this.post('/payment-reminders/send-bulk');
  }

  async getPaymentReminderSettings() {
    return this.get('/payment-reminders/settings');
  }

  async updatePaymentReminderSettings(data: any) {
    return this.put('/payment-reminders/settings', data);
  }

  // Accounts Management
  async getAccountTransactions(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/accounts/transactions${queryString}`);
  }

  async getAccountBalances() {
    return this.get('/accounts/balances');
  }

  async getBankReconciliation(params?: { accountName?: string; statementDate?: string }) {
    return this.get('/accounts/reconciliation', params);
  }

  async getBankReconciliationDetail(id: string) {
    return this.get(`/accounts/reconciliation/${id}`);
  }

  async saveBankReconciliation(data: { accountName: string; statementDate: string; closingBalance: number; transactionIds: string[] }) {
    return this.post('/accounts/reconciliation', data);
  }

  async getCheques(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/accounts/cheques${queryString}`);
  }

  async createAccountTransaction(data: any) {
    return this.post('/accounts/transactions', data);
  }

  async updateAccountTransaction(id: string, data: any) {
    return this.put(`/accounts/transactions/${id}`, data);
  }

  async deleteAccountTransaction(id: string) {
    return this.delete(`/accounts/transactions/${id}`);
  }

  async getAccountStats() {
    return this.get('/accounts/stats/summary');
  }

  async getAccountReportSummary(period: string = 'month') {
    return this.get(`/accounts/reports/summary?period=${period}`);
  }

  async getAccountLedger(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/accounts/ledger${queryString}`);
  }

  async downloadAccountReport(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    const url = `${this.baseURL}/accounts/reports/export${queryString}`;

    // Get the current token
    const currentToken = localStorage.getItem('token');

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          ...(currentToken && { Authorization: `Bearer ${currentToken}` }),
        },
      });

      if (!response.ok) {
        throw new Error('Failed to download report');
      }

      // Get the filename from Content-Disposition header or use default
      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = 'transactions-report.xlsx';
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?(.+)"?/);
        if (filenameMatch) {
          filename = filenameMatch[1];
        }
      }

      // Create blob and download
      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);

      return { status: 'success', message: 'Report downloaded successfully' };
    } catch (error) {
      console.error('Download report error:', error);
      throw error;
    }
  }

  // Files

  // Calendar & Events - Complete Implementation
  async getEvents(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/calendar/events${queryString}`);
  }

  async getEvent(id: string) {
    return this.get(`/calendar/events/${id}`);
  }

  async createEvent(data: any) {
    return this.post('/calendar/events', data);
  }

  async updateEvent(id: string, data: any) {
    return this.put(`/calendar/events/${id}`, data);
  }

  async deleteEvent(id: string) {
    return this.delete(`/calendar/events/${id}`);
  }

  async getEventsInRange(startDate: string, endDate: string) {
    return this.get(`/calendar/events/range/${startDate}/${endDate}`);
  }

  async getUpcomingEvents(limit?: number) {
    const queryString = limit ? `?limit=${limit}` : '';
    return this.get(`/calendar/events/upcoming${queryString}`);
  }

  async getOverdueEvents() {
    return this.get('/calendar/events/overdue');
  }

  async updateEventStatus(id: string, status: string) {
    return this.put(`/calendar/events/${id}/status`, { status });
  }

  async getCalendarStats() {
    return this.get('/calendar/stats/summary');
  }

  async setDiscountRuleActive(id: string, isActive: boolean) {
    return this.patch(`/discounts/rules/${id}/active`, { isActive });
  }

  /** Best discount for a customer and order amount: { discountAmount, appliedRule: { name, label } | null }. */
  async calculateDiscount(customerId: string, amount: number) {
    return this.post('/discounts/calculate', { customerId, amount });
  }

  // Customer Portal — staff side (issue / list / revoke personal links)
  async createPortalAccess(data: { customerId: string; expiresInDays?: number; sendEmail?: boolean }) {
    return this.post('/portal/access', data);
  }

  async getPortalAccessLinks(params?: { customerId?: string }) {
    return this.get('/portal/access', params);
  }

  async revokePortalAccess(id: string) {
    return this.delete(`/portal/access/${id}`);
  }

  // Customer Portal — customer side. These run without a staff login: the
  // session token from POST /portal/session goes in X-Portal-Session.
  private async portalFetch<T>(endpoint: string, sessionToken: string | null, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (!(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (sessionToken) headers['X-Portal-Session'] = sessionToken;
    const response = await fetch(`${this.baseURL}${endpoint}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.message || 'Portal request failed') as Error & { status?: number; code?: string };
      err.status = response.status;
      err.code = data.code;
      throw err;
    }
    return (data.data ?? data) as T;
  }

  async openPortalSession(linkToken: string) {
    return this.portalFetch<{
      sessionToken: string;
      expiresAt: string;
      customer: { name: string; email?: string; phone?: string; company?: string };
      business: { name: string | null };
    }>('/portal/session', null, { method: 'POST', body: JSON.stringify({ token: linkToken }) });
  }

  async portalLogout(sessionToken: string) {
    return this.portalFetch('/portal/logout', sessionToken, { method: 'POST' });
  }

  async getPortalCustomerData(sessionToken: string) {
    return this.portalFetch<{ customer: unknown; sessionExpiresAt: string }>('/portal/customer-data', sessionToken);
  }

  async getPortalOrders(sessionToken: string) {
    return this.portalFetch<{ jobs: unknown[] }>('/portal/orders?limit=50', sessionToken);
  }

  async getPortalInvoices(sessionToken: string) {
    return this.portalFetch<{ invoices: unknown[] }>('/portal/invoices?limit=50', sessionToken);
  }

  async getPortalDeliveries(sessionToken: string) {
    return this.portalFetch<{ deliveries: unknown[] }>('/portal/deliveries?limit=50', sessionToken);
  }

  async getPortalFiles(sessionToken: string) {
    return this.portalFetch<{ files: unknown[] }>('/portal/files?limit=50', sessionToken);
  }

  async getPortalStats(sessionToken: string) {
    return this.portalFetch<{ stats: { totalOrders: number; openOrders: number; unpaidInvoices: number; outstandingBalance: number } }>('/portal/stats/summary', sessionToken);
  }

  async uploadPortalFile(sessionToken: string, file: File, category?: string, description?: string, jobId?: string) {
    const formData = new FormData();
    formData.append('file', file);
    if (category) formData.append('category', category);
    if (description) formData.append('description', description);
    if (jobId) formData.append('jobId', jobId);
    return this.portalFetch<{ file: unknown }>('/portal/upload-file', sessionToken, { method: 'POST', body: formData });
  }

  /** Download a portal file as a Blob (the session token cannot go in a link). */
  async downloadPortalFile(sessionToken: string, fileId: string) {
    const response = await fetch(`${this.baseURL}/portal/files/${fileId}/download`, { headers: { 'X-Portal-Session': sessionToken } });
    if (!response.ok) throw new Error('The file could not be downloaded');
    return response.blob();
  }

  // Notifications
  async getNotifications() {
    return this.get<{ items: unknown[]; unreadCount: number; alerts: unknown[] }>('/notifications');
  }

  async markNotificationRead(id: string) {
    return this.post(`/notifications/${id}/read`);
  }

  async markAllNotificationsRead() {
    return this.post('/notifications/read-all');
  }

  // Team workload and evaluation (admin, or managers who see all staff data)
  async getTeamOverview(days = 30, team?: string) {
    return this.get<unknown>('/team/overview', team ? { days, team } : { days });
  }

  async getTeamMember(userId: string, days = 30) {
    return this.get<unknown>(`/team/members/${userId}`, { days });
  }

  // Jobs the current login handles or has tasks on
  async getMyJobs() {
    return this.get<{ jobs: unknown[] }>('/jobs/mine');
  }

  // Activity Log - Complete Implementation
  async getActivityLog(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/activity-log${queryString}`);
  }

  async getActivityLogEntry(id: string) {
    return this.get(`/activity-log/${id}`);
  }

  async getEntityActivity(entityType: string, entityId: string, params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/activity-log/entity/${entityType}/${entityId}${queryString}`);
  }

  async getUserActivity(userId: string, params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/activity-log/user/${userId}${queryString}`);
  }

  async getActivityStats(days?: number) {
    const queryString = days ? `?days=${days}` : '';
    return this.get(`/activity-log/stats/summary${queryString}`);
  }

  async getRecentActivity(limit?: number) {
    const queryString = limit ? `?limit=${limit}` : '';
    return this.get(`/activity-log/recent${queryString}`);
  }

  async getCriticalActivity(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/activity-log/critical${queryString}`);
  }

  async deleteActivityLogEntry(id: string) {
    return this.delete(`/activity-log/${id}`);
  }

  async downloadActivityLog(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    const url = `${this.baseURL}/activity-log/export${queryString}`;

    const currentToken = localStorage.getItem('token');

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          ...(currentToken && { Authorization: `Bearer ${currentToken}` }),
        },
      });

      if (!response.ok) {
        throw new Error('Failed to export activity log');
      }

      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = 'activity-log.xlsx';
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?(.+)"?/);
        if (filenameMatch) {
          filename = filenameMatch[1];
        }
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);

      return { status: 'success', message: 'Activity log exported successfully' };
    } catch (error) {
      console.error('Export activity log error:', error);
      throw error;
    }
  }

  // User Management - Complete Implementation
  async getUsers(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/users${queryString}`);
  }

  async getUser(id: string) {
    return this.get(`/users/${id}`);
  }

  async createUser(data: any) {
    return this.post('/users', data);
  }

  async resendInvitation(id: string) {
    return this.post(`/users/${id}/resend-invitation`, {});
  }

  // Invitation acceptance is public — the one-time token in the URL is the
  // only credential, so these calls must not carry (or need) a session.
  async getInvitation(token: string) {
    return this.get<any>(`/auth/invitation/${token}`);
  }

  async acceptInvitation(token: string, password: string) {
    return this.post<any>(`/auth/invitation/${token}/accept`, { password });
  }

  async updateUser(id: string, data: any) {
    return this.put(`/users/${id}`, data);
  }

  async deleteUser(id: string) {
    return this.delete(`/users/${id}`);
  }

  async changeUserPassword(id: string, currentPassword: string, newPassword: string) {
    return this.put(`/users/${id}/password`, { currentPassword, newPassword });
  }

  async toggleUserStatus(id: string) {
    return this.put(`/users/${id}/toggle-status`);
  }

  async getUserStats() {
    return this.get('/users/stats/summary');
  }

  // Roles: named permission sets (backend/src/routes/accessRoles.js)
  async getAccessRoles() {
    return this.get<unknown>('/access-roles');
  }

  async createAccessRole(data: unknown) {
    return this.post<unknown>('/access-roles', data);
  }

  async updateAccessRole(id: string, data: unknown) {
    return this.put<unknown>(`/access-roles/${id}`, data);
  }

  async deleteAccessRole(id: string) {
    return this.delete<unknown>(`/access-roles/${id}`);
  }

  // Teams (backend/src/routes/teams.js)
  async getTeams() {
    return this.get<{ teams: unknown[] }>('/teams');
  }

  async createTeam(data: unknown) {
    return this.post<unknown>('/teams', data);
  }

  async updateTeam(id: string, data: unknown) {
    return this.put<unknown>(`/teams/${id}`, data);
  }

  async deleteTeam(id: string) {
    return this.delete<unknown>(`/teams/${id}`);
  }

  // Settings - Complete Implementation
  async getSettings() {
    return this.get('/settings');
  }

  async updateSettings(data: any) {
    return this.put('/settings', data);
  }

  async updateCompanySettings(data: any) {
    return this.put('/settings/company', data);
  }

  async updateBusinessSettings(data: any) {
    return this.put('/settings/business', data);
  }

  async updateNotificationSettings(data: any) {
    return this.put('/settings/notifications', data);
  }

  async updateSecuritySettings(data: any) {
    return this.put('/settings/security', data);
  }

  async updateIntegrationSettings(data: any) {
    return this.put('/settings/integrations', data);
  }

  async updateCustomFields(data: any) {
    return this.put('/settings/custom-fields', data);
  }

  async updateThemeSettings(data: any) {
    return this.put('/settings/theme', data);
  }

  async resetSettings(section?: string) {
    return this.post('/settings/reset', { section });
  }

  // Files Management - Complete Implementation
  async getFiles(params?: any) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/files${queryString}`);
  }

  async getFile(id: string) {
    return this.get(`/files/${id}`);
  }

  async uploadFile(file: File, metadata?: any) {
    const formData = new FormData();
    formData.append('file', file);
    if (metadata) {
      Object.keys(metadata).forEach(key => {
        if (metadata[key] !== undefined) {
          formData.append(key, metadata[key]);
        }
      });
    }
    
    return this.request('/files/upload', { 
      method: 'POST',
      body: formData
    });
  }

  async updateFile(id: string, data: any) {
    return this.put(`/files/${id}`, data);
  }

  async downloadFile(id: string) {
    return this.get(`/files/${id}/download`);
  }

  async deleteFile(id: string) {
    return this.delete(`/files/${id}`);
  }

  async getFileStats() {
    return this.get('/files/stats/summary');
  }

  // Email Management
  async sendEmail(emailData: {
    to: string | string[];
    subject: string;
    template: string;
    data: any;
  }) {
    return this.post('/email/send', emailData);
  }

  async testEmail(to: string) {
    return this.post('/email/test', { to });
  }

  // ==================== HR & PAYROLL ====================

  // --- Employees ---
  async getEmployees(params?: any) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/hr/employees${qs}`);
  }
  async getEmployee(id: string) {
    return this.get(`/hr/employees/${id}`);
  }
  async getEmployeeStats() {
    return this.get('/hr/employees/stats/summary');
  }
  async createEmployee(data: any) {
    return this.post('/hr/employees', data);
  }
  async updateEmployee(id: string, data: any) {
    return this.put(`/hr/employees/${id}`, data);
  }
  async deleteEmployee(id: string) {
    return this.delete(`/hr/employees/${id}`);
  }

  // --- Attendance ---
  async getAttendance(params?: any) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/hr/attendance${qs}`);
  }
  async getAttendanceSummary(month: number, year: number) {
    return this.get(`/hr/attendance/summary?month=${month}&year=${year}`);
  }
  async markAttendance(data: any) {
    return this.post('/hr/attendance', data);
  }
  async markAttendanceBulk(date: string, records: any[]) {
    return this.post('/hr/attendance/bulk', { date, records });
  }
  async deleteAttendance(id: string) {
    return this.delete(`/hr/attendance/${id}`);
  }

  // --- Leaves ---
  async getLeaves(params?: any) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/hr/leaves${qs}`);
  }
  async createLeave(data: any) {
    return this.post('/hr/leaves', data);
  }
  async updateLeaveStatus(id: string, status: string, rejectionReason?: string) {
    return this.patch(`/hr/leaves/${id}/status`, { status, rejectionReason });
  }
  async deleteLeave(id: string) {
    return this.delete(`/hr/leaves/${id}`);
  }

  // --- Payroll ---
  async getPayroll(params?: any) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/hr/payroll${qs}`);
  }
  async getPayrollSummary(month: number, year: number) {
    return this.get(`/hr/payroll/stats/summary?month=${month}&year=${year}`);
  }
  async generatePayroll(month: number, year: number, employeeId?: string) {
    return this.post('/hr/payroll/generate', { month, year, employeeId });
  }
  async updatePayslip(id: string, data: any) {
    return this.put(`/hr/payroll/${id}`, data);
  }
  async markPayslipPaid(id: string, data?: any) {
    return this.patch(`/hr/payroll/${id}/pay`, data || {});
  }
  async deletePayslip(id: string) {
    return this.delete(`/hr/payroll/${id}`);
  }
  async downloadPayslipPDF(id: string): Promise<Blob> {
    const token = localStorage.getItem('token');
    const response = await fetch(`${this.baseURL}/hr/payroll/${id}/payslip`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: 'Failed to download payslip' }));
      throw new Error(err.message || 'Failed to download payslip');
    }
    return response.blob();
  }
}

// Create singleton instance
const apiClient = new ApiClient();

export default apiClient;
export type { ApiResponse };
