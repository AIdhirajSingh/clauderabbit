/**
 * The 2.0 preview shows 2.0 scans only. The 1.0-style report routes still in this
 * code (/<owner>/<repo>, /npm/<pkg>, their OG images, /badge, /api/report,
 * /api/export/*) read 1.0-era data paths, so on a Vercel Preview they answer a
 * plain 404 until the migration. Production behaviour is unchanged.
 */

export function hidesLegacyRoutes(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "preview";
}

export function plainNotFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
