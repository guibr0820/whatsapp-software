import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, "index.html"),
        signup: resolve(import.meta.dirname, "signup-screen.html"),
        login: resolve(import.meta.dirname, "login.html"),
        onboarding: resolve(import.meta.dirname, "onboarding.html"),
        plans: resolve(import.meta.dirname, "plans.html"),
        dashboard: resolve(import.meta.dirname, "dashboard.html"),
        terms: resolve(import.meta.dirname, "termos.html"),
        privacy: resolve(import.meta.dirname, "privacidade.html")
      }
    }
  }
});
