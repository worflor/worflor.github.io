import { marked } from "marked";

/*
 * HTML sanitizer for marked.js output.
 *
 * Why not DOMPurify?
 * - DOMPurify is 15KB and needs jsdom (~1MB) for Node.js
 * - It's built for arbitrary untrusted HTML with SVG/MathML support
 * - We only sanitize marked.js output at build time, which is predictable:
 *   marked won't generate entity-encoded protocols, event handlers, or script tags
 *
 * What this does:
 * - Strips dangerous tags (script, iframe, svg, form, etc.)
 * - Strips event handlers (onclick, onerror, etc.)
 * - Strips style attributes (CSS injection vector)
 * - Blocks dangerous URI protocols, allows https/mailto/tel/relative/data:image
 *
 * What this doesn't do (and why):
 * - No DOM-based parsing: runs at build time in Node.js, no browser APIs needed
 * - No entity decoding: marked.js outputs plain "javascript:", not "&#106;avascript:"
 * - No mXSS handling: not parsing untrusted HTML that could mutate
 * - No SVG/MathML support: we block these entirely, smaller attack surface
 * - No DOM clobbering checks: output is static HTML, no runtime JS risk
 *
 * If you need to sanitize arbitrary user HTML at runtime, use DOMPurify instead.
 */

// Tags that get stripped entirely, content and all
const STRIP_TAGS = /(script|style|iframe|object|embed|form|input|textarea|button|select|svg|math|meta|link|base|template|noscript|frame|applet)/i;

// Protocols we allow in href/src. Everything else gets blocked.
// data:image/* is allowed for inline images, but not data:text/html or data:text/javascript
const SAFE_URI = /^(?:https?:|mailto:|tel:|\/|#|\?|data:image\/(?:png|jpe?g|gif|webp|avif))/i;

function sanitize(html: string): string {
  return html
    // Nuke dangerous tags - both paired (<script>...</script>) and self-closing (<input/>)
    .replace(new RegExp(`<(${STRIP_TAGS.source})\\b[^>]*>[\\s\\S]*?</\\1>`, "gi"), "")
    .replace(new RegExp(`<(${STRIP_TAGS.source})\\b[^>]*/?>`, "gi"), "")
    // HTML comments can hide content from some parsers
    .replace(/<!--[\s\S]*?-->/g, "")
    // Event handlers - the classic XSS vector
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // Style attrs can do javascript via expression() or url()
    .replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // Check URIs in href/src - strip whitespace first since browsers normalize it
    // "java\tscript:" becomes "javascript:" in browsers, so we catch that
    .replace(
      /((?:href|src)\s*=\s*)(["'])([^"']*)\2/gi,
      (match, attr, quote, url) => {
        const clean = url.replace(/[\x00-\x20]/g, "").trim();
        return SAFE_URI.test(clean) ? match : `${attr}${quote}#blocked${quote}`;
      }
    );
}

export function parseMarkdown(text: string): string {
  return text ? sanitize(marked.parse(text) as string) : "";
}

export const getLoadingPriority = (index: number, eagerCount = 2): "eager" | "lazy" =>
  index < eagerCount ? "eager" : "lazy";
