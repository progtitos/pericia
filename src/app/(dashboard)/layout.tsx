import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, org_id, organizations(name, logo_url)")
    .eq("id", user.id)
    .single();

  const orgName = (profile as any)?.organizations?.name ?? "Sua organização";

  return (
    <div className="flex min-h-screen bg-parchment">
      <aside className="flex w-64 flex-col justify-between bg-ink-900 px-5 py-6 text-parchment">
        <div>
          <div className="flex items-center gap-2 border-b border-ink-700 pb-5">
            <span className="selo-pericial selo-pericial--conferido !border-brass-light !text-brass-light !w-8 !h-8 !text-[9px]">
              PA
            </span>
            <div>
              <p className="font-display text-sm leading-tight">PeríciaAI</p>
              <p className="text-xs text-ink-300 leading-tight">{orgName}</p>
            </div>
          </div>

          <nav className="mt-6 space-y-1">
            <Link
              href="/casos"
              className="block rounded px-3 py-2 text-sm text-ink-100 hover:bg-ink-700 hover:text-parchment transition-colors"
            >
              Casos Periciais
            </Link>
            <Link
              href="/casos/novo"
              className="block rounded px-3 py-2 text-sm text-ink-100 hover:bg-ink-700 hover:text-parchment transition-colors"
            >
              Novo Caso
            </Link>
          </nav>
        </div>

        <div className="border-t border-ink-700 pt-4 text-xs text-ink-300">
          {profile?.full_name || user.email}
          <div className="uppercase tracking-widest text-ink-500">{profile?.role}</div>
        </div>
      </aside>

      <main className="flex-1 px-10 py-8">{children}</main>
    </div>
  );
}
