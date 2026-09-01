import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK,
  type ProgressoProcessamento,
} from "@/lib/gemini/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/gemini/status-processo?documentId=...
 *
 * Rota leve de polling: o frontend deve chamá-la periodicamente (ex.: a cada
 * 3-5s) enquanto POST /api/gemini/extract-processo processa em background.
 * Não faz nenhuma chamada ao Gemini nem ao Storage — apenas lê o snapshot de
 * progresso já persistido na coluna jsonb "progress" de case_documents.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const documentId = req.nextUrl.searchParams.get("documentId");
  if (!documentId) {
    return NextResponse.json(
      { error: "O parâmetro de busca documentId é obrigatório." },
      { status: 400 }
    );
  }

  const { data: document, error } = await supabase
    .from("case_documents")
    .select("ocr_status, progress")
    .eq("id", documentId)
    .single();

  if (error || !document) {
    return NextResponse.json({ error: "Documento não encontrado." }, { status: 404 });
  }

  const progresso = (document.progress as ProgressoProcessamento | null) ?? null;

  let status: "processing" | "done" | "error";
  if (document.ocr_status === "done") status = "done";
  else if (document.ocr_status === "error") status = "error";
  else status = "processing";

  const totalBlocos = progresso?.total_blocos ?? 0;
  const blocosConcluidos = progresso?.blocos_concluidos ?? 0;
  const blocosRestantes = Math.max(0, totalBlocos - blocosConcluidos);

  const progressoPercentual = status === "done" ? 100 : progresso?.progresso ?? 0;

  const mensagem =
    progresso?.mensagem ??
    (status === "processing"
      ? "Na fila para iniciar o processamento..."
      : status === "done"
      ? "Extração concluída."
      : "Falha no processamento.");

  // Cálculo dinâmico do tempo restante: usa a estimativa adaptativa já
  // calculada pelo próprio job em background (baseada na velocidade real
  // observada nos blocos já processados). Se ainda não há nenhum bloco
  // concluído, cai para uma estimativa grosseira baseada no delay fixo de
  // segurança (6s) mais margem de latência por chamada.
  const tempoRestanteSegundos =
    status === "done" || status === "error"
      ? 0
      : progresso?.estimativa_segundos ?? blocosRestantes * SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK;

  return NextResponse.json(
    {
      documentId,
      status,
      progresso: progressoPercentual,
      mensagem,
      tempoRestanteSegundos,
      blocosConcluidos,
      totalBlocos,
      ...(status === "error"
        ? { erro: progresso?.erro ?? "Erro desconhecido durante o processamento." }
        : {}),
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store, max-age=0" },
    }
  );
}