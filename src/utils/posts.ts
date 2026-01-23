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

  const results = await Promise.all(
    targetPosts.map(post => render(post))
  );
  results.forEach((result, i) => {
    targetPosts[i].data.readingTime = result.remarkPluginFrontmatter?.minutesRead;
  });

  return targetPosts;
}

// Cache resonance data to avoid repeated render() calls
type ResonanceIndex = Map<string, string[]>;

/** Build resonance index once - call this in getStaticPaths */
export async function buildResonanceIndex(posts: Post[]): Promise<ResonanceIndex> {
  const results = await Promise.all(
    posts.map(async post => ({
      id: post.id,
      resonance: (await render(post)).remarkPluginFrontmatter?.resonance || [],
    }))
  );
  const index: ResonanceIndex = new Map();
  results.forEach(({ id, resonance }) => index.set(id, resonance));
  return index;
}

/** Find posts related by shared resonance patterns */
export function getRelatedPosts(currentId: string, all: Post[], index: ResonanceIndex, limit = 3): Post[] {
  const current = new Set(index.get(currentId) || []);
  if (!current.size) return [];

  return all
    .filter(p => p.id !== currentId)
    .map(p => ({ p, score: (index.get(p.id) || []).filter(k => current.has(k)).length }))
    .filter(x => x.score)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.p);
}
