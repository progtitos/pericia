import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { extractProcessoTriagem } from "@/lib/gemini/extract";
import { isTokenLimitError } from "@/lib/gemini/chunking";
import { anonymizeText, shouldAnonymize } from "@/lib/lgpd/anonymize";

/** Mensagem amigável exibida no Toast/Alert do frontend quando o Gemini
 *  recusa a requisição por excedimento de tokens da janela de contexto,
 *  mesmo após a rede de segurança de chunking automático. */
const MENSAGEM_LIMITE_TOKENS =
  "O limite de tokens da cota foi atingido para este arquivo. O sistema já tentou " +
  "dividir a análise em partes automaticamente; se o erro persistir, tente novamente " +
  "em alguns minutos ou divida o PDF manualmente antes do upload.";

export const runtime = "nodejs";
export const maxDuration = 120; // OCR de PDFs longos pode levar tempo

/**
 * POST /api/gemini/extract-processo
 * body: { documentId: string, caseId: string }
 * Lê o PDF já armazenado no Supabase Storage, envia ao Gemini e persiste
 * a extração estruturada em case_documents.extracted_json e nos metadados
 * do caso (forensic_cases.metadata).
 */
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

  // RLS garante que só documentos da própria org são retornados aqui.
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

    // Nota: a anonimização do texto extraído (CPF/nome/conta) acontece nos
    // prompts que reutilizam esse texto em fases seguintes (ex.: geração da
    // minuta), via anonymizeText — aqui o texto já passou pela camada de
    // extração (pdf-parse), não pelo binário bruto.
    // onProgress não é utilizável em tempo real numa única requisição HTTP
    // request/response (sem streaming), mas cada bloco processado já fica
    // registrado em extraido._chunking_info.blocos para exibição na UI e
    // no log de auditoria abaixo.
    const extraido = await extractProcessoTriagem(buffer);

    await supabase
      .from("case_documents")
      .update({
        ocr_status: "done",
        extracted_json: extraido,
        anonymized: shouldAnonymize(),
      })
      .eq("id", documentId);

    // Atualiza metadados centrais do caso para uso nas fases seguintes.
    await supabase
      .from("forensic_cases")
      .update({
        metadata: extraido,
        status: "calculo",
        updated_at: new Date().toISOString(),
      })
      .eq("id", caseId);

    // Auditoria (usa service role pois audit_log só permite select via RLS de usuário comum).
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

    // Erro de excedimento de tokens (400/INVALID_ARGUMENT) recebe mensagem
    // amigável e um código próprio para o frontend renderizar o alerta
    // estilizado, em vez do erro cru da API do Gemini.
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
