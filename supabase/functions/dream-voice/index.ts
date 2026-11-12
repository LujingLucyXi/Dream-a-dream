// Dream a Dream voice proxy: Supabase Edge Function "dream-voice"
// Deployed in the Glomere project (ref jlvlmuyegirglbyrnfbl).
// The Dream a Dream page POSTs { text, voice } and this function calls
// OpenAI text-to-speech with the key held in Supabase secrets, so the
// key never appears in the page. It returns raw MP3 audio bytes; the
// page plays them in a real <audio> element, so playback keeps going
// with the phone screen locked (browser speech synthesis does not).
// Secrets: OPENAI_API_KEY (required), DREAM_ALLOWED_ORIGINS (recommended).
// "Verify JWT" stays OFF: the page has no Supabase login yet.

const MAX_CHARS = 6000; // bounds cost per call; the page sends parts of ≤1,400 chars
const VOICES = ["nova", "alloy", "echo", "fable", "onyx", "shimmer"];
const DEFAULT_VOICE = "nova"; // warm, soft voice for bedtime stories
// A long story is ~10 parts, and changing voice re-makes it; the six "Hello"
// previews count too. 200 an hour leaves plenty of room for a real listener.
const HOURLY_CALLS = 200;

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

  const body = await req.json().catch(() => ({}));
  const text = String(body.text || "").trim();
  if (!text) return deny(req, 400, "missing text");
  if (text.length > MAX_CHARS) return deny(req, 400, "text too long");

  const asked = String(body.voice || "").trim().toLowerCase();
  const voice = VOICES.includes(asked) ? asked : DEFAULT_VOICE;

  if (!(await withinAllowance(req, "voice", HOURLY_CALLS))) {
    return deny(req, 429, "too many requests — try again in a little while");
  }

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return deny(req, 500, "OPENAI_API_KEY not set");

  try {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice,
        input: text,
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      // Logged so a failing voice shows up in the Supabase function logs,
      // instead of only as the page quietly falling back to the device voice.
      console.error("tts failed", r.status, detail.slice(0, 300));
      return new Response(
        JSON.stringify({ error: "tts failed", status: r.status, detail: detail.slice(0, 300) }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsFor(req) } },
      );
    }
    const audio = await r.arrayBuffer();
    return new Response(audio, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", ...corsFor(req) },
    });
  } catch (e) {
    console.error("tts error", String(e));
    return deny(req, 502, String(e));
  }
});
