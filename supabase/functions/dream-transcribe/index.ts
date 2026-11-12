// Dream a Dream transcribe proxy: Supabase Edge Function "dream-transcribe"
// Deployed in the Glomere project (ref jlvlmuyegirglbyrnfbl).
// The Dream a Dream page records the user's voice with the browser
// microphone, then POSTs the audio here as multipart form-data
// (field "file"). This function forwards it to OpenAI Whisper and
// returns { text } as JSON, so the page can fill the dream/wish input
// with the transcript. The key never appears in the page.
// Secrets: OPENAI_API_KEY (required), DREAM_ALLOWED_ORIGINS (recommended).
// "Verify JWT" stays OFF: the page has no Supabase login yet.

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB audio cap
const HOURLY_CALLS = 40; // spoken dreams and wishes, per visitor

// ---- Guard (same block in all three Dream a Dream functions; keep in sync) ----
// 1. Only the app's own site may call this function from a browser.
//    Set the secret DREAM_ALLOWED_ORIGINS to a comma-separated list, e.g.
//    "https://dreamadream.ai,https://www.dreamadream.ai". While it is unset the
//    function behaves as before (any site), so deploying is never a breaking change.
// 2. Each visitor gets an hourly allowance. Counts live in the table made by
//    supabase/migrations/*_dream_rate_limits.sql (IP addresses are stored only as
//    a SHA-256 hash). If that table is missing or slow, a per-instance in-memory
//    count is used instead, so the app keeps working either way.
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

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") || "unknown";
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const memHits = new Map<string, { start: number; hits: number }>();
function memAllowed(key: string, max: number, windowS: number): boolean {
  const now = Date.now();
  const cur = memHits.get(key);
  if (!cur || now - cur.start > windowS * 1000) {
    memHits.set(key, { start: now, hits: 1 });
    if (memHits.size > 5000) memHits.clear();
    return true;
  }
  cur.hits++;
  return cur.hits <= max;
}

async function withinAllowance(req: Request, bucket: string, max: number, windowS = 3600): Promise<boolean> {
  const key = bucket + ":" + (await sha256(clientIp(req)));
  const url = Deno.env.get("SUPABASE_URL");
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) return memAllowed(key, max, windowS);
  try {
    const r = await fetch(`${url}/rest/v1/rpc/dream_rate_hit`, {
      method: "POST",
      headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_key: key, p_max: max, p_window_s: windowS }),
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return memAllowed(key, max, windowS);
    return (await r.json()) !== false;
  } catch {
    return memAllowed(key, max, windowS);
  }
}

function deny(req: Request, status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", ...corsFor(req) },
  });
}
// ---- end Guard ----

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsFor(req) });
  }
  if (req.method !== "POST") return deny(req, 405, "POST only");
  if (!originAllowed(req)) return deny(req, 403, "origin not allowed");

  const len = Number(req.headers.get("Content-Length") || "0");
  if (len > MAX_BYTES + 64 * 1024) return deny(req, 400, "audio too long");

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return deny(req, 500, "OPENAI_API_KEY not set");

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return deny(req, 400, "expected audio file");
  }
  if (!file || file.size === 0) return deny(req, 400, "empty audio");
  if (file.size > MAX_BYTES) return deny(req, 400, "audio too long");

  if (!(await withinAllowance(req, "transcribe", HOURLY_CALLS))) {
    return deny(req, 429, "too many requests — try again in a little while");
  }

  try {
    const out = new FormData();
    out.append("file", file, file.name || "dream.webm");
    out.append("model", "whisper-1");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: out,
      signal: AbortSignal.timeout(60000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return new Response(
        JSON.stringify({ error: "transcribe failed", status: r.status, detail: String(data?.error?.message || "").slice(0, 300) }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsFor(req) } },
      );
    }
    return new Response(JSON.stringify({ text: data.text || "" }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsFor(req) },
    });
  } catch (e) {
    return deny(req, 502, String(e));
  }
});
