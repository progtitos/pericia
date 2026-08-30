"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { CaseType } from "@/lib/types";

const CASE_TYPES: { value: CaseType; label: string }[] = [
  { value: "previdenciario", label: "Previdenciário" },
  { value: "bancario_financiamento", label: "Bancário / Financiamento" },
  { value: "cartao_credito", label: "Cartão de Crédito" },
  { value: "sfh", label: "SFH" },
];

export default function NovoCasoPage() {
  const router = useRouter();
  const supabase = createClient();
  const [form, setForm] = useState({
    process_number: "",
    court_name: "",
    plaintiff: "",
    defendant: "",
    case_type: "previdenciario" as CaseType,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data: profile } = await supabase
      .from("profiles")
      .select("org_id")
      .eq("id", user?.id)
      .single();

    const { data, error: insertError } = await supabase
      .from("forensic_cases")
      .insert({ ...form, org_id: profile?.org_id, created_by: user?.id })
      .select()
      .single();

    setLoading(false);
    if (insertError || !data) {
      setError("Não foi possível criar o caso. Verifique os dados e tente novamente.");
      return;
    }
    router.push(`/casos/${data.id}`);
  }

  return (
    <div className="max-w-xl">
      <h1 className="font-display text-2xl text-ink border-b border-ink-100 pb-4">Novo Caso Pericial</h1>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <Field label="Número do Processo">
          <input
            required
            value={form.process_number}
            onChange={(e) => setForm({ ...form, process_number: e.target.value })}
            className="input-field font-mono tabular-figures"
            placeholder="0000000-00.0000.0.00.0000"
          />
        </Field>

        <Field label="Vara / Juízo">
          <input
            value={form.court_name}
            onChange={(e) => setForm({ ...form, court_name: e.target.value })}
            className="input-field"
            placeholder="1ª Vara Federal de..."
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Autor / Exequente">
            <input
              value={form.plaintiff}
              onChange={(e) => setForm({ ...form, plaintiff: e.target.value })}
              className="input-field"
            />
          </Field>
          <Field label="Réu / Executado">
            <input
              value={form.defendant}
              onChange={(e) => setForm({ ...form, defendant: e.target.value })}
              className="input-field"
            />
          </Field>
        </div>

        <Field label="Tipo de Perícia">
          <select
            value={form.case_type}
            onChange={(e) => setForm({ ...form, case_type: e.target.value as CaseType })}
            className="input-field"
          >
            {CASE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>

        {error && <p className="text-sm text-seal-red">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="rounded bg-ink px-5 py-2.5 font-medium text-parchment hover:bg-ink-700 disabled:opacity-60 transition-colors"
        >
          {loading ? "Criando…" : "Criar caso e iniciar triagem"}
        </button>
      </form>

      <style jsx global>{`
        .input-field {
          width: 100%;
          border: 1px solid #d6dbe8;
          border-radius: 3px;
          padding: 0.5rem 0.75rem;
          background: white;
        }
        .input-field:focus {
          outline: none;
          border-color: #a6803c;
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700">{label}</span>
      {children}
    </label>
  );
}
