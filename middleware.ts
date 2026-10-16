import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || url.includes("your-project")) return NextResponse.next();
  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, { cookies: { getAll: () => request.cookies.getAll(), setAll: (cookies: { name: string; value: string; options: CookieOptions }[]) => { cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options)); } } });
  const auth = supabase.auth as unknown as { getUser: () => Promise<{ data: { user: { id: string } | null } }> };
  const { data: { user } } = await auth.getUser();
  // The explicitly labelled fictional demo is deliberately available without
  // an account; all other cloud workspace visits require authentication.
  const demoRequested = request.nextUrl.searchParams.get("demo") === "1";
  if (!user && request.nextUrl.pathname.startsWith("/app") && !demoRequested) {
    const redirect = request.nextUrl.clone(); redirect.pathname = "/auth"; redirect.searchParams.set("next", request.nextUrl.pathname);
    response = NextResponse.redirect(redirect);
  }
  return response;
}
export const config = { matcher: ["/app/:path*"] };
