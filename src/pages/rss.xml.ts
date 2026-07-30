/*
 * the blog's feed.
 *
 * the site had no way to be followed. no feed, no changelog, nothing that told
 * a returning visitor anything had moved, which meant every visit had to be
 * remembered rather than delivered. this is the cheapest fix for that and the
 * only one that asks nobody for an email address.
 *
 * written by hand rather than with @astrojs/rss on purpose: adding a dependency
 * would mean editing package.json, and package.json is already carrying
 * unrelated uncommitted work. rss 2.0 is a small enough spec to just meet.
 */

import type { APIContext } from "astro";
import { getCollection } from "astro:content";
import { sortPostsByDate, isComingSoon, formatPostDate } from "../utils/posts";
import { blogPageContent } from "../config";

export const prerender = true;

const escape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// rss wants rfc-822. toUTCString produces the rfc-1123 form of it, which every
// reader accepts, and it keeps the timezone honest instead of pretending a
// date-only frontmatter value carries one.
const rfc822 = (date: string): string => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toUTCString();
};

export async function GET(context: APIContext): Promise<Response> {
  const site = context.site?.href.replace(/\/$/, "") ?? "https://woflo.dev";

  // posts dated -00 are the "in the works" placeholders the blog index renders
  // as unlinked teasers. a feed entry for one would be an item pointing at a
  // page that does not exist yet.
  const posts = sortPostsByDate(await getCollection("posts")).filter(
    (post) => !isComingSoon(post.data.pubDate)
  );

  const items = posts
    .map((post) => {
      const url = `${site}/blog/${post.id}`;
      const published = rfc822(formatPostDate(post.data.pubDate));
      return [
        "    <item>",
        `      <title>${escape(post.data.title)}</title>`,
        `      <link>${escape(url)}</link>`,
        `      <guid isPermaLink="true">${escape(url)}</guid>`,
        `      <description>${escape(post.data.description)}</description>`,
        // dc:creator rather than rss's own <author>, which is specified to
        // carry an email address. the rest of the site runs addresses through
        // astro-mail-obfuscation, and publishing one in plaintext to every
        // scraper that reads feeds would quietly undo that.
        `      <dc:creator>${escape(post.data.author)}</dc:creator>`,
        published ? `      <pubDate>${published}</pubDate>` : "",
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escape(blogPageContent.seo.title)}</title>
    <link>${escape(`${site}/blog`)}</link>
    <description>${escape(blogPageContent.seo.description)}</description>
    <language>en</language>
    <atom:link href="${escape(`${site}/rss.xml`)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
