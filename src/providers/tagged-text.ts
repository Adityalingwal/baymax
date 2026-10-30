// User, page and model text in a prompt is untrusted: escaping keeps it from closing or opening a block.
export function escapeText(text: string): string {
  return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Escaped text in one tagged block.
export function taggedText(tag: string, text: string): string {
  return `<${tag}>\n${escapeText(text)}\n</${tag}>`;
}
