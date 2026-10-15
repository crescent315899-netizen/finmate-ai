// Deploy with: supabase functions deploy finance-assistant
// This function deliberately uses the caller JWT and RLS—not the service role—to scope all data.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
const currentMonth = () => new Date().toISOString().slice(0,7);
const nextMonthStart = (month: string) => {
  const [year, currentMonthNumber] = month.split("-").map(Number);
  const nextYear = currentMonthNumber === 12 ? year + 1 : year;
  const nextMonthNumber = currentMonthNumber === 12 ? 1 : currentMonthNumber + 1;
  return `${nextYear}-${String(nextMonthNumber).padStart(2,"0")}-01`;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return json({}, 204);
  if (request.method !== "POST") return json({ error:"Method not allowed" },405);
  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error:"Sign in required" },401);
  const url = Deno.env.get("SUPABASE_URL")!; const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(url, anon, { global:{ headers:{ Authorization:authorization } } });
  const { data:{ user }, error:userError } = await supabase.auth.getUser();
  if (userError || !user) return json({ error:"Invalid session" },401);
  const body = await request.json().catch(() => ({}));
  const question = typeof body.question === "string" ? body.question.slice(0,700).trim() : "Explain my financial summary.";
  if (!question) return json({ error:"Question is required" },400);
  const month = typeof body.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(body.month) ? body.month : currentMonth();
  const monthEnd = nextMonthStart(month);
  const [{data:profile},{data:transactions},{data:bills},{data:budgets},{data:categories}] = await Promise.all([
    supabase.from("profiles").select("currency,opening_balance_minor,expected_remaining_minor").single(),
    supabase.from("transactions").select("id,amount_minor,type,category_id,transaction_date,bill_id").gte("transaction_date",`${month}-01`).lt("transaction_date",monthEnd),
    supabase.from("bills").select("id,name,amount_minor,category_id,due_date,paid_at").gte("due_date",`${month}-01`).lt("due_date",monthEnd),
    supabase.from("budgets").select("id,amount_minor,category_id").eq("month",`${month}-01`),
    supabase.from("categories").select("id,name")
  ]);
  if (!profile) return json({ error:"Profile unavailable" },404);
  const rows = transactions ?? []; const linkedBillIds = new Set(rows.map((row) => row.bill_id).filter(Boolean));
  const income = rows.filter((row) => row.type === "income").reduce((total,row) => total + row.amount_minor,0);
  const paid = rows.filter((row) => row.type === "expense").reduce((total,row) => total + row.amount_minor,0);
  const unpaid = (bills ?? []).filter((bill) => !bill.paid_at && !linkedBillIds.has(bill.id));
  const unpaidMinor = unpaid.reduce((total,bill) => total + bill.amount_minor,0);
  const spent = rows.filter((row) => row.type === "expense").reduce<Record<string,number>>((total,row) => ({...total,[row.category_id]:(total[row.category_id] ?? 0)+row.amount_minor}),{});
  const unpaidByCategory = unpaid.reduce<Record<string,number>>((total,row) => ({...total,[row.category_id]:(total[row.category_id] ?? 0)+row.amount_minor}),{});
  const budgetRemaining = (budgets ?? []).reduce((total,row) => total + Math.max(0,row.amount_minor-(spent[row.category_id] ?? 0)-(unpaidByCategory[row.category_id] ?? 0)),0);
  const expected = profile.expected_remaining_minor ?? budgetRemaining;
  const available = profile.opening_balance_minor + income - paid; const projected = available - unpaidMinor - expected;
  // Controlled, read-only tools. The model receives their output; it cannot execute mutations.
  const tools = {
    get_financial_summary: { availableMinor:available,incomeMinor:income,paidExpenseMinor:paid,currency:profile.currency },
    calculate_forecast: { projectedMinor:projected,unpaidBillsMinor:unpaidMinor,expectedRemainingMinor:expected,shortfall:projected<0,method:profile.expected_remaining_minor === null ? "unspent budgets excluding unpaid bills" : "user-provided estimate plus unpaid bills" },
    get_category_spending: (categories ?? []).map((category) => ({ category:category.name,spentMinor:spent[category.id] ?? 0 })),
    get_upcoming_bills: unpaid.map((bill) => ({ name:bill.name,amountMinor:bill.amount_minor,dueDate:bill.due_date })),
    propose_budget_change: "Read-only: a proposal can be described, but the client must show it for explicit review and call approve_budget_proposal only after confirmation."
  };
  const fallback = projected < 0 ? `Your estimate is ${Math.abs(projected)} minor units below zero after ${unpaidMinor} in unpaid bills. Consider reducing discretionary planned spending; no budget has been changed.` : `Your estimate has ${projected} minor units remaining after reserving ${unpaidMinor} for unpaid bills. This is an estimate, not a guarantee.`;
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return json({ mode:"rules",answer:fallback,tools });
  try {
    const response = await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},body:JSON.stringify({model:Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini",input:[{role:"system",content:"You are FinMate AI. Use only the supplied authorized tool results. Do not invent values, perform actions, promise outcomes, or provide regulated financial advice. Keep the answer concise."},{role:"user",content:`Question: ${question}\nAuthorized tools: ${JSON.stringify(tools)}`}],max_output_tokens:260}),signal:AbortSignal.timeout(12_000)});
    if (!response.ok) throw new Error("Provider error"); const output = await response.json(); return json({mode:"ai",answer:output.output_text ?? fallback,tools});
  } catch { return json({mode:"rules",answer:`${fallback} (Optional AI provider unavailable.)`,tools}); }
});
