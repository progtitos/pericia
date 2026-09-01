import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

const STATUS_LABEL: Record<string, string> = {
  triagem: "Triagem",
  calculo: "Cálculo",
  redacao: "Redação",
  concluido: "Concluído",
};

export default async function CasosPage() {
  const supabase = await createClient();
  const { data: casos } = await supabase
    .from("forensic_cases")
    .select("id, process_number, plaintiff, defendant, case_type, status, created_at")
    .order("created_at", { ascending: false });

  return (
    <div>
      <div className="flex items-center justify-between border-b border-ink-100 pb-4">
        <h1 className="font-display text-2xl text-ink">Casos Periciais</h1>
        <Link
          href="/casos/novo"
          className="rounded bg-ink px-4 py-2 text-sm font-medium text-parchment hover:bg-ink-700 transition-colors"
        >
          + Novo Caso
        </Link>
      </div>

      {!casos || casos.length === 0 ? (
        <div className="mt-16 text-center text-ink-500">
          <p className="font-display text-lg">Nenhum caso cadastrado ainda.</p>
          <p className="mt-1 text-sm">Cadastre o primeiro processo para iniciar a triagem.</p>
        </div>
      ) : (
        <table className="mt-6 w-full text-left text-sm">
          <thead>
            <tr className="linha-ledger text-ink-500 uppercase tracking-wide text-xs">
              <th className="py-2 font-medium">Processo</th>
              <th className="py-2 font-medium">Partes</th>
              <th className="py-2 font-medium">Tipo</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {casos.map((c) => (
              <tr key={c.id} className="linha-ledger hover:bg-parchment-dim">
                <td className="py-3">
                  <Link href={`/casos/${c.id}`} className="font-mono tabular-figures text-ink hover:text-brass">
                    {c.process_number}
                  </Link>
                </td>
                <td className="py-3 text-ink-700">
                  {c.plaintiff} <span className="text-ink-300">vs.</span> {c.defendant}
                </td>
                <td className="py-3 text-ink-500">{c.case_type}</td>
                <td className="py-3">
                  <span className="rounded-full bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-700">
                    {STATUS_LABEL[c.status] ?? c.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
