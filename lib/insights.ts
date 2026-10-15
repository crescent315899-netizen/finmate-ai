import { formatMoney } from "@/lib/finance";
import type { Currency, Forecast } from "@/types/finance";

export interface Insight { title: string; body: string; tone: "good" | "warning" | "danger" | "neutral"; }

export function buildInsights(forecast: Forecast, currency: Currency): Insight[] {
  const money = (amount: number) => formatMoney(amount, currency);
  const insights: Insight[] = [];
  if (forecast.shortfall) insights.push({ title: "Your forecast needs attention", body: `You are projected to be ${money(Math.abs(forecast.projectedBalanceMinor))} below zero after bills and planned spending. Reduce discretionary spending or add income before month-end.`, tone: "danger" });
  else insights.push({ title: "You are on track", body: `Your estimated month-end balance is ${money(forecast.projectedBalanceMinor)}. This is an estimate, not a guarantee.`, tone: "good" });
  if (forecast.unpaidBillsMinor > 0) insights.push({ title: "Bills are reserved", body: `${money(forecast.unpaidBillsMinor)} in unpaid bills is already included in the forecast so it is not double-counted.`, tone: "warning" });
  if (forecast.expectedRemainingMinor > 0) insights.push({ title: "Spending assumption", body: `${money(forecast.expectedRemainingMinor)} is reserved for further spending from ${forecast.expectedSpendingSource}.`, tone: "neutral" });
  return insights;
}
