import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/types";

/**
 * Cliente Supabase para uso em Client Components.
 * Nunca usar SUPABASE_SERVICE_ROLE_KEY aqui — apenas a anon key,
 * a segurança real é garantida pelas policies de RLS no banco.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
