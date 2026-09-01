import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/lib/supabase/types";

/**
 * Cliente Supabase para Server Components, Server Actions e Route Handlers.
 * Usa a sessão do usuário (via cookies) — RLS continua sendo a fonte de verdade
 * para isolamento multitenant, este client NÃO usa a service role key.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // chamado a partir de um Server Component sem permissão de escrita —
            // seguro ignorar se houver middleware atualizando a sessão.
          }
        },
      },
    }
  );
}

/**
 * Cliente com service role — SOMENTE para rotinas internas de background
 * (ex.: workers de OCR/cálculo) que precisam ignorar RLS. Nunca expor ao client.
 * Sempre filtrar manualmente por org_id/case_id ao usar este client.
 *
 * Nota: usamos import estático (em vez de require()) para que o TypeScript
 * consiga tipar corretamente a chamada genérica createSupabaseJsClient<Database>
 * — chamadas via require() são sempre "untyped function calls" e travam o
 * build em modo strict.
 */
export function createServiceRoleClient() {
  return createSupabaseJsClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
