import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { calcularPrevidenciario } from "@/lib/calc/previdenciario";
import type { ParametrosCalculoPrevidenciario } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/calculo/demonstrativo
 * body: { caseId: string, parametros: ParametrosCalculoPrevidenciario, honorariosPercentual?: number }
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

  // 1. Validação de estrutura básica
  if (!caseId || !parametros) {
    return NextResponse.json(
      { error: "Os campos caseId e parametros são obrigatórios." },
      { status: 400 }
    );
  }

  // 2. Sanitize e validação de datas e valores do cálculo
  const { rmi, dib, data_base_calculo } = parametros;

  if (!data_base_calculo || data_base_calculo.trim() === "") {
    return NextResponse.json(
      { error: "A Data-Base do Cálculo (Sentença/Decisão) é obrigatória para executar o recálculo." },
      { status: 400 }
    );
  }

  if (!dib || dib.trim() === "") {
    return NextResponse.json(
      { error: "A DIB (Data de Início do Benefício) é obrigatória." },
      { status: 400 }
    );
  }

  if (!rmi || Number(rmi) <= 0) {
    return NextResponse.json(
      { error: "A RMI deve ser um número maior que zero." },
      { status: 400 }
    );
  }

  if (parametros.indice_ate_112021 !== "IPCA-E" && parametros.indice_ate_112021 !== "INPC") {
    return NextResponse.json(
      { error: 'O índice até 11/2021 deve ser "IPCA-E" ou "INPC".' },
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
      
    if (instError) throw new Error(`Falha ao inserir parcelas: ${instError.message}`);

    await supabase
      .from("forensic_cases")
      .update({ status: "redacao", updated_at: new Date().toISOString() })
      .eq("id", caseId);

    return NextResponse.json({ success: true, runId: run.id, resultado });
  } catch (err: any) {
    // IMPORTANTE: antes esta rota não logava nada no catch — um 500 aqui
    // vinha sem nenhum rastro no painel de Functions da Vercel, só o JSON
    // de erro chegava ao browser. Agora o erro completo fica registrado.
    console.error("[API Calculo Demonstrativo Error]:", err);
    return NextResponse.json(
      { error: err?.message || "Erro ao executar o cálculo previdenciário." },
      { status: 500 }
    );
  }
}