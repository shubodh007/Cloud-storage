// CloudBox Supabase client — browser talks to Supabase directly (no custom backend).
// Uses publishable anon key only. Never put privileged server keys here.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

let client = null;

export function getConfig() {
  const c = window.CLOUDBOX_CONFIG || {};
  const url = (c.SUPABASE_URL || "").trim();
  const key = (c.SUPABASE_ANON_KEY || "").trim();
  const looksPlaceholder = !url || !key || url.includes("YOUR-PROJECT") || key.includes("YOUR-ANON");
  return { url, key, configured: !looksPlaceholder && url.startsWith("https://") };
}

export function isConfigured() {
  return getConfig().configured;
}

export function getClient() {
  if (client) return client;
  const { url, key, configured } = getConfig();
  if (!configured) return null;
  client = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export async function getSession() {
  const sb = getClient();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session || null;
}

/** Redirect unauthenticated visitors to login. Returns session or null (after redirect). */
export async function requireAuth(loginHref = "login.html") {
  const session = await getSession();
  if (!session) {
    const next = encodeURIComponent(location.pathname.split("/").pop() || "dashboard.html");
    location.href = `${loginHref}?next=${next}`;
    return null;
  }
  return session;
}

/** Bounce authenticated visitors away from login/register. */
export async function redirectIfAuthed(dashboardHref = "dashboard.html") {
  const session = await getSession();
  if (session) location.href = dashboardHref;
  return session;
}

export function friendlyAuthError(err, fallback) {
  const msg = (err && err.message ? err.message : "") || "";
  if (/invalid login credentials/i.test(msg)) return "Invalid email or password.";
  if (/user already registered|already exists/i.test(msg)) return "An account with this email already exists. Try logging in.";
  if (/email not confirmed/i.test(msg)) return "Please confirm your email first, then log in. (Disable confirm-email in Supabase Auth if this is a class demo.)";
  if (/password/i.test(msg) && /weak|short|least|6/i.test(msg)) return "Password must be at least 6 characters.";
  if (/fetch|network|load failed/i.test(msg)) return "Unable to connect. Check your internet and Supabase URL, then try again.";
  return fallback || msg || "Something went wrong. Please try again.";
}
