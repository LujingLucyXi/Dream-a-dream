// Dream Reader proxy: Supabase Edge Function "dream-reading"
// Deployed in the Glomere project (ref jlvlmuyegirglbyrnfbl).
// The Dream Reader page POSTs { dream, theme, themeLabel, mood, lifeMoment, prompt }
// and this function calls OpenAI with the key held in Supabase secrets,
// so the key never appears in the page. It returns OpenAI's raw response;
// the page already parses OpenAI-style choices content.
// Secret required: OPENAI_API_KEY (set in the Supabase dashboard).
// Create the function with "Verify JWT" OFF, like the stripe-webhook function,
// or browser calls without a Supabase login get a 401.

const SYSTEM = `You are a dream reader in the 周公解梦 tradition. Read the dream through the five elements (五行 Wood, Fire, Earth, Metal, Water), omens (兆), and timing (时机). Speak warmly and mysteriously, like an old book of signs, never like a clinical analysis or a ChatGPT summary. Every symbol must come from the dream itself. Give the reader hope and a reason to dream again tonight. For pregnancy dreams (胎梦), speak only of folk tradition, temperament and fortune as cultural stories, never a medical fact or a real gender prediction. This is folk tradition for fun, never real fortune-telling or medical fact. Return a JSON object with: title, symbols (array of 4 objects with name and meaning), mood, line (one line to remember), narrative (2-3 sentences), closing (one hopeful sentence pulling toward the next dream), xuan (object with dominant element, movement, omen, timing).`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }

  const body = await req.json().catch(() => ({}));
  const userPrompt =
    body.prompt ||
    [body.dream, body.themeLabel, body.mood, body.lifeMoment]
      .filter(Boolean)
      .join("\n");
  if (!userPrompt || !String(userPrompt).trim()) {
    return json({ error: "missing dream" }, 400);
  }

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) {
    return json({ error: "OPENAI_API_KEY not set" }, 500);
  }

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
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: String(userPrompt) },
        ],
      }),
      signal: AbortSignal.timeout(14000),
    });
    const data = await r.json();
    return new Response(JSON.stringify(data), {
      status: r.status,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
});
