import { expect, test, type Page } from "@playwright/test";

const DEFAULT_TICKERS = ["AAPL", "GOOGL", "MSFT", "AMZN", "TSLA", "NVDA", "META", "JPM", "V", "NFLX"];

const money = async (page: Page, testId: string) =>
  Number((await page.getByTestId(testId).textContent())!.replace(/[^0-9.-]/g, ""));

/** Open the app and wait until the initial watchlist load has selected a ticker. */
async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("trade-ticker")).not.toHaveValue("");
}

test.describe.configure({ mode: "serial" });

test("fresh start shows default watchlist, $10k cash and streaming prices", async ({ page }) => {
  await openApp(page);
  for (const t of DEFAULT_TICKERS) {
    await expect(page.getByTestId(`watchlist-row-${t}`)).toBeVisible();
  }
  await expect(page.getByTestId("cash-balance")).toHaveText("$10,000.00");
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");

  const price = page.getByTestId("price-AAPL");
  await expect(price).not.toHaveText("--");
  const first = await price.textContent();
  await expect(price).not.toHaveText(first!, { timeout: 10_000 });
});

test("add and remove a ticker from the watchlist", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("watchlist-input").fill("PYPL");
  await page.getByTestId("watchlist-add").click();
  await expect(page.getByTestId("watchlist-row-PYPL")).toBeVisible();
  await expect(page.getByTestId("price-PYPL")).not.toHaveText("--");

  await page.getByTestId("watchlist-row-PYPL").hover();
  await page.getByTestId("remove-PYPL").click();
  await expect(page.getByTestId("watchlist-row-PYPL")).toHaveCount(0);
});

test("buy then sell shares updates cash and positions", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("cash-balance")).not.toHaveText("$0.00");
  const startCash = await money(page, "cash-balance");

  await page.getByTestId("trade-ticker").fill("MSFT");
  await page.getByTestId("trade-quantity").fill("5");
  await page.getByTestId("buy-button").click();
  await expect(page.getByTestId("position-qty-MSFT")).toHaveText("5");
  expect(await money(page, "cash-balance")).toBeLessThan(startCash);

  await page.getByTestId("trade-quantity").fill("2");
  await page.getByTestId("sell-button").click();
  await expect(page.getByTestId("position-qty-MSFT")).toHaveText("3");

  await page.getByTestId("trade-quantity").fill("3");
  await page.getByTestId("sell-button").click();
  await expect(page.getByTestId("position-MSFT")).toHaveCount(0);
});

test("rejects selling more than owned", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("trade-ticker").fill("TSLA");
  await page.getByTestId("trade-quantity").fill("1000");
  await page.getByTestId("sell-button").click();
  await expect(page.getByTestId("trade-status")).toContainText("Insufficient shares");
});

test("portfolio heatmap and P&L chart render", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("trade-ticker").fill("NVDA");
  await page.getByTestId("trade-quantity").fill("2");
  await page.getByTestId("buy-button").click();
  await expect(page.getByTestId("heatmap-cell-NVDA")).toBeVisible();
  await expect(page.getByTestId("pnl-chart").locator("canvas").first()).toBeVisible();

  const history = await (await page.request.get("/api/portfolio/history")).json();
  expect(history.length).toBeGreaterThan(1);
});

test("AI chat (mocked) executes a trade shown inline", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("chat-input").fill("buy 3 JPM");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-message-assistant").last()).toContainText("Mock response");
  await expect(page.getByTestId("chat-action").last()).toContainText("Bought 3 JPM");
  await expect(page.getByTestId("position-qty-JPM")).toHaveText("3");
});

test("SSE reconnects after a network failure", async ({ page }) => {
  // Fail the stream at the network level so EventSource enters its retry loop.
  await page.route("**/api/stream/prices", (route) => route.abort());
  await page.goto("/");
  const status = page.getByTestId("connection-status");
  await expect(status).toHaveAttribute("data-status", "reconnecting");
  await page.waitForTimeout(2_000);
  await expect(status).toHaveAttribute("data-status", "reconnecting");

  await page.unroute("**/api/stream/prices");
  await expect(status).toHaveAttribute("data-status", "connected", { timeout: 15_000 });
  await expect(page.getByTestId("price-AAPL")).not.toHaveText("--");
});
