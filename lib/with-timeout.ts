/**
 * Race a promise against a timeout, resolving to `fallback` if it does not settle
 * in time. Never rejects — a rejection from `p` also resolves to `fallback`.
 *
 * This exists because of a real production bug: the /api/deep poll loop `await`ed
 * reads that could HANG on serverless (the @supabase/supabase-js `reports` read is
 * documented to stall — see lib/report-fetch.ts). One hung await stalled the whole
 * loop, so the function ran until Vercel's hard 300s cap ("Task timed out after 300
 * seconds") on every real scan. Wrapping every loop await in this makes a stall
 * impossible: the loop always makes progress and can honour its own deadline.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (v: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(fallback), ms);
    p.then(done, () => done(fallback));
  });
}
