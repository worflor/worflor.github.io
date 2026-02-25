import type { CollectionEntry } from "astro:content";
import { render } from "astro:content";

type Post = CollectionEntry<"posts">;

/** Normalize pubDate to YYYY-MM-DD string */
function normalizePubDate(pubDate: string | Date): string {
  if (pubDate instanceof Date) {
    return pubDate.toISOString().split("T")[0];
  }
  // If it's already a YYYY-MM-DD string, return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(pubDate)) {
    return pubDate;
  }
  // Otherwise try to parse and format
  const d = new Date(pubDate);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split("T")[0];
  }
  return pubDate;
}

/** Check if a post is "coming soon" (day is 00) */
export function isComingSoon(pubDate: string | Date): boolean {
  const normalized = normalizePubDate(pubDate);
  return normalized.endsWith("-00");
}

/** Sort posts by date, newest first. Returns new array. */
export function sortPostsByDate(posts: CollectionEntry<"posts">[]) {
  return [...posts].sort((a, b) => {
    const dateStrA = normalizePubDate(a.data.pubDate);
    const dateStrB = normalizePubDate(b.data.pubDate);
    // Treat -00 dates as the start of that month for sorting
    const dateA = new Date(dateStrA.replace(/-00$/, "-01")).getTime();
    const dateB = new Date(dateStrB.replace(/-00$/, "-01")).getTime();
    return dateB - dateA;
  });
}

/** Format date as YYYY-MM-DD */
export function formatPostDate(pubDate: string | Date): string {
  return normalizePubDate(pubDate);
}

/** Get "in the works" label */
export function getComingSoonLabel(_pubDate: string | Date): string {
  return "in the works...";
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
