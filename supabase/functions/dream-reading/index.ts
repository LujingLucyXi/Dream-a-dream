// Dream Reader proxy: Supabase Edge Function "dream-reading"
// Deployed in the Glomere project (ref jlvlmuyegirglbyrnfbl).
// The Dream a Dream page POSTs { dream, theme, themeLabel, mood, lifeMoment, prompt }
// (and, for daydreams and sleep stories, a few extra fields) and this function
// calls OpenAI with the key held in Supabase secrets, so the key never appears
// in the page. It returns OpenAI's raw response; the page already parses
// OpenAI-style choices content.
// Secrets: OPENAI_API_KEY (required), DREAM_ALLOWED_ORIGINS (recommended).
// "Verify JWT" stays OFF: the page has no Supabase login yet. The guard below
// is what keeps strangers from using this as a free OpenAI proxy.

const SYSTEM = `You are a dream reader in the 周公解梦 tradition. Read the dream through the five elements (五行 Wood, Fire, Earth, Metal, Water), omens (兆), and timing (时机). Speak warmly and mysteriously, like an old book of signs, never like a clinical analysis or a ChatGPT summary. Every symbol must come from the dream itself. Give the reader hope and a reason to dream again tonight. For pregnancy dreams (胎梦), speak only of folk tradition, temperament and fortune as cultural stories, never a medical fact or a real gender prediction. This is folk tradition for fun, never real fortune-telling or medical fact. Return a JSON object with: title, symbols (array of 4 objects with name and meaning), mood, line (one line to remember), narrative (2-3 sentences), closing (one hopeful sentence pulling toward the next dream), xuan (object with dominant element, movement, omen, timing).`;

// Limits. The app's longest prompt (a sleep-story part with dream history woven
// in) is well under MAX_PROMPT_CHARS; a call that big is not from the app.
const MAX_PROMPT_CHARS = 60000;
const MAX_OUTPUT_TOKENS = 3000;
const MAX_OUTPUT_TOKENS_STORY = 4000; // a Chinese chapter runs longer in tokens; never cut a story mid-sentence
const HOURLY_CALLS = 60; // readings + daydream scenes + story parts, per visitor
// How long to wait for OpenAI. A sleep-story chapter is ~5 minutes of text and
// takes gpt-4o-mini roughly 12-25 s to write; at 14 s it was often cut off,
// and the page then fell back to its built-in story (same story every time,
// not about the wish). The page itself waits 45 s, so stay just under that.
const TIMEOUT_MS_STORY = 42000;
const TIMEOUT_MS_DEFAULT = 14000;

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

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsFor(req) },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsFor(req) });
  }
  if (req.method !== "POST") return deny(req, 405, "POST only");
  if (!originAllowed(req)) return deny(req, 403, "origin not allowed");

  const body = await req.json().catch(() => ({}));
  const userPrompt = String(
    body.prompt ||
      [body.dream, body.themeLabel, body.mood, body.lifeMoment]
        .filter(Boolean)
        .join("\n"),
  );
  if (!userPrompt.trim()) return deny(req, 400, "missing dream");
  if (userPrompt.length > MAX_PROMPT_CHARS) return deny(req, 413, "too long");

  if (!(await withinAllowance(req, "reading", HOURLY_CALLS))) {
    return deny(req, 429, "too many requests — try again in a little while");
  }

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return deny(req, 500, "OPENAI_API_KEY not set");

  const kind = String(body.type || body.kind || "reading");
  const isStory = kind === "sleep-story" || kind === "sleepstory";
  const started = Date.now();

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.9,
        max_tokens: isStory ? MAX_OUTPUT_TOKENS_STORY : MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(isStory ? TIMEOUT_MS_STORY : TIMEOUT_MS_DEFAULT),
    });
    const data = await r.json();
    if (!r.ok) {
      // Logged so failures show up in Supabase -> Edge Functions -> Logs,
      // instead of only as the page quietly using its built-in text.
      console.error(kind, "openai error", r.status, Date.now() - started, "ms", JSON.stringify(data?.error || {}).slice(0, 300));
    }
    return json(req, data, r.status);
  } catch (e) {
    console.error(kind, "failed after", Date.now() - started, "ms:", String(e));
    return json(req, { error: String(e) }, 502);
  }
});
