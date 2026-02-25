import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { remarkReadingTime } from "./src/plugins/remark-reading-time.ts";
import { remarkResonance } from "./src/plugins/remark-resonance.ts";
import tailwindcss from "@tailwindcss/vite";

import mailObfuscation from "astro-mail-obfuscation";

export default defineConfig({
  site: "https://woflo.dev",
  integrations: [sitemap(), mailObfuscation()],
  output: "static",
  trailingSlash: "never",
  prefetch: {
    // Avoid eagerly warming every route on first page load.
    // Keep intent-driven prefetching for better network efficiency.
    prefetchAll: false,
    defaultStrategy: "hover",
  },
  experimental: {
    clientPrerender: true,
  },
  compressHTML: true,

  markdown: {
    remarkPlugins: [remarkReadingTime, remarkResonance],
  },

  vite: {
    plugins: [tailwindcss()],
  },
});