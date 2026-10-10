import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8001",
    viewport: { width: 1600, height: 950 },
  },
});
