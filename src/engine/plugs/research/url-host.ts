// The hostname of a URL, lowercased by the URL parser; null when it does not parse.
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
