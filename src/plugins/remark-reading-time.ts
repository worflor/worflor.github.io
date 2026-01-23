import getReadingTime from "reading-time";
import { toString } from "mdast-util-to-string";
import type { Root } from "mdast";
import type { VFile } from "vfile";

export function remarkReadingTime() {
  return function (tree: Root, { data }: VFile) {
    const textOnPage = toString(tree);
    const readingTime = getReadingTime(textOnPage);
    (data.astro as { frontmatter: Record<string, unknown> }).frontmatter.minutesRead = readingTime.text;
  };
}
