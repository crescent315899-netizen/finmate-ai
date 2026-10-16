import { NextResponse } from "next/server";
import { assistantRequestSchema } from "@/lib/schemas";
import { formatMoney } from "@/lib/finance";

export const runtime = "nodejs";

const WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 12;
const requestWindows = new Map<string, { count: number; resetAt: number }>();

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function isRateLimited(clientKey: string) {
  const now = Date.now();
  const active = requestWindows.get(clientKey);
  if (!active || active.resetAt <= now) {
    requestWindows.set(clientKey, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  active.count += 1;
  return active.count > MAX_REQUESTS_PER_WINDOW;
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 20_000) {
    return json({ error: "Assistant request is too large." }, 413);
  }

  const clientKey = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(clientKey)) {
    return json({ error: "Too many assistant requests. Please try again shortly." }, 429);
  }

  const parsed = assistantRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "Invalid assistant request." }, 400);
  }

  const { summary, currency } = parsed.data;
  const money = (amount: number) => formatMoney(amount, currency);

  const fallback = summary.shortfall
    ? `Your plan currently ends about ${money(Math.abs(summary.projectedBalanceMinor))} below zero. The first place to look is scheduled bills.`
    : `Your estimate ends with ${money(summary.projectedBalanceMinor)}. That includes ${money(summary.unpaidBillsMinor)} in unpaid bills and ${money(summary.expectedRemainingMinor)} in future spending.`;

  // 1. Fetch Key from Environment
  const key = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
  
  if (!key) {
    return json({ 
      mode: "rules", 
      answer: `${fallback} (Error: GEMINI_API_KEY is missing in Vercel environment settings.)` 
    });
  }

  try {
    // 2. Call Standard Gemini 1.5 Flash Endpoint
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Explain this workspace summary concisely to a user:\n${fallback}`
                }
              ]
            }
          ]
        })
      } 
    );

    if (!response.ok) {
      const errBody = await response.text();
      console.error("Gemini API Error:", response.status, errBody);
      throw new Error(`API responded with status ${response.status}`);
    }

    const body = await response.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;

    return json({
      mode: "ai",
      answer: typeof text === "string" && text.trim() ? text.trim() : fallback
    });
  } catch (err: any) {
    return json({
      mode: "rules",
      answer: `${fallback} (AI Error: ${err?.message || "Provider request failed"})`
    });
  }
}
