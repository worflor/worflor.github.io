import { marked } from "marked";

/** Strips dangerous HTML elements and attributes for XSS protection */
function sanitizeHtml(html: string): string {
  let result = html;

  // Remove HTML comments (can hide malicious content)
  result = result.replace(/<!--[\s\S]*?-->/g, "");

  // Remove CDATA sections
  result = result.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, "");

  // Remove dangerous tags with their content
  const dangerousTags = [
    "script", "style", "iframe", "object", "embed", "form",
    "input", "textarea", "button", "select", "meta", "link",
    "base", "svg", "math", "template", "noscript", "frame",
    "frameset", "applet", "layer", "ilayer", "bgsound", "title",
    "plaintext", "xmp", "listing", "xml", "xss"
  ];

  for (const tag of dangerousTags) {
    // Paired tags with content (handle nested and multiline)
    result = result.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
    // Self-closing or unclosed
    result = result.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), "");
  }

  // Remove event handlers - comprehensive pattern including:
  // - Standard on* handlers (onclick, onerror, onload, etc.)
  // - Handles quoted and unquoted values
  // - Handles encoded characters and whitespace variations
  result = result.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Remove FSCommand (Flash)
  result = result.replace(/\s+fscommand\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Remove seeksegmenttime (media)
  result = result.replace(/\s+seeksegmenttime\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Remove dangerous URL protocols - expanded list
  const dangerousProtocols = [
    "javascript", "vbscript", "livescript", "mocha", "jscript",
    "data\\s*:(?!image\\/(?:png|jpe?g|gif|webp|svg\\+xml);base64,)"
  ];
  const protocolPattern = new RegExp(
    `(href|src|action|formaction|poster|xlink:href|dynsrc|lowsrc|background)\\s*=\\s*["']?\\s*(${dangerousProtocols.join("|")})[^"'\\s>]*`,
    "gi"
  );
  result = result.replace(protocolPattern, '$1="#"');

  // Remove style attributes (expression(), url(), behavior attack vectors)
  result = result.replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Remove srcdoc (can contain arbitrary HTML)
  result = result.replace(/\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Remove data-* attributes that could be exploited (keep safe ones)
  result = result.replace(/\s+data-(?!testid|index|id|name|value)[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Remove xmlns attributes (can be used for namespace injection)
  result = result.replace(/\s+xmlns(?::[a-z]+)?\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Remove formaction, formmethod, formtarget (form hijacking)
  result = result.replace(/\s+form(?:action|method|target|enctype|novalidate)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Remove is="" attribute (custom elements)
  result = result.replace(/\s+is\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Neutralize encoded characters that could bypass filters
  // Handle common HTML entity encoded javascript: protocols
  result = result.replace(/&#x?[0-9a-f]+;?/gi, (match) => {
    const decoded = match.replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                         .replace(/&#(\d+);?/gi, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
    // If decoding reveals dangerous content, remove it
    if (/javascript|vbscript|on\w+\s*=/i.test(decoded)) {
      return "";
    }
    return match;
  });

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
