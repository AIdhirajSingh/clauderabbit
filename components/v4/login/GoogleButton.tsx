"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * "Continue with Google" (Login.dc.html): starts Supabase Google OAuth. The provider returns to /auth/callback,
 * which exchanges the code for a session (cookies written server-side) and redirects to /app.
 */
export function GoogleButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const { error: oauthError } = await createClient().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${location.origin}/auth/callback?next=/app` },
      });
      // On success the browser is already navigating to Google; stay pending.
      if (oauthError) {
        setError("Could not start Google sign in. Please try again.");
        setPending(false);
      }
    } catch {
      setError("Could not start Google sign in. Please try again.");
      setPending(false);
    }
  };

  return (
    <>
      <button type="button" onClick={onClick} aria-busy={pending} disabled={pending} className="btn btn-p" style={{ marginTop: "32px", width: "100%", opacity: pending ? 0.7 : 1 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 01-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" /><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0012 22z" /><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 000 9.2z" /><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 003.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1z" /></svg> Continue with Google
      </button>
      {error && (
        <p role="alert" style={{ margin: "12px 0 0", fontSize: "14px", color: "#FF9592" }}>
          {error}
        </p>
      )}
    </>
  );
}
