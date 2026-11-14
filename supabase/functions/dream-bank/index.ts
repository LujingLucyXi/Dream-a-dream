// Dreameri: Supabase Edge Function "dream-bank" — the Dream Bank.
// Sleep stories dreamers chose to leave for others: anonymised, screened,
// voiced once, kept for 30 days. Every later listen plays the saved audio,
// so it costs (almost) nothing.
//
// POST { action: "list", mood?, sign?, lang? }        -> { stories: [...] } (no full text)
// POST { action: "listen", id }                        -> { story, audioUrl, ... }  (free: BANK_FREE_PER_DAY a day; Pro: unlimited)
// POST { action: "share", title, story, sign, mood, lens, lang, voice, minutes }  (signed in; SHARES_PER_DAY a day)
// POST { action: "report", id }                        -> hidden after 3 reports
// POST { action: "remove", id }                        -> the author removes their own story
//
// Deploy with --no-verify-jwt (visitors can browse; the token is checked here).
// Secrets: OPENAI_API_KEY (already set). Needs migration 20261114100000_dream_bank.sql.

const BANK_FREE_PER_DAY = 1;
const SHARES_PER_DAY = 3;
const MAX_STORY_CHARS = 40000;
const VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

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

async function whoIs(req: Request): Promise<{ id: string; plan: string } | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!url || !svc || !token || token.split(".").length !== 3) return null;
  try {
    const me = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: svc, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!me.ok) return null;
    const user = await me.json().catch(() => ({}));
    if (!user?.id) return null;
    const pr = await fetch(`${url}/rest/v1/dream_profiles?user_id=eq.${user.id}&select=plan`, {
      headers: { apikey: svc, Authorization: `Bearer ${svc}` },
      signal: AbortSignal.timeout(3000),
    });
    const rows = pr.ok ? await pr.json().catch(() => []) : [];
    return { id: user.id, plan: rows?.[0]?.plan === "full" ? "full" : "free" };
  } catch {
    return null;
  }
}

async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
  const url = Deno.env.get("SUPABASE_URL")!, svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const r = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) { console.error("rpc", name, r.status, (await r.text().catch(() => "")).slice(0, 200)); return null; }
  return r.status === 204 ? true : await r.json().catch(() => true);
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL")!, svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
}
function audioUrl(path: string | null): string | null {
  if (!path) return null;
  return `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/dream-bank/${path}`;
}

// Screen + anonymise a story before it enters the bank.
async function screen(title: string, story: string, lang: string): Promise<{ ok: boolean; title: string; story: string; reason?: string }> {
  const key = Deno.env.get("OPENAI_API_KEY")!;
  const prompt = `You prepare bedtime stories for a public, anonymous library of sleep stories.
1. SAFETY: if the story contains sexual content, graphic violence, self-harm, hate, or anything unsuitable for a calm public bedtime library, return {"ok":false,"reason":"short reason"}.
2. Otherwise ANONYMISE: replace every real-looking personal name with a gentle generic one ("a friend", "her brother", or an invented first name), remove street names, schools, workplaces, phone numbers, emails and anything that could identify a real person. Keep everything else word for word — do not shorten, summarise or restyle.
3. Give it a short poetic title (max 6 words) in the story's language.
Return ONLY JSON: {"ok":true,"title":"...","story":"..."}
${lang === "zh" ? "The story is in Chinese; keep it in Simplified Chinese." : ""}

TITLE: ${title}
STORY:
${story}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.2, max_tokens: 16000, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error("screen failed " + r.status);
  const d = await r.json();
  const j = JSON.parse(d?.choices?.[0]?.message?.content || "{}");
  if (!j.ok) return { ok: false, title, story, reason: String(j.reason || "not suitable") };
  const out = String(j.story || "");
  if (out.length < story.length * 0.7) return { ok: true, title: String(j.title || title), story }; // never accept a shortened story
  return { ok: true, title: String(j.title || title).slice(0, 80), story: out };
}

function chunks(text: string, size = 3800): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = Math.max(rest.lastIndexOf(". ", size), rest.lastIndexOf("。", size));
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

async function voiceStory(story: string, voice: string): Promise<Uint8Array> {
  const key = Deno.env.get("OPENAI_API_KEY")!;
  const bufs = await Promise.all(chunks(story).map(async (input) => {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tts-1", voice, input, response_format: "mp3" }),
      signal: AbortSignal.timeout(110000),
    });
    if (!r.ok) throw new Error("tts " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
    return new Uint8Array(await r.arrayBuffer());
  }));
  const total = bufs.reduce((n, b) => n + b.length, 0), out = new Uint8Array(total);
  let o = 0; for (const b of bufs) { out.set(b, o); o += b.length; }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsFor(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "POST only" });
  if (!originAllowed(req)) return reply(req, 403, { error: "origin not allowed" });
  const body = await req.json().catch(() => ({}));
  const who = await whoIs(req);
  const subject = who ? "u:" + who.id : "ip:" + (await sha256(clientIp(req)));
  try {
    if (body.action === "list") {
      const q = ["select=id,created_at,expires_at,title,sign,mood,lens,lang,voice,minutes,listens", "order=created_at.desc", "limit=60"];
      if (body.mood) q.push("mood=eq." + encodeURIComponent(String(body.mood)));
      if (body.lang) q.push("lang=eq." + encodeURIComponent(String(body.lang)));
      const r = await rest("dream_bank_public?" + q.join("&"));
      const rows = r.ok ? await r.json() : [];
      const left = who?.plan === "full" ? null : await rpc("dream_reading_take", { p_subject: "bank:" + subject, p_limit: BANK_FREE_PER_DAY, p_take: false });
      return reply(req, 200, { stories: rows, listensLeft: left, plan: who?.plan || "free" });
    }
    if (body.action === "listen") {
      const id = String(body.id || "");
      if (!/^[0-9a-f-]{36}$/.test(id)) return reply(req, 400, { error: "bad id" });
      const r = await rest(`dream_bank_public?id=eq.${id}&select=*`);
      const row = (r.ok ? await r.json() : [])[0];
      if (!row) return reply(req, 404, { error: "this story has drifted away" });
      if (who?.plan !== "full") {
        const left = await rpc("dream_reading_take", { p_subject: "bank:" + subject, p_limit: BANK_FREE_PER_DAY, p_take: true });
        if (left === -1) return reply(req, 402, { error: "free_limit", what: "bank", limit: BANK_FREE_PER_DAY, plan: who?.plan || "free" });
      }
      await rpc("dream_bank_listen", { p_id: id });
      return reply(req, 200, { ...row, audioUrl: audioUrl(row.audio_path) });
    }
    if (body.action === "report") {
      const id = String(body.id || "");
      if (/^[0-9a-f-]{36}$/.test(id)) await rpc("dream_bank_report", { p_id: id });
      return reply(req, 200, { ok: true });
    }
    if (!who) return reply(req, 401, { error: "sign in to share a story" });
    if (body.action === "remove") {
      const id = String(body.id || "");
      if (!/^[0-9a-f-]{36}$/.test(id)) return reply(req, 400, { error: "bad id" });
      await rest(`dream_bank?id=eq.${id}&author=eq.${who.id}`, { method: "PATCH", body: JSON.stringify({ hidden: true }), headers: { Prefer: "return=minimal" } });
      return reply(req, 200, { ok: true });
    }
    if (body.action === "share") {
      const story = String(body.story || "").trim(), lang = body.lang === "zh" ? "zh" : "en";
      if (story.length < 200) return reply(req, 400, { error: "story too short" });
      if (story.length > MAX_STORY_CHARS) return reply(req, 400, { error: "story too long" });
      const left = await rpc("dream_reading_take", { p_subject: "share:" + who.id, p_limit: SHARES_PER_DAY, p_take: true });
      if (left === -1) return reply(req, 429, { error: "you can leave up to " + SHARES_PER_DAY + " stories a day" });
      const s = await screen(String(body.title || "A sleep story").slice(0, 120), story, lang);
      if (!s.ok) return reply(req, 422, { error: "not_suitable", reason: s.reason });
      const voice = VOICES.includes(String(body.voice)) ? String(body.voice) : "nova";
      const id = crypto.randomUUID();
      const mp3 = await voiceStory(s.story, voice);
      const url = Deno.env.get("SUPABASE_URL")!, svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const up = await fetch(`${url}/storage/v1/object/dream-bank/${id}.mp3`, {
        method: "POST",
        headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "audio/mpeg", "x-upsert": "true", "cache-control": "31536000" },
        body: new Blob([mp3 as BlobPart], { type: "audio/mpeg" }),
      });
      if (!up.ok) throw new Error("upload " + up.status + " " + (await up.text().catch(() => "")).slice(0, 200));
      const ins = await rest("dream_bank", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          id, author: who.id, title: s.title, story: s.story, lang, voice, audio_path: id + ".mp3",
          sign: String(body.sign || "").slice(0, 40) || null, mood: String(body.mood || "").slice(0, 40) || null,
          lens: String(body.lens || "").slice(0, 20) || null, minutes: Math.max(1, Math.min(60, Number(body.minutes) || 5)),
        }),
      });
      if (!ins.ok) throw new Error("insert " + ins.status + " " + (await ins.text().catch(() => "")).slice(0, 200));
      return reply(req, 200, { ok: true, id, title: s.title, audioUrl: audioUrl(id + ".mp3") });
    }
    return reply(req, 400, { error: "unknown action" });
  } catch (e) {
    console.error("bank", body.action, String((e as Error)?.message || e));
    return reply(req, 502, { error: String((e as Error)?.message || e) });
  }
});
