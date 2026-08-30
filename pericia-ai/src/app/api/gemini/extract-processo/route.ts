import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  processarExtracaoProcessoFreeTier,
  montarProgresso,
  type ProgressoProcessamento,
} from "@/lib/gemini/extract";
import { shouldAnonymize } from "@/lib/lgpd/anonymize";

export const runtime = "nodejs";

// Teto máximo de duração da função. No plano Hobby da Vercel o limite máximo é 60s.
// Como o trabalho em background é delegado via waitUntil, 60s é mais do que o suficiente
// para cobrir o ciclo de vida da execução sem estourar as regras de deploy da Vercel.
export const maxDuration = 60;

/**
 * Mantém a function serverless viva após o "return" da resposta HTTP para
 * que o processamento em background (chunking + delay por bloco) continue.
 */
async function executarEmBackground(tarefa: () => Promise<void>): Promise<void> {
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(tarefa());
  } catch {
    tarefa().catch((err) => {
      console.error("[extract-processo] Erro não tratado no processamento em background:", err);
    });
  }
}

/**
 * POST /api/gemini/extract-processo
 * body: { documentId: string, caseId: string }
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  let body: { documentId?: string; caseId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }

  const { documentId, caseId } = body;
  if (!documentId || !caseId) {
    return NextResponse.json(
      { error: "documentId e caseId são obrigatórios." },
      { status: 400 }
    );
  }

  const { data: document, error: docError } = await supabase
    .from("case_documents")
    .select("id, file_path")
    .eq("id", documentId)
    .single();

  if (docError || !document) {
    return NextResponse.json({ error: "Documento não encontrado." }, { status: 404 });
  }

  const admin = createServiceRoleClient();
  const actorId = user.id;

  const progressoInicial: ProgressoProcessamento = montarProgresso({
    status: "processing",
    blocosConcluidos: 0,
    totalBlocos: 0,
    segundosRestantes: 0,
    mensagem: "Baixando e preparando o PDF para processamento...",
  });

  const { error: updateError } = await admin
    .from("case_documents")
    .update({ ocr_status: "processing", progress: progressoInicial })
    .eq("id", documentId);

  if (updateError) {
    return NextResponse.json(
      { error: `Falha ao iniciar o processamento: ${updateError.message}` },
      { status: 500 }
    );
  }

  await executarEmBackground(async () => {
    let ultimoProgresso: ProgressoProcessamento = progressoInicial;

    try {
      const { data: fileBlob, error: downloadError } = await admin.storage
        .from("case-files")
        .download(document.file_path);

      if (downloadError || !fileBlob) {
        throw new Error(`Falha ao baixar arquivo do Storage: ${downloadError?.message}`);
      }

      const buffer = Buffer.from(await fileBlob.arrayBuffer());

      const extraido = await processarExtracaoProcessoFreeTier(buffer, {
        anonimizarAntesDoEnvio: shouldAnonymize(),
        onProgress: async (progresso) => {
          ultimoProgresso = progresso;
          await admin
            .from("case_documents")
            .update({ ocr_status: "processing", progress: progresso })
            .eq("id", documentId);
        },
      });

      const totalBlocosFinal = extraido._chunking_info?.totalBlocos ?? 0;
      const progressoFinal = montarProgresso({
        status: "done",
        blocosConcluidos: totalBlocosFinal,
        totalBlocos: totalBlocosFinal,
        segundosRestantes: 0,
        mensagem: "Extração concluída com sucesso.",
      });

      await admin
        .from("case_documents")
        .update({
          ocr_status: "done",
          extracted_json: extraido,
          anonymized: shouldAnonymize(),
          progress: progressoFinal,
        })
        .eq("id", documentId);

      await admin
        .from("forensic_cases")
        .update({
          metadata: extraido,
          status: "calculo",
          updated_at: new Date().toISOString(),
        })
        .eq("id", caseId);

      await admin.from("audit_log").insert({
        actor_id: actorId,
        case_id: caseId,
        action: "extract_processo_triagem_free_tier_chunking",
        details: {
          documentId,
          totalBlocos: totalBlocosFinal,
          observacoes: extraido.observacoes_para_conferencia_humana,
        },
      });
    } catch (err: any) {
      const mensagemErro = err?.message || "Erro interno ao processar extração.";
      console.error(`[extract-processo] Falha ao processar documento ${documentId}:`, err);

      const progressoErro = montarProgresso({
        status: "error",
        blocosConcluidos: ultimoProgresso.blocos_concluidos,
        totalBlocos: ultimoProgresso.total_blocos,
        segundosRestantes: 0,
        mensagem: "Falha no processamento.",
        erro: mensagemErro,
      });

      await admin
        .from("case_documents")
        .update({ ocr_status: "error", progress: progressoErro })
        .eq("id", documentId);

      await admin.from("audit_log").insert({
        actor_id: actorId,
        case_id: caseId,
        action: "extract_processo_triagem_free_tier_chunking_erro",
        details: { documentId, erro: mensagemErro },
      });
    }
  });

  return NextResponse.json(
    {
      success: true,
      status: "processing",
      documentId,
      message:
        `Processamento iniciado em segundo plano. Consulte ` +
        `GET /api/gemini/status-processo?documentId=${documentId} para acompanhar o progresso.`,
    },
    { status: 202 }
  );
}