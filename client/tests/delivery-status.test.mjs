/**
 * Delivery state shown beside a job's payment state on Job Tickets.
 * Run from client/: `node --test tests/delivery-status.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryState } from "../src/lib/deliveryStatus.ts";

test("latest delivery decides", () => {
  const delivered = deliveryState({ status: "completed", deliveries: [{ deliveryId: "DLV-2026-00007", status: "delivered", deliveryProof: { deliveredAt: "2026-11-27T06:00:00Z" } }] });
  assert.equal(delivered.label, "Delivered 27 Nov");
  assert.equal(delivered.tone, "success");
  assert.equal(deliveryState({ status: "completed", deliveries: [{ status: "in_transit" }] }).label, "Out for delivery");
  assert.equal(deliveryState({ status: "completed", deliveries: [{ status: "failed" }] }).tone, "danger");
  assert.equal(deliveryState({ status: "completed", deliveries: [{ status: "scheduled", deliveryDate: "2026-11-28T00:00:00Z" }] }).label, "Delivery 28 Nov");
});

test("a cancelled delivery is skipped", () => {
  assert.equal(deliveryState({ status: "completed", deliveries: [{ status: "cancelled" }] }, { billed: true }).label, "Not delivered");
});

test("without a delivery record the job stage is used", () => {
  assert.equal(deliveryState({ status: "delivered" }).label, "Delivered");
  assert.equal(deliveryState({ status: "ready_for_print", deliveries: [] }, { billed: true }).label, "Not delivered");
  assert.equal(deliveryState({ status: "completed", deliveries: [] }).label, "Not delivered");
  assert.equal(deliveryState({ status: "design_in_progress" }), null);
  assert.equal(deliveryState({ status: "cancelled" }, { billed: true }), null);
});

test("without delivery data it never claims Not delivered", () => {
  assert.equal(deliveryState({ status: "completed" }, { billed: true }), null);
  assert.equal(deliveryState({ status: "delivered" }).label, "Delivered");
});
