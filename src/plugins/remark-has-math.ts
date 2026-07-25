import type { Root } from "mdast";
import type { VFile } from "vfile";

/**
 * flags posts that actually contain math.
 *
 * katex's stylesheet is 23kb and exactly one post in the site renders an
 * equation, yet the import sat in the shared layout and therefore in the
 * stylesheet every route downloads. this lets the page decide.
 *
 * must run after remark-math, which is what creates the math nodes.
 */
export function remarkHasMath() {
  return function (tree: Root, { data }: VFile) {
    let found = false;

    const walk = (node: { type: string; children?: unknown[] }) => {
      if (found) return;
      if (node.type === "math" || node.type === "inlineMath") {
        found = true;
        return;
      }
      for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[]) {
        walk(child);
      }
    };
    walk(tree);

    (data.astro as { frontmatter: Record<string, unknown> }).frontmatter.hasMath = found;
  };
}
