import { test, expect, type Page } from "@playwright/test";

/**
 * Sales order workflow in a real browser against the real API and an isolated
 * database: product rate master, live server pricing, approval queue,
 * production stages, advance, invoice, plus a phone-width and dark-mode pass.
 */
const EMAIL = "e2e-admin@example.test";
const PASSWORD = "Passw0rd!";
const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (!["localhost", "127.0.0.1"].includes(host) && !/^(data|blob):/.test(r.url()) && !/fonts\.(googleapis|gstatic)\.com$/.test(host)) errors.push(`non-local request: ${r.url()}`);
  });
});
test.afterEach(() => expect(errors, "uncaught browser errors").toEqual([]));

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.locator("#signin-email").fill(EMAIL);
  await page.locator("#signin-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/auth/);
}

test("product rates: select a product, GST sides reconcile, overlapping slabs are refused, a valid save works", async ({ page }) => {
  await signIn(page);
  await page.goto("/product-rates");
  await page.getByLabel("Search products").fill("star");
  await page.getByRole("button", { name: /Star Flex 280gsm/ }).click();
  await expect(page.getByText("Rate rule 1")).toBeVisible();
  await expect(page.getByLabel("Slab 1 exclusive rate").first()).toHaveValue("15");

  // Typing an inclusive rate fills the exclusive one: ₹12 inclusive at 18% = ₹10.17.
  const incl = page.getByLabel("Slab 2 inclusive rate").first();
  await incl.fill("12");
  await expect(page.getByLabel("Slab 2 exclusive rate").first()).toHaveValue("10.17");

  // Overlap: slab 2 starts inside slab 1 (1-100).
  await page.getByLabel("Slab 2 from").first().fill("50");
  await page.getByRole("button", { name: "Save rates" }).click();
  await expect(page.getByRole("alert")).toContainText(/overlap/i);

  await page.getByLabel("Slab 2 from").first().fill("101");
  await page.getByRole("button", { name: "Save rates" }).click();
  await expect(page.getByText("Product rates saved").first()).toBeVisible();
});

test("sales order: live price, save, approve, produce, advance, invoice", async ({ page }) => {
  await signIn(page);
  await page.goto("/sales-orders");
  await page.getByRole("button", { name: "New order" }).click();

  await page.getByLabel("Customer *").fill("Agency");
  await page.getByRole("button", { name: /Agency Annie/ }).click();
  await page.getByLabel("Project name").fill("Diwali banners");

  await page.getByLabel("Product 1").fill("Star");
  await page.getByRole("button", { name: /Star Flex 280gsm/ }).click();
  await page.getByLabel("Copies").first().fill("100");
  // Agency rate ₹8 × 100 + 18% GST = ₹944, worked out by the server while typing.
  await expect(page.getByText("₹944").first()).toBeVisible();
  await page.getByLabel("Copies").first().fill("101");
  await expect(page.getByText("₹953.44").first()).toBeVisible();
  await page.getByLabel("Copies").first().fill("100");
  await expect(page.getByText("₹944").first()).toBeVisible();

  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByText("Order created").first()).toBeVisible();

  // The queue: a pending order, found by search.
  await page.getByPlaceholder("Order number, customer or mobile").fill("Agency");
  const row = page.getByRole("row", { name: /Agency Annie/ }).first();
  await expect(row).toContainText("pending");
  await expect(row).toContainText("SO-");

  // Approve from the row menu.
  await row.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Approve" }).click();
  await expect(row).toContainText("approved");

  // Production: printing starts (design is not needed unless ticked; the default ticks printing only).
  await row.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Production stages" }).click();
  await page.getByRole("button", { name: "Start" }).first().click();
  await page.getByRole("button", { name: "Complete" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last().click();

  // Advance of ₹400.
  await row.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Record advance" }).click();
  await page.getByLabel("Amount ₹ *").fill("400");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByText("Advance recorded").first()).toBeVisible();
  await expect(row).toContainText("₹544"); // balance

  // Draft invoice, once.
  await row.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Create invoice" }).click();
  await expect(page.getByText("Draft invoice created").first()).toBeVisible();
  await row.getByRole("button", { name: /Actions for/ }).click();
  await expect(page.getByRole("menuitem", { name: "Create invoice" })).toHaveCount(0);
});

test("an order with no rate cannot be saved and says why", async ({ page }) => {
  await signIn(page);
  await page.goto("/sales-orders");
  await page.getByRole("button", { name: "New order" }).click();
  await page.getByLabel("Customer *").fill("Seed");
  await page.getByRole("button", { name: /Seed Customer/ }).click();
  await page.getByLabel("Product 1").fill("Agency Only");
  await page.getByRole("button", { name: /Agency Only Vinyl/ }).click();
  await page.getByLabel("Copies").first().fill("5");
  // Seed Customer is not an agency and the product has an agency rate only: a warning, not a zero price.
  await expect(page.getByText(/No rate is configured for Agency Only Vinyl/).first()).toBeVisible();
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /no rate/i })).toBeVisible();
});

test("phone width and dark mode: the queue, the editor and the rate master stay usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.addInitScript(() => localStorage.setItem("terralabs-theme", "dark"));
  await signIn(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  for (const path of ["/sales-orders", "/product-rates"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} must not scroll sideways at 390px`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/shot-390-dark${path.replace("/", "-")}.png` });
  }
  await page.goto("/sales-orders");
  await page.getByRole("button", { name: "New order" }).click();
  await expect(page.getByLabel("Customer *")).toBeVisible();
  await page.waitForTimeout(700); // the panel finishes sliding in
  const sheetOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sheetOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "test-results/shot-390-dark-editor.png" });
});
