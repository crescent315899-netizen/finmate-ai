import { NextResponse } from "next/server";
import { assistantRequestSchema } from "@/lib/schemas";
import { formatMoney } from "@/lib/finance";
export const runtime = "nodejs";

const WINDOW_MS = 5 * 60 * 1_000;
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
  if (Number.isFinite(contentLength) && contentLength > 20_000) return json({ error: "Assistant request is too large." }, 413);
  const clientKey = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(clientKey)) return json({ error: "Too many assistant requests. Please try again shortly." }, 429);
  const parsed = assistantRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid assistant request." }, 400);
  const { summary, currency } = parsed.data;
  const money = (amount: number) => formatMoney(amount, currency);
  const fallback = summary.shortfall
    ? `Your plan currently ends about ${money(Math.abs(summary.projectedBalanceMinor))} below zero. The first place to look is the ${money(summary.expectedRemainingMinor)} reserved for additional spending; unpaid bills of ${money(summary.unpaidBillsMinor)} should remain reserved.`
    : `Your estimate ends with ${money(summary.projectedBalanceMinor)}. That includes ${money(summary.unpaidBillsMinor)} in unpaid bills and ${money(summary.expectedRemainingMinor)} for future spending. It is an estimate, not a guarantee.`;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ mode: "rules", answer: fallback });
  try {
    const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini", input: [{ role: "system", content: "You are FinMate AI. Explain only the supplied financial summary. Never claim to have made changes, guarantee results, or give regulated financial advice. Be concise and transparent." }, { role: "user", content: `Question: ${parsed.data.question}\nSummary: available ${money(summary.availableBalanceMinor)}; forecast ${money(summary.projectedBalanceMinor)}; unpaid bills ${money(summary.unpaidBillsMinor)}; expected remaining spending ${money(summary.expectedRemainingMinor)}.` }], max_output_tokens: 220 }), signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error("Provider unavailable");
    const body = await response.json() as { output_text?: string };
    return json({ mode: "ai", answer: typeof body.output_text === "string" ? body.output_text.trim() || fallback : fallback });
  } catch { return json({ mode: "rules", answer: `${fallback} (The optional AI provider is unavailable, so this is a rules-based explanation.)` }); }
}
