import { marked } from "marked";

/** Strips dangerous HTML elements and attributes for XSS protection */
function sanitizeHtml(html: string): string {
  let result = html;

  // Remove dangerous tags with their content
  const dangerousTags = [
    "script", "style", "iframe", "object", "embed", "form",
    "input", "textarea", "button", "select", "meta", "link",
    "base", "svg", "math", "template", "noscript"
  ];

  for (const tag of dangerousTags) {
    // Paired tags with content
    result = result.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
    // Self-closing or unclosed
    result = result.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), "");
  }

  // Remove event handlers (on*="..." or on*=value)
  result = result.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Remove dangerous URL protocols (allow data: only for common images)
  result = result.replace(
    /(href|src|action|formaction|poster)\s*=\s*["']?\s*(javascript|vbscript|data\s*:(?!image\/(?:png|jpe?g|gif|webp)))[^"'\s>]*/gi,
    '$1="#"'
  );

  // Remove style attributes (expression(), url() attack vectors)
  result = result.replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Remove srcdoc (can contain arbitrary HTML)
  result = result.replace(/\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  return result;
}

/** Parse markdown to sanitized HTML, safe for set:html */
export function parseMarkdown(text: string): string {
  const html = marked.parse(text) as string;
  return sanitizeHtml(html);
}

/**
 * Get loading priority based on index (eager for first N items, lazy for rest)
 * @param index - Item index (0-based)
 * @param eagerCount - Number of items to load eagerly (default: 2)
 */
export function getLoadingPriority(index: number, eagerCount = 2): "eager" | "lazy" {
  return index < eagerCount ? "eager" : "lazy";
}
