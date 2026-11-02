import { defineConfig } from "@playwright/test";
import { photoMetadataUrl } from "./tests/browser/photoApi";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.TEST_BASE_URL || "http://127.0.0.1:3000",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  },
  webServer: [...(process.env.TEST_API_BASE_URL ? [] : [{
    command: "node --conditions=react-server --import tsx scripts/browser-test-backend.ts",
    url: photoMetadataUrl,
    reuseExistingServer: false,
    timeout: 60000,
  }]), {
    command: "npm run start",
    url: process.env.TEST_BASE_URL || "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  }],
});
