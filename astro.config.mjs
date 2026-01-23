import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { remarkReadingTime } from "./src/plugins/remark-reading-time.mjs";
import { remarkResonance } from "./src/plugins/remark-resonance.mjs";
import tailwindcss from "@tailwindcss/vite";

import mailObfuscation from "astro-mail-obfuscation";

// https://astro.build/config
export default defineConfig({
  // Update this when you have your GitHub Pages URL or custom domain
  // For repo: https://username.github.io/repo-name/
  // For user site: https://username.github.io/
  site: "https://woflo.dev",
  integrations: [sitemap(), mailObfuscation()],
  output: "static",
  trailingSlash: "never",
  prefetch: {
    prefetchAll: true,
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