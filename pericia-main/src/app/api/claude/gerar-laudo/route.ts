import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gerarLaudoPericial, humanizarErroClaude } from "@/lib/claude/laudo";

export const runtime = "nodejs";
export const maxDuration = 90;

/**
 * POST /api/claude/gerar-laudo
 * body: { caseId: string, runId: string }
 *
 * Monta o contexto (metadados do caso + calculation_run + quesitos aprovados)
 * e delega ao Claude apenas a REDAÇÃO da minuta — todos os números já vêm
 * calculados deterministicamente (ver lib/calc/previdenciario.ts).
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const { caseId, runId } = await req.json();
  if (!caseId || !runId) {
    return NextResponse.json({ error: "caseId e runId são obrigatórios." }, { status: 400 });
  }

  try {
    const [{ data: forensicCase }, { data: run }, { data: installments }, { data: questions }] =
      await Promise.all([
        supabase.from("forensic_cases").select("*").eq("id", caseId).single(),
        supabase.from("calculation_runs").select("*").eq("id", runId).single(),
        supabase
          .from("calculation_installments")
          .select("*")
          .eq("run_id", runId)
          .order("competence"),
        supabase
          .from("case_questions")
          .select("author, question_text")
          .eq("case_id", caseId)
          .eq("is_approved", true),
      ]);

    if (!forensicCase || !run) {
      return NextResponse.json({ error: "Caso ou cálculo não encontrado." }, { status: 404 });
    }

    const resultadoCalculo = {
      ...run.result_summary,
      competencias: installments,
    };

    // O texto integral do processo (com marcadores [[FLS. N]] por página) é
    // persistido pelo client dentro de forensic_cases.metadata junto com a
    // triagem (ver CaseWorkspace.tsx -> persistirMetadadosDoCaso), sob a
    // chave "_texto_paginado" — é isso que permite ao laudo citar folhas
    // exatas em vez de "conforme os autos" genérico.
    const metadata = (forensicCase.metadata ?? {}) as Record<string, unknown>;
    const textoPaginado = typeof metadata._texto_paginado === "string" ? metadata._texto_paginado : null;
    const { _texto_paginado, ...processoTriagem } = metadata;

    const minutaMarkdown = await gerarLaudoPericial({
      processoTriagem,
      resultadoCalculo,
      quesitosAprovados: questions ?? [],
      textoPaginado,
    });

    const { data: existingDrafts } = await supabase
      .from("report_drafts")
      .select("version")
      .eq("case_id", caseId)
      .order("version", { ascending: false })
      .limit(1);

    const nextVersion = (existingDrafts?.[0]?.version ?? 0) + 1;

    const { data: draft, error: draftError } = await supabase
      .from("report_drafts")
      .insert({
        case_id: caseId,
        run_id: runId,
        content_markdown: minutaMarkdown,
        version: nextVersion,
        generated_by_ai: true,
      })
      .select()
      .single();

    if (draftError) throw new Error(draftError.message);

    return NextResponse.json({ success: true, draft });
  } catch (err: any) {
    return NextResponse.json(
      { error: humanizarErroClaude(err) },
      { status: 500 }
    );
  }
}
