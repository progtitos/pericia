import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { extractProcessoTriagem } from "@/lib/gemini/extract";
import { isTokenLimitError } from "@/lib/gemini/chunking";
import { anonymizeText, shouldAnonymize } from "@/lib/lgpd/anonymize";

const MENSAGEM_LIMITE_TOKENS =
  "O limite de tokens da cota foi atingido para este arquivo. O sistema já tentou " +
  "dividir a análise em partes automaticamente; se o erro persistir, tente novamente " +
  "em alguns minutos ou divida o PDF manualmente antes do upload.";

export const runtime = "nodejs";
export const maxDuration = 60; // Limite padrão suportado em rotas Serverless Pro

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
    .select("*")
    .eq("id", documentId)
    .single();

  if (docError || !document) {
    return NextResponse.json({ error: "Documento não encontrado." }, { status: 404 });
  }

  try {
    await supabase
      .from("case_documents")
      .update({ ocr_status: "processing" })
      .eq("id", documentId);

    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from("case-files")
      .download(document.file_path);

    if (downloadError || !fileBlob) {
      throw new Error(`Falha ao baixar arquivo do Storage: ${downloadError?.message}`);
    }

    const buffer = Buffer.from(await fileBlob.arrayBuffer());

    // Executa a extração do Gemini
    const extraido = await extractProcessoTriagem(buffer);

    if (!extraido || typeof extraido !== "object") {
      throw new Error("A resposta retornada pelo motor de extração é inválida.");
    }

    await supabase
      .from("case_documents")
      .update({
        ocr_status: "done",
        extracted_json: extraido,
        anonymized: shouldAnonymize(),
      })
      .eq("id", documentId);

    await supabase
      .from("forensic_cases")
      .update({
        metadata: extraido,
        status: "calculo",
        updated_at: new Date().toISOString(),
      })
      .eq("id", caseId);

    const admin = createServiceRoleClient();
    await admin.from("audit_log").insert({
      actor_id: user.id,
      case_id: caseId,
      action: extraido._chunking_info
        ? "extract_processo_triagem_em_camadas"
        : "extract_processo_triagem",
      details: {
        documentId,
        observacoes: extraido.observacoes_para_conferencia_humana,
        chunking: extraido._chunking_info ?? null,
      },
    });

    return NextResponse.json({ success: true, data: extraido }, { status: 200 });
  } catch (err: any) {
    await supabase
      .from("case_documents")
      .update({ ocr_status: "error" })
      .eq("id", documentId);

    if (isTokenLimitError(err)) {
      return NextResponse.json(
        { error: MENSAGEM_LIMITE_TOKENS, code: "TOKEN_LIMIT_EXCEEDED" },
        { status: 400 }
      );
    }

    // Tratamento estrito para garantir que o erro retorne sempre em JSON válido
    const errorMessage = err?.message || "Erro interno ao processar extração.";
    return NextResponse.json(
      { error: errorMessage, code: "EXTRACTION_FAILED" },
      { status: 500 }
    );
  }
}