// Dream a Dream transcribe proxy: Supabase Edge Function "dream-transcribe"
// Deployed in the Glomere project (ref jlvlmuyegirglbyrnfbl).
// The Dream a Dream page records the user's voice with the browser
// microphone, then POSTs the audio here as multipart form-data
// (field "file"). This function forwards it to OpenAI Whisper and
// returns { text } as JSON, so the page can fill the dream/wish input
// with the transcript. The key never appears in the page.
// Secret required: OPENAI_API_KEY — already set for dream-reading,
// no new secret needed. Create the function with "Verify JWT" OFF,
// like dream-reading and dream-voice, or browser calls without a
// Supabase login get a 401.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB audio cap

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

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) {
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return new Response(JSON.stringify({ error: "expected audio file" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
  if (!file || file.size === 0) {
    return new Response(JSON.stringify({ error: "empty audio" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
  if (file.size > MAX_BYTES) {
    return new Response(JSON.stringify({ error: "audio too long" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS },
    });
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
        {
          status: 502,
          headers: { "Content-Type": "application/json", ...CORS },
        },
      );
    }
    return new Response(JSON.stringify({ text: data.text || "" }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
});
