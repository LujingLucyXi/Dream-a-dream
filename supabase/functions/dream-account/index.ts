// Dreameri account actions: Supabase Edge Function "dream-account"
// Deployed in the Dreameri project (ref jlvlmuyegirglbyrnfbl).
// POST { action: "delete" } with the signed-in user's access token in
// Authorization: Bearer <token>. Deletes that user; their dream_profiles and
// dream_user_state rows go with them (on delete cascade). Apple requires
// in-app account deletion for any app that lets people create an account.
// Uses the project's own SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, which
// Supabase provides to every edge function automatically.
// "Verify JWT" can stay ON for this function: only signed-in users call it.
// Optional secret: DREAM_ALLOWED_ORIGINS (same as the other functions).

const ALLOWED_ORIGINS = (Deno.env.get("DREAM_ALLOWED_ORIGINS") || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.length === 0
    ? "*"
    : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

function originAllowed(req: Request): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const origin = req.headers.get("Origin") || "";
  return ALLOWED_ORIGINS.includes(origin);
}

function reply(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsFor(req) },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsFor(req) });
  }
  if (req.method !== "POST") return reply(req, 405, { error: "POST only" });
  if (!originAllowed(req)) return reply(req, 403, { error: "origin not allowed" });

  const url = Deno.env.get("SUPABASE_URL");
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) return reply(req, 500, { error: "server not configured" });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(req, 401, { error: "sign in first" });

  const body = await req.json().catch(() => ({}));
  if (body.action !== "delete") return reply(req, 400, { error: "unknown action" });

  // Who is asking? Ask Supabase Auth to resolve the token to a user.
  const me = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: svc, Authorization: `Bearer ${token}` },
  });
  if (!me.ok) return reply(req, 401, { error: "sign in again" });
  const user = await me.json().catch(() => ({}));
  if (!user?.id) return reply(req, 401, { error: "sign in again" });

  // Delete exactly that user. Their Dreameri rows cascade away.
  const del = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
    method: "DELETE",
    headers: { apikey: svc, Authorization: `Bearer ${svc}` },
  });
  if (!del.ok) {
    const detail = await del.text().catch(() => "");
    console.error("account delete failed", del.status, detail.slice(0, 300));
    return reply(req, 502, { error: "could not delete — please try again" });
  }
  return reply(req, 200, { deleted: true });
});
