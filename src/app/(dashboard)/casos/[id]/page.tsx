import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CaseWorkspace } from "./CaseWorkspace";

export default async function CasoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: caso } = await supabase
    .from("forensic_cases")
    .select("*")
    .eq("id", id)
    .single();

  if (!caso) notFound();

  return (
    <div>
      <div className="border-b border-ink-100 pb-4">
        <p className="font-mono tabular-figures text-xs text-ink-500">{caso.process_number}</p>
        <h1 className="font-display text-2xl text-ink">
          {caso.plaintiff} <span className="text-ink-300">vs.</span> {caso.defendant}
        </h1>
        <p className="text-sm text-ink-500">{caso.court_name}</p>
      </div>

      <div className="mt-6">
        <CaseWorkspace caseId={caso.id} caseType={caso.case_type} />
      </div>
    </div>
  );
}
