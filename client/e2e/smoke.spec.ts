import { test, expect, type Page } from "@playwright/test";

/**
 * Smoke tests: sign in through the real UI against the real API and seeded
 * database, then open every module the release depends on. Each page must
 * render, show its seeded record where it has one, and raise no uncaught
 * browser error. API failures must read as errors with Retry — never as an
 * empty list.
 */
const EMAIL = "e2e-admin@example.test";
const PASSWORD = "Passw0rd!";

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (e) => errors.push(e.message));
  // Safety: these tests sign in and change nothing real, but they must never talk to a hosted API.
  // Anything that is not this machine aborts the test.
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (!["localhost", "127.0.0.1"].includes(host) && !/^(data|blob):/.test(r.url()) && !/fonts\.(googleapis|gstatic)\.com$/.test(host)) {
      errors.push(`request to a non-local host: ${r.url()}`);
    }
  });
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page), "uncaught browser errors").toEqual([]);
});

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.locator("#signin-email").fill(EMAIL);
  await page.locator("#signin-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/auth/);
}

test.describe("authentication", () => {
  test("a wrong password is refused and stays on the sign-in page", async ({ page }) => {
    await page.goto("/auth");
    await page.locator("#signin-email").fill(EMAIL);
    await page.locator("#signin-password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/auth/);
  });

  test("a signed-out visitor is sent to sign in", async ({ page }) => {
    await page.goto("/customers");
    await expect(page).toHaveURL(/\/auth/);
  });

  test("signing in reaches the dashboard and survives a reload", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("main")).toBeVisible();
    await page.reload();
    await expect(page).not.toHaveURL(/\/auth/);
  });
});

const MODULES: { name: string; path: string; sees?: string }[] = [
  { name: "Dashboard", path: "/" },
  { name: "Customer management", path: "/customers", sees: "Seed Customer" },
  { name: "Quotations", path: "/quotations" },
  { name: "Job Tickets", path: "/jobs", sees: "Seed Job Ticket" },
  { name: "Production Board", path: "/production" },
  { name: "Invoices", path: "/invoices", sees: "Seed Customer" },
  { name: "Payments", path: "/payments" },
  { name: "Inventory", path: "/inventory", sees: "Seed Paper" },
  { name: "Purchasing", path: "/purchase-orders" },
  { name: "Settings", path: "/settings" },
];

test.describe("modules open for a signed-in admin", () => {
  test.beforeEach(async ({ page }) => signIn(page));

  for (const m of MODULES) {
    test(`${m.name} renders${m.sees ? ` and lists ${m.sees}` : ""}`, async ({ page }) => {
      await page.goto(m.path);
      await expect(page).toHaveURL(new RegExp(`${m.path === "/" ? "/$" : m.path}`));
      await expect(page.getByText("Page not found")).toHaveCount(0);
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
      if (m.sees) await expect(page.getByText(m.sees).locator("visible=true").first()).toBeVisible();
      else await expect(page.getByRole("main")).toBeVisible();
    });
  }
});

test.describe("API failures never look like empty data", () => {
  test.beforeEach(async ({ page }) => signIn(page));

  test("a server error on Job Tickets shows an error with Retry, then recovers", async ({ page }) => {
    let fail = true;
    await page.route("**/api/jobs?**", (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ status: "error", message: "boom" }) }) : route.continue()));
    await page.goto("/jobs");
    const alert = page.getByRole("alert").filter({ hasText: /load job tickets|boom/i });
    await expect(alert).toBeVisible();
    await expect(page.getByText("No job tickets")).toHaveCount(0);
    fail = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Seed Job Ticket").first()).toBeVisible();
  });

  test("an unreachable server reads as a connection problem, not as no records", async ({ page }) => {
    await page.route("**/api/jobs?**", (route) => route.abort("connectionrefused"));
    await page.goto("/jobs");
    await expect(page.getByRole("alert").filter({ hasText: /reach the server/i })).toBeVisible();
    await expect(page.getByText("No job tickets")).toHaveCount(0);
  });
});

test.describe("Pricing Master", () => {
  test.beforeEach(async ({ page }) => signIn(page));

  test("create an item with quantity slabs, see ranges and the price preview, reject a duplicate quantity", async ({ page }) => {
    await page.goto("/pricing");
    await page.getByRole("button", { name: "New item" }).click();
    await page.getByLabel("Item name").fill("E2E 13x19 Art Simplex");
    for (const [i, [q, r]] of [["1", "25"], ["11", "23"], ["50", "22"]].entries()) {
      await page.getByRole("button", { name: "Add new quantity" }).click();
      await page.getByLabel(`Minimum quantity ${i + 1}`).fill(q);
      await page.getByLabel(`Unit rate ${i + 1}`).fill(r);
    }
    await expect(page.getByText("1 – 10 units")).toBeVisible();
    await expect(page.getByText("50 and above units")).toBeVisible();
    await page.getByLabel("Price preview quantity").fill("75");
    await expect(page.locator("[aria-live=polite]").last()).toContainText(/75 × ₹22(\.00)? = ₹1,947(\.00)?/); // 1,650 + 18% GST
    // duplicate quantity is flagged immediately and blocks saving
    await page.getByRole("button", { name: "Add new quantity" }).click();
    await page.getByLabel("Minimum quantity 4").fill("11");
    await page.getByLabel("Unit rate 4").fill("9");
    await expect(page.getByRole("alert").filter({ hasText: "appears more than once" })).toBeVisible();
    await page.getByRole("button", { name: "Delete slab 4" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "appears more than once" })).toHaveCount(0);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("E2E 13x19 Art Simplex").first()).toBeVisible();
  });

  test("an API failure on the item list is an error with Retry, not an empty list", async ({ page }) => {
    await page.route("**/api/price-items?**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ status: "error", message: "boom" }) }));
    await page.goto("/pricing");
    await expect(page.getByRole("alert").filter({ hasText: /load items|boom/i })).toBeVisible();
    await expect(page.getByText("No items yet")).toHaveCount(0);
  });
});
