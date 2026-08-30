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
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { documentId, caseId } = await req.json();
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

    const extraido = await extractProcessoTriagem(buffer);

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
      action: extraido._chunking_info ? "extract_processo_triagem_em_camadas" : "extract_processo_triagem",
      details: {
        documentId,
        observacoes: extraido.observacoes_para_conferencia_humana,
        chunking: extraido._chunking_info ?? null,
      },
    });

    return NextResponse.json({ success: true, data: extraido });
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

    return NextResponse.json(
      { error: err?.message || "Erro desconhecido na extração.", code: "UNKNOWN_ERROR" },
      { status: 500 }
    );
  }
}