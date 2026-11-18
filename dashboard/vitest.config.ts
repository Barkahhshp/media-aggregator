import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["dashboard/tests/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    clearMocks: true,
    restoreMocks: true,
  },
});
