import { z, defineCollection } from "astro:content";
import { glob } from "astro/loaders";

const postsCollection = defineCollection({
  loader: glob({ pattern: "**/[^_]*.{md,mdx}", base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    pubDate: z.union([z.date(), z.string()]),
    description: z.string(),
    author: z.string(),
    images: z.array(z.object({
      url: z.string(),
      alt: z.string(),
    })).min(1),
    readingTime: z.string().optional(),
    resonance: z.array(z.string()).optional(),
  }),
});
export const collections = {
  posts: postsCollection,
};
