// Dream a Dream voice proxy: Supabase Edge Function "dream-voice"
// Deployed in the Glomere project (ref jlvlmuyegirglbyrnfbl).
// The Dream a Dream page POSTs { text, voice } and this function calls
// OpenAI text-to-speech with the key held in Supabase secrets, so the
// key never appears in the page. It returns raw MP3 audio bytes; the
// page plays them in a real <audio> element, so playback keeps going
// with the phone screen locked (browser speech synthesis does not).
// Secret required: OPENAI_API_KEY — already set for dream-reading,
// no new secret needed. Create the function with "Verify JWT" OFF,
// like dream-reading and stripe-webhook, or browser calls without a
// Supabase login get a 401.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MAX_CHARS = 6000; // bounds cost: ~7 minutes of speech max
const DEFAULT_VOICE = "nova"; // warm, soft voice for bedtime stories

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const body = await req.json().catch(() => ({}));
  const text = String(body.text || "").trim();
  if (!text) {
    return new Response(JSON.stringify({ error: "missing text" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
  if (text.length > MAX_CHARS) {
    return new Response(JSON.stringify({ error: "text too long" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) {
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const voice = String(body.voice || DEFAULT_VOICE).trim() || DEFAULT_VOICE;

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
      return new Response(
        JSON.stringify({ error: "tts failed", status: r.status, detail: detail.slice(0, 300) }),
        {
          status: 502,
          headers: { "Content-Type": "application/json", ...CORS },
        },
      );
    }
    const audio = await r.arrayBuffer();
    return new Response(audio, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", ...CORS },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
});
