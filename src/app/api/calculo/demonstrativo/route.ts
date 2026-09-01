import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { calcularPrevidenciario } from "@/lib/calc/previdenciario";
import type { ParametrosCalculoPrevidenciario } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/calculo/demonstrativo
 * body: { caseId: string, parametros: ParametrosCalculoPrevidenciario, honorariosPercentual?: number }
 *
 * Executa o motor determinístico (lib/calc/previdenciario.ts) e persiste o
 * resultado como uma nova "calculation_run" versionada — nunca sobrescreve
 * um cálculo anterior, para manter a trilha de auditoria pericial.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const { caseId, parametros, honorariosPercentual } = (await req.json()) as {
    caseId: string;
    parametros: ParametrosCalculoPrevidenciario;
    honorariosPercentual?: number;
  };

  if (!caseId || !parametros) {
    return NextResponse.json(
      { error: "caseId e parametros são obrigatórios." },
      { status: 400 }
    );
  }

  try {
    const resultado = await calcularPrevidenciario(parametros, honorariosPercentual ?? 0.1);

    const { data: run, error: runError } = await supabase
      .from("calculation_runs")
      .insert({
        case_id: caseId,
        run_type: "previdenciario",
        parameters: { ...parametros, honorariosPercentual: honorariosPercentual ?? 0.1 },
        result_summary: {
          valor_total_bruto: resultado.valor_total_bruto,
          honorarios_sucumbenciais: resultado.honorarios_sucumbenciais,
          valor_liquido_final: resultado.valor_liquido_final,
          base_legal: resultado.base_legal,
        },
        created_by: user.id,
      })
      .select()
      .single();

    if (runError || !run) throw new Error(runError?.message || "Falha ao criar calculation_run.");

    const installments = resultado.competencias.map((c) => ({
      run_id: run.id,
      competence: `${c.competencia}-01`,
      original_value: c.valor_original,
      index_applied: c.indice_aplicado,
      index_rate: c.taxa_indice,
      monetary_correction: c.correcao_monetaria,
      interest_value: c.juros,
      corrected_value: c.valor_corrigido,
    }));

    const { error: instError } = await supabase
      .from("calculation_installments")
      .insert(installments);
    if (instError) throw new Error(instError.message);

    await supabase
      .from("forensic_cases")
      .update({ status: "redacao", updated_at: new Date().toISOString() })
      .eq("id", caseId);

    return NextResponse.json({ success: true, runId: run.id, resultado });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Erro ao executar o cálculo previdenciário." },
      { status: 500 }
    );
  }
}
