/**
 * The npm package name from the /npm/[...pkg] segments. Next.js hands catch-all
 * segments over still percent-encoded, so a scoped report URL
 * (/npm/%40scope/name, as the API links it) arrives as "%40scope"; each segment
 * is decoded before the lookup. A malformed escape stays as written.
 */
export function packageName(segments: string[] | undefined): string {
  return (segments ?? [])
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");
}
