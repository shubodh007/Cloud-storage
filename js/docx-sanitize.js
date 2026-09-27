// CloudBox DOCX sanitizer — allowlist-based, no regex filtering.
// Mammoth HTML is document-derived UNTRUSTED input: it is generated from a
// user-uploaded .docx (plus Mammoth's own serializer), so it must never reach
// innerHTML unsanitized. DOMPurify (Cure53, the established browser HTML
// sanitizer) does the parsing/serialization safely; this module only declares
// the narrow allowlist + post-sanitize hardening. A hand-rolled regex
// sanitizer would be unsafe — hence the dependency.
//
// This module is intentionally dependency-free (the DOMPurify instance is
// passed in) so the exact production config is unit-testable in Node.
export const DOCX_ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "strong", "b", "em", "i", "u", "s", "sup", "sub",
  "a", "img", "blockquote", "pre", "code", "hr", "span", "div",
];

export const DOCX_ALLOWED_ATTR = [
  "href", "title", "alt", "src", "colspan", "rowspan", "start", "target", "rel",
];

export const DOCX_FORBID_TAGS = [
  "script", "style", "form", "input", "button", "textarea", "select", "option",
  "iframe", "object", "embed", "link", "meta", "base", "canvas", "video",
  "audio", "source", "track", "noscript", "template", "slot", "frame",
  "frameset", "picture", "svg", "math", "details", "dialog",
];

// Strict URL policy: only web links, mail/phone, page anchors, and our own
// generated blob: image URLs survive — in href or src. Everything else
// (javascript:, data:, vbscript:, file:, relative paths, …) is dropped.
// An allowlist (rather than DOMPurify's broader default) also defeats
// scheme-obfuscation tricks, since nothing outside these prefixes can pass.
const SAFE_URL = /^(?:https?:\/\/|mailto:|tel:|blob:|#)/i;
function hardenNode(node) {
  if (!node || node.nodeType !== 1) return;
  const tag = (node.tagName || "").toUpperCase();
  if (tag === "A") {
    const href = node.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    } else if (!/^(mailto:|tel:|#)/i.test(href)) {
      node.removeAttribute("href");
    }
  }
  if (tag === "IMG") {
    const src = node.getAttribute("src") || "";
    if (!src.startsWith("blob:")) node.removeAttribute("src");
    node.setAttribute("alt", node.getAttribute("alt") || "");
    node.setAttribute("loading", "lazy");
  }
}

const hooked = new WeakSet();

export function sanitizeDocxHtml(purify, dirty) {
  if (!purify || typeof purify.sanitize !== "function" || typeof purify.addHook !== "function") {
    throw new Error("sanitizer unavailable");
  }
  if (!hooked.has(purify)) {
    purify.addHook("afterSanitizeAttributes", hardenNode);
    hooked.add(purify);
  }
  return purify.sanitize(String(dirty || ""), {
    ALLOWED_TAGS: DOCX_ALLOWED_TAGS,
    ALLOWED_ATTR: DOCX_ALLOWED_ATTR,
    FORBID_TAGS: DOCX_FORBID_TAGS,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: SAFE_URL,
    KEEP_CONTENT: true,
  });
}
