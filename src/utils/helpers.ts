import { marked } from "marked";

/**
 * HTML Sanitizer for Markdown Output
 *
 * Security model: Allowlist-only. If it's not explicitly allowed, it's removed.
 * Defense-in-depth: Multiple layers of validation, assume each layer can be bypassed.
 *
 * Attack vectors defended:
 * - XSS via script injection, event handlers, javascript: URIs
 * - mXSS (mutation XSS) via DOM parsing differences
 * - Protocol handler tricks (whitespace, null bytes, homographs)
 * - Entity encoding bypasses
 * - SVG/MathML namespace escapes
 * - DOM clobbering (partially - we limit dangerous id/name patterns)
 */

// =============================================================================
// PREPROCESSING - First line of defense
// =============================================================================

/**
 * Characters that can bypass sanitizers:
 * - Null bytes: can terminate strings early in some parsers
 * - Control chars: can be stripped inconsistently between parse/render
 * - Replacement char: sometimes used to bypass filters
 */
const DANGEROUS_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFD]/g;

/**
 * Preprocess: strip characters that enable parser differential attacks
 */
function preprocess(html: string): string {
  return html.replace(DANGEROUS_CHARS, "");
}

// =============================================================================
// URI VALIDATION - Critical for XSS prevention
// =============================================================================

/**
 * ASCII whitespace + null bytes that browsers strip from URL schemes.
 * Attackers use these to bypass naive protocol checks:
 *   "java\tscript:" -> browsers see "javascript:"
 *   "java&#9;script:" -> entity decodes to tab, then stripped
 */
const URI_WHITESPACE = /[\x00-\x20\x7F]/g;

/**
 * Only these protocols are safe. Everything else is blocked.
 */
const SAFE_PROTOCOLS = new Set(["http", "https", "mailto", "tel"]);

/**
 * Safe data: URI MIME types. NO SVG - it can contain scripts.
 */
const SAFE_DATA_MIMES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/avif"
]);

/**
 * Validate URI safety. This is critical - a bypass here means XSS.
 *
 * Attack vectors handled:
 * - javascript:, vbscript:, data:text/html
 * - Whitespace injection: java\tscript:, java\nscript:
 * - Null byte injection: java\x00script:
 * - Entity encoding: java&#9;script: (handled by caller - browser decodes)
 * - Homograph: jаvascript: (Cyrillic а) - blocked by ASCII-only protocol check
 */
function isSafeUri(uri: string): boolean {
  if (!uri) return true;

  // Strip ALL whitespace and control chars, not just trim edges
  // This defeats "java\tscript:" and "java\nscript:" attacks
  const clean = uri.replace(URI_WHITESPACE, "").toLowerCase();

  if (!clean) return true;

  // Relative URLs and anchors - always safe
  if (clean[0] === "/" || clean[0] === "#" || clean[0] === "?") {
    return true;
  }

  // Find protocol (everything before first colon)
  const colonIdx = clean.indexOf(":");
  if (colonIdx === -1) {
    // No protocol = relative URL
    return true;
  }

  const protocol = clean.slice(0, colonIdx);

  // Protocol MUST be ASCII letters only. This blocks:
  // - Homograph attacks: jаvascript: (Cyrillic looks like Latin)
  // - Weird Unicode protocols
  if (!/^[a-z]+$/.test(protocol)) {
    return false;
  }

  // Check against allowlist
  if (SAFE_PROTOCOLS.has(protocol)) {
    return true;
  }

  // data: URIs - only safe image types
  if (protocol === "data") {
    // Format: data:[<mediatype>][;base64],<data>
    const mimeMatch = clean.match(/^data:([^;,]+)/);
    if (mimeMatch && SAFE_DATA_MIMES.has(mimeMatch[1])) {
      return true;
    }
    return false;
  }

  // Any other protocol (javascript:, vbscript:, etc.) = blocked
  return false;
}

// =============================================================================
// ALLOWLISTS
// =============================================================================

/**
 * Safe HTML elements. Limited to what markdown generates.
 * Smaller allowlist = smaller attack surface.
 */
const ALLOWED_TAGS = new Set([
  // Structure
  "p", "br", "hr", "div", "span",
  // Headings
  "h1", "h2", "h3", "h4", "h5", "h6",
  // Lists
  "ul", "ol", "li", "dl", "dt", "dd",
  // Inline
  "a", "em", "strong", "code", "del", "s", "b", "i", "u", "mark", "small",
  "sub", "sup", "abbr", "kbd", "samp", "var", "q", "ins",
  // Block
  "blockquote", "pre", "img",
  // Tables
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "col", "colgroup",
  // Semantic
  "article", "section", "aside", "header", "footer", "main", "nav",
  "figure", "figcaption", "details", "summary",
  // Ruby
  "ruby", "rt", "rp",
  // Time
  "time",
  // Text node marker
  "#text"
]);

/**
 * Safe attributes. Minimal set needed for markdown output.
 */
const ALLOWED_ATTRS = new Set([
  // Links
  "href", "target", "rel", "download",
  // Images
  "src", "alt", "width", "height", "loading", "decoding",
  // Tables
  "colspan", "rowspan", "scope",
  // Lists
  "start", "reversed",
  // Global (but NOT 'name' - DOM clobbering risk)
  "id", "class", "title", "lang",
  // Time
  "datetime",
  // Accessibility
  "role"
]);

/**
 * Attributes that contain URLs - MUST be validated
 */
const URI_ATTRS = new Set(["href", "src", "cite", "poster"]);

/**
 * Dangerous ID patterns that enable DOM clobbering.
 * These IDs can shadow built-in document/window properties.
 */
const DANGEROUS_IDS = new Set([
  "location", "domain", "cookie", "referrer", "forms", "images", "links",
  "anchors", "scripts", "body", "head", "documentElement", "defaultView",
  "createElement", "getElementById", "querySelector", "write", "open",
  "close", "URL", "origin", "protocol", "host", "hostname", "port",
  "pathname", "search", "hash", "href"
]);

// =============================================================================
// DOM-BASED SANITIZER
// =============================================================================

/**
 * Sanitize element attributes. Defense-in-depth approach.
 */
function sanitizeAttributes(el: Element): void {
  // Copy array - we'll modify during iteration
  const attrs = Array.from(el.attributes);

  for (const attr of attrs) {
    const name = attr.name.toLowerCase();
    // Strip whitespace/null bytes from value (defeats entity-encoded attacks)
    const value = attr.value.replace(URI_WHITESPACE, "");

    // Layer 1: Block event handlers (onclick, onerror, onload, etc.)
    if (name.startsWith("on") || name.includes("on")) {
      // Also catch weird variations like "ONclick" or embedded "onclick"
      if (/\bon[a-z]/i.test(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
    }

    // Layer 2: Block dangerous attributes entirely
    if (name === "style" ||      // CSS injection (expression(), url())
        name === "srcdoc" ||     // Arbitrary HTML in iframe
        name === "is" ||         // Custom element hijacking
        name === "formaction" || // Form action override
        name === "xlink:href" || // SVG link (script execution)
        name.startsWith("xmlns") // Namespace injection
    ) {
      el.removeAttribute(attr.name);
      continue;
    }

    // Layer 3: Validate URLs in URI attributes
    if (URI_ATTRS.has(name)) {
      if (!isSafeUri(value)) {
        el.removeAttribute(attr.name);
        continue;
      }
    }

    // Layer 4: Check ID for DOM clobbering
    if (name === "id" && DANGEROUS_IDS.has(value.toLowerCase())) {
      el.removeAttribute(attr.name);
      continue;
    }

    // Layer 5: Allow aria-* and data-* (low risk, commonly used)
    if (name.startsWith("aria-") || name.startsWith("data-")) {
      continue;
    }

    // Layer 6: Final allowlist check
    if (!ALLOWED_ATTRS.has(name)) {
      el.removeAttribute(attr.name);
    }
  }
}

/**
 * DOM-based sanitization using browser's native parser.
 * Uses <template> element for isolated parsing.
 */
function sanitizeWithDOM(html: string): string {
  const preprocessed = preprocess(html);
  if (!preprocessed.trim()) return "";

  // Parse in isolated template element
  const template = document.createElement("template");
  template.innerHTML = preprocessed;
  const fragment = template.content;

  // Collect nodes to remove (can't modify during iteration)
  const nodesToRemove: Node[] = [];

  // Walk elements
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();

  while (node) {
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tag)) {
      nodesToRemove.push(node);
    } else {
      sanitizeAttributes(el);
    }
    node = walker.nextNode();
  }

  // Remove disallowed elements
  for (const n of nodesToRemove) {
    n.parentNode?.removeChild(n);
  }

  // Remove comments (can hide content, assist other attacks)
  const commentWalker = document.createTreeWalker(fragment, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  let comment = commentWalker.nextNode();
  while (comment) {
    comments.push(comment);
    comment = commentWalker.nextNode();
  }
  for (const c of comments) {
    c.parentNode?.removeChild(c);
  }

  // Serialize
  const div = document.createElement("div");
  div.appendChild(fragment.cloneNode(true));
  return div.innerHTML;
}

// =============================================================================
// REGEX-BASED SANITIZER (Node.js fallback)
// =============================================================================

const DANGEROUS_TAGS = [
  "script", "style", "iframe", "object", "embed", "form", "input", "textarea",
  "button", "select", "option", "meta", "link", "base", "template", "slot",
  "noscript", "frame", "frameset", "applet", "svg", "math", "audio", "video",
  "source", "track", "canvas", "portal", "xmp", "plaintext", "listing"
];

/**
 * Decode HTML entities (numeric and hex) in a string.
 * This is critical for detecting obfuscated attacks like &#106;avascript:
 */
function decodeEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    // Named entities commonly used in attacks
    .replace(/&Tab;/gi, "\t")
    .replace(/&NewLine;/gi, "\n")
    .replace(/&colon;/gi, ":")
    .replace(/&lpar;/gi, "(")
    .replace(/&rpar;/gi, ")")
    .replace(/&nbsp;/gi, " ");
}

/**
 * Check if a URI value (after entity decoding) is dangerous.
 */
function isDangerousUri(value: string): boolean {
  // Decode entities first - browser will do this when parsing
  const decoded = decodeEntities(value);
  // Strip whitespace (browser normalizes this in protocols)
  const clean = decoded.replace(/[\x00-\x20\x7F]/g, "").toLowerCase();

  // Check for dangerous protocols
  const colonIdx = clean.indexOf(":");
  if (colonIdx === -1) return false; // Relative URL

  const protocol = clean.slice(0, colonIdx);

  // Safe protocols
  if (protocol === "http" || protocol === "https" || protocol === "mailto" || protocol === "tel") {
    return false;
  }

  // data: is only safe for specific image types
  if (protocol === "data") {
    const mimeMatch = clean.match(/^data:([^;,]+)/);
    if (mimeMatch) {
      const mime = mimeMatch[1];
      if (["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/avif"].includes(mime)) {
        return false;
      }
    }
    return true; // Dangerous data: URI
  }

  // javascript:, vbscript:, etc.
  if (protocol === "javascript" || protocol === "vbscript" || protocol === "livescript") {
    return true;
  }

  // Unknown protocol - block it
  return !/^[a-z]+$/.test(protocol) || true; // Block all unknown
}

/**
 * Regex-based sanitization. Used at build time with trusted markdown.
 * Less secure than DOM-based, but acceptable for controlled input.
 */
function sanitizeWithRegex(html: string): string {
  let result = preprocess(html);
  if (!result.trim()) return "";

  // Strip comments and CDATA
  result = result.replace(/<!--[\s\S]*?-->/g, "");
  result = result.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, "");

  // Strip dangerous tags (content and self-closing)
  for (const tag of DANGEROUS_TAGS) {
    result = result.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
    result = result.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), "");
  }

  // Strip ALL event handlers (on* attributes) - also decode entities first
  result = result.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Also catch entity-encoded event handlers like o&#110;click
  result = result.replace(
    /\s+(?:o&#[x\d][^;]*;?n|on)(?:&#[x\d][^;]*;?|\w)+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    ""
  );

  // Strip style attribute
  result = result.replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Strip srcdoc attribute
  result = result.replace(/\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Sanitize href/src/cite/poster attributes - decode and check each one
  result = result.replace(
    /((?:href|src|cite|poster)\s*=\s*)(["'])([^"']*)\2/gi,
    (match, prefix, quote, value) => {
      if (isDangerousUri(value)) {
        return `${prefix}${quote}#blocked${quote}`;
      }
      return match;
    }
  );

  // Also handle unquoted attribute values
  result = result.replace(
    /((?:href|src|cite|poster)\s*=\s*)([^\s>"']+)/gi,
    (match, prefix, value) => {
      if (isDangerousUri(value)) {
        return `${prefix}#blocked`;
      }
      return match;
    }
  );

  return result;
}

// =============================================================================
// MAIN API
// =============================================================================

/**
 * Sanitize HTML for safe DOM insertion.
 * Uses DOM-based approach in browser, regex fallback for Node.js.
 */
function sanitizeHtml(html: string): string {
  if (!html || typeof html !== "string") return "";

  const isBrowser = typeof window !== "undefined" &&
                    typeof document !== "undefined" &&
                    typeof document.createElement === "function";

  return isBrowser ? sanitizeWithDOM(html) : sanitizeWithRegex(html);
}

/**
 * Parse markdown to sanitized HTML.
 * Safe for use with Astro's set:html directive.
 */
export function parseMarkdown(text: string): string {
  if (!text || typeof text !== "string") return "";
  const html = marked.parse(text) as string;
  return sanitizeHtml(html);
}

/**
 * Get loading priority based on index.
 */
export function getLoadingPriority(index: number, eagerCount = 2): "eager" | "lazy" {
  return index < eagerCount ? "eager" : "lazy";
}
