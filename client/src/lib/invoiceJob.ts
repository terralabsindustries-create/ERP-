/**
 * An invoice can only be linked to a job ticket of its own customer (the API
 * refuses any other). When the customer on an invoice form changes, a job
 * ticket of the previous customer is dropped from the form.
 */
type JobRef = { _id?: string; id?: string; customerId?: string | { _id?: string } | null };

/** Whether the selected job can stay with this customer: it is theirs, or none (or an unknown one) is selected. */
export function jobFitsCustomer(jobs: JobRef[], jobId: string, customerId: string): boolean {
  const job = jobs.find((j) => (j._id || j.id) === jobId);
  if (!job) return true;
  const owner = typeof job.customerId === "object" ? job.customerId?._id : job.customerId;
  return !owner || String(owner) === String(customerId);
}
