// Dreameri: Supabase Edge Function "dream-stripe-webhook"
// Stripe calls this whenever a subscription starts, renews, changes or ends,
// and it keeps dream_profiles.plan in step: "full" while the subscription is
// active (or trialing / briefly past due), "free" otherwise.
// Deploy with "Verify JWT" OFF (Stripe does not send a Supabase token):
//   supabase functions deploy dream-stripe-webhook --no-verify-jwt
// Secrets: STRIPE_WEBHOOK_SECRET (whsec_..., from the webhook endpoint in Stripe).
// Every request is checked against Stripe's signature before anything changes.

const enc = new TextEncoder();

async function verify(raw: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = parts["t"];
  const sigs = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${raw}`)));
  const hex = Array.from(mac).map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === hex.length && [...s].every((c, i) => c === hex[i]));
}

async function patch(filter: string, values: Record<string, unknown>): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const r = await fetch(`${url}/rest/v1/dream_profiles?${filter}`, {
    method: "PATCH",
    headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) console.error("profile update failed", r.status, (await r.text().catch(() => "")).slice(0, 200));
}

function fromSubscription(sub: any): Record<string, unknown> {
  const active = ["active", "trialing", "past_due"].includes(sub.status);
  const item = sub.items?.data?.[0];
  const end = sub.current_period_end || item?.current_period_end;
  return {
    plan: active ? "full" : "free",
    sub_status: sub.status,
    sub_interval: item?.price?.recurring?.interval || null,
    sub_period_end: end ? new Date(end * 1000).toISOString() : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("not configured", { status: 500 });
  const raw = await req.text();
  if (!(await verify(raw, req.headers.get("Stripe-Signature") || "", secret))) {
    return new Response("bad signature", { status: 400 });
  }
  const event = JSON.parse(raw);
  const obj = event.data?.object || {};
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const uid = obj.client_reference_id || obj.metadata?.user_id;
        if (obj.mode === "subscription" && uid && /^[0-9a-f-]{36}$/.test(uid)) {
          await patch(`user_id=eq.${uid}`, { plan: "full", sub_status: "active", stripe_customer_id: obj.customer });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const vals = fromSubscription(obj);
        if (event.type === "customer.subscription.deleted") vals.plan = "free";
        const uid = obj.metadata?.user_id;
        if (uid && /^[0-9a-f-]{36}$/.test(uid)) await patch(`user_id=eq.${uid}`, { ...vals, stripe_customer_id: obj.customer });
        else if (obj.customer) await patch(`stripe_customer_id=eq.${encodeURIComponent(obj.customer)}`, vals);
        break;
      }
    }
  } catch (e) {
    console.error("webhook", event.type, String(e));
    return new Response("error", { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
