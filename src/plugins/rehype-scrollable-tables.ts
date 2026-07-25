import type { Root, Element, ElementContent } from "hast";

/**
 * wraps every markdown table in a horizontally scrollable region.
 *
 * a prose table with nowrap headers cannot compress below its natural width, so
 * on a 390px phone it pushes the whole document sideways. wrapping is the only
 * fix that keeps the table a table: css alone cannot introduce the container.
 *
 * the wrapper is a real scroll region, which is why it carries role and
 * tabindex: a scrollable area that keyboard users cannot reach fails wcag 2.1.1.
 */
export function rehypeScrollableTables() {
  return function (tree: Root) {
    visit(tree, (node, index, parent) => {
      if (node.tagName !== "table" || !parent || index === null) return;
      if (parent.type === "element" && parent.tagName === "figure") return;

      const wrapper: Element = {
        type: "element",
        tagName: "figure",
        properties: {
          className: ["table-scroll"],
          role: "region",
          tabindex: 0,
          "aria-label": "Table, scrollable",
        },
        children: [node],
      };

      parent.children[index] = wrapper as ElementContent;
    });
  };
}

function visit(
  node: Root | Element,
  fn: (node: Element, index: number | null, parent: Root | Element | null) => void
) {
  const walk = (current: Root | Element, parent: Root | Element | null, index: number | null) => {
    if (current.type === "element") fn(current, index, parent);
    const children = (current as Root | Element).children;
    if (!children) return;
    // iterate over a snapshot: the callback swaps nodes in place
    [...children].forEach((child, i) => {
      if (child.type === "element") walk(child, current, i);
    });
  };
  walk(node, null, null);
}
