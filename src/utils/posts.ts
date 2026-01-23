import type { CollectionEntry } from "astro:content";
import { render } from "astro:content";

type Post = CollectionEntry<"posts">;

/** Sort posts by date, newest first. Returns new array. */
export function sortPostsByDate(posts: CollectionEntry<"posts">[]) {
  return [...posts].sort((a, b) => {
    const dateA = new Date(a.data.pubDate).getTime();
    const dateB = new Date(b.data.pubDate).getTime();
    return dateB - dateA;
  });
}

/** Format date as YYYY-MM-DD (UTC) */
export function formatPostDate(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "UTC" });
}

/** Sort posts and populate reading time. Returns new array. */
export async function preparePosts(
  posts: CollectionEntry<"posts">[],
  limit?: number
): Promise<CollectionEntry<"posts">[]> {
  const sorted = sortPostsByDate(posts);
  const targetPosts = limit !== undefined ? sorted.slice(0, limit) : sorted;

  for (const post of targetPosts) {
    const { remarkPluginFrontmatter } = await render(post);
    post.data.readingTime = remarkPluginFrontmatter?.minutesRead;
  }

  return targetPosts;
}

// Cache resonance data to avoid repeated render() calls
type ResonanceIndex = Map<string, string[]>;

/** Build resonance index once - call this in getStaticPaths */
export async function buildResonanceIndex(posts: Post[]): Promise<ResonanceIndex> {
  const index: ResonanceIndex = new Map();
  for (const post of posts) {
    const { remarkPluginFrontmatter } = await render(post);
    index.set(post.id, remarkPluginFrontmatter?.resonance || []);
  }
  return index;
}

/** Find posts related by shared resonance patterns */
export function getRelatedPosts(
  currentId: string,
  all: Post[],
  index: ResonanceIndex,
  limit = 3
): Post[] {
  const currentPatterns = new Set(index.get(currentId) || []);
  if (currentPatterns.size === 0) return [];

  const scored: { post: Post; score: number }[] = [];

  for (const post of all) {
    if (post.id === currentId) continue;

    const otherPatterns = index.get(post.id) || [];

    let score = 0;
    for (const pattern of otherPatterns) {
      if (currentPatterns.has(pattern)) {
        score++;
      }
    }

    if (score > 0) {
      scored.push({ post, score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.post);
}
