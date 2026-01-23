import { toString } from "mdast-util-to-string";

// Structural patterns - domain agnostic
// Using named groups where useful, all global for matchAll()
const PATTERNS = [
  /\b[a-z][a-z0-9_-]*:[a-z][a-z0-9_/-]+\b/gi,          // namespaced: x:y/z
  /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,                   // PascalCase
  /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g,                      // SCREAMING_SNAKE
  /\b\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?\b/gi,          // versions: 1.20.4
  /`(?<code>[^`]+)`/g,                                  // `inline code` - named group
];

export function remarkResonance() {
  return function (tree, { data }) {
    const text = toString(tree);
    const found = new Set();

    for (const pattern of PATTERNS) {
      // matchAll returns fresh iterator, no lastIndex issues
      for (const match of text.matchAll(pattern)) {
        // Use named group if present, else full match
        const value = match.groups?.code ?? match[0];
        if (value.length > 1) {
          found.add(value.toLowerCase());
        }
      }
    }

    data.astro.frontmatter.resonance = [...found];
  };
}
