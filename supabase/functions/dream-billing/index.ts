// Dreameri billing: Supabase Edge Function "dream-billing"
// Deployed in the Dreameri project (ref jlvlmuyegirglbyrnfbl).
// POST with the signed-in user's access token in Authorization: Bearer <token>.
//   { action: "checkout", plan: "monthly" | "yearly" | "unlock", returnUrl }
//       -> { url } : a Stripe Checkout page. monthly $5.99, yearly $49 (recurring),
//          unlock = $1 one-time for one reading's deeper part.
//   { action: "portal", returnUrl } -> { url } : Stripe's billing portal (cancel, card).
//   { action: "verify", sessionId } -> { paid } : was this one-time unlock paid by this user?
// Prices are set here (Stripe price_data), so no products need creating in Stripe.
// Secrets are project-wide, so these are prefixed DREAMERI_ to never clash with
// another app (e.g. Glomere) in the same Supabase project.
// Falls back to STRIPE_SECRET_KEY when the DREAMERI_ one is not set.
// Secrets: DREAMERI_STRIPE_SECRET_KEY (required; sk_test_... while testing, sk_live_... for real),
//          DREAM_ALLOWED_ORIGINS (optional, same as the other functions).
// Deploy with --no-verify-jwt: the function checks the user token itself (auth/v1/user),
// and a gateway JWT check can block the browser's CORS preflight.

const PRICES = {
  monthly: { amount: 599, interval: "month", name: "Dreameri Pro (monthly)" },
  yearly: { amount: 4900, interval: "year", name: "Dreameri Pro (yearly)" },
} as const;
const UNLOCK = { amount: 100, name: "Dreameri — unlock one reading" };

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

async function stripe(path: string, params?: Record<string, string>, method = "POST"): Promise<any> {
  const key = Deno.env.get("DREAMERI_STRIPE_SECRET_KEY") || Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("stripe_secret_key");
  if (!key) throw new Error("DREAMERI_STRIPE_SECRET_KEY (or STRIPE_SECRET_KEY) not set");
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("stripe", path, r.status, JSON.stringify(data?.error || {}).slice(0, 300));
    throw new Error(data?.error?.message || "stripe error");
  }
  return data;
}

function safeReturn(u: unknown, fallback: string): string {
  try {
    const x = new URL(String(u || ""));
    if (x.protocol !== "https:" && x.hostname !== "localhost") return fallback;
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(x.origin)) return fallback;
    return x.origin + x.pathname;
  } catch {
    return fallback;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsFor(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "POST only" });
  if (!originAllowed(req)) return reply(req, 403, { error: "origin not allowed" });

  const url = Deno.env.get("SUPABASE_URL") || "";
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !svc) return reply(req, 500, { error: "server not configured" });
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(req, 401, { error: "sign in first" });
  const me = await fetch(`${url}/auth/v1/user`, { headers: { apikey: svc, Authorization: `Bearer ${token}` } });
  if (!me.ok) return reply(req, 401, { error: "sign in again" });
  const user = await me.json().catch(() => ({}));
  if (!user?.id) return reply(req, 401, { error: "sign in again" });

  const body = await req.json().catch(() => ({}));
  const site = ALLOWED_ORIGINS[0] || "https://www.dreameri.com";
  const back = safeReturn(body.returnUrl, site + "/");

  // The user's profile row (created by the app on first sign-in).
  const pr = await fetch(`${url}/rest/v1/dream_profiles?user_id=eq.${user.id}&select=plan,stripe_customer_id`, {
    headers: { apikey: svc, Authorization: `Bearer ${svc}` },
  });
  const profile = (pr.ok ? await pr.json().catch(() => []) : [])[0] || {};

  async function customerId(): Promise<string> {
    if (profile.stripe_customer_id) return profile.stripe_customer_id;
    const c = await stripe("customers", { email: user.email || "", "metadata[user_id]": user.id });
    await fetch(`${url}/rest/v1/dream_profiles?user_id=eq.${user.id}`, {
      method: "PATCH",
      headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ stripe_customer_id: c.id }),
    });
    profile.stripe_customer_id = c.id;
    return c.id;
  }

  try {
    if (body.action === "checkout") {
      const plan = String(body.plan || "");
      const cust = await customerId();
      if (plan === "monthly" || plan === "yearly") {
        if (profile.plan === "full") return reply(req, 409, { error: "already on the full version" });
        const p = PRICES[plan];
        const s = await stripe("checkout/sessions", {
          mode: "subscription",
          customer: cust,
          client_reference_id: user.id,
          "line_items[0][quantity]": "1",
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][unit_amount]": String(p.amount),
          "line_items[0][price_data][recurring][interval]": p.interval,
          "line_items[0][price_data][product_data][name]": p.name,
          "metadata[user_id]": user.id,
          "subscription_data[metadata][user_id]": user.id,
          allow_promotion_codes: "true",
          "custom_text[submit][message]": plan === "monthly"
            ? "Billed $5.99 every month until you cancel. Cancel anytime in Dreameri (Settings → Manage subscription) — Pro stays until the end of the month you paid for. No charges after you cancel; past months are not refunded."
            : "Billed $49 once a year until you cancel. Cancel anytime in Dreameri (Settings → Manage subscription) — Pro stays until the end of the year you paid for. No charges after you cancel; past periods are not refunded.",
          success_url: back + "?sub=success",
          cancel_url: back + "?sub=cancel",
        });
        return reply(req, 200, { url: s.url });
      }
      if (plan === "unlock") {
        const s = await stripe("checkout/sessions", {
          mode: "payment",
          customer: cust,
          client_reference_id: user.id,
          "line_items[0][quantity]": "1",
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][unit_amount]": String(UNLOCK.amount),
          "line_items[0][price_data][product_data][name]": UNLOCK.name,
          "metadata[user_id]": user.id,
          "metadata[kind]": "unlock",
          "custom_text[submit][message]": "A one-time $1 payment. It opens the deeper part of this one reading only — no subscription, nothing recurring.",
          success_url: back + "?unlock=paid&sid={CHECKOUT_SESSION_ID}",
          cancel_url: back + "?unlock=cancel",
        });
        return reply(req, 200, { url: s.url, sessionId: s.id });
      }
      return reply(req, 400, { error: "unknown plan" });
    }
    if (body.action === "portal") {
      if (!profile.stripe_customer_id) return reply(req, 400, { error: "no subscription yet" });
      const s = await stripe("billing_portal/sessions", { customer: profile.stripe_customer_id, return_url: back });
      return reply(req, 200, { url: s.url });
    }
    if (body.action === "verify") {
      const id = String(body.sessionId || "");
      if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return reply(req, 400, { error: "bad session" });
      const s = await stripe("checkout/sessions/" + id, undefined, "GET");
      const mine = s.client_reference_id === user.id || s.metadata?.user_id === user.id;
      return reply(req, 200, { paid: mine && s.payment_status === "paid" });
    }
    return reply(req, 400, { error: "unknown action" });
  } catch (e) {
    console.error("billing", body.action, String((e as Error)?.message || e));
    return reply(req, 502, { error: String((e as Error)?.message || e) });
  }
});
