import { toString } from "mdast-util-to-string";
import type { Root } from "mdast";
import type { VFile } from "vfile";

const PATTERNS = [
  /\b[a-z][a-z0-9_-]*:[a-z][a-z0-9_/-]+\b/gi,
  /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,
  /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g,
  /\b\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?\b/gi,
  /`(?<code>[^`]+)`/g,
];

export function remarkResonance() {
  return function (tree: Root, { data }: VFile) {
    const text = toString(tree);
    const found = new Set<string>();

    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const value = match.groups?.code ?? match[0];
        if (value.length > 1) {
          found.add(value.toLowerCase());
        }
      }
    }

    (data.astro as { frontmatter: Record<string, unknown> }).frontmatter.resonance = [...found];
  };
}
