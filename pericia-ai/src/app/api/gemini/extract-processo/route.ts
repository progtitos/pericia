import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { extractProcessoTriagem } from "@/lib/gemini/extract";
import { anonymizeText, shouldAnonymize } from "@/lib/lgpd/anonymize";

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

    const arrayBuffer = await fileBlob.arrayBuffer();
    const pdfBase64 = Buffer.from(arrayBuffer).toString("base64");

    // Nota: a anonimização de PDFs binários exige um passo de OCR-texto prévio
    // para mascarar CPF/nome; para o MVP, o texto já extraído em fases
    // seguintes (extracted_text) passa por anonymizeText antes de reuso em
    // prompts subsequentes (ex.: geração da minuta).
    const extraido = await extractProcessoTriagem(pdfBase64);

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
      action: "extract_processo_triagem",
      details: { documentId, observacoes: extraido.observacoes_para_conferencia_humana },
    });

    return NextResponse.json({ success: true, data: extraido });
  } catch (err: any) {
    await supabase
      .from("case_documents")
      .update({ ocr_status: "error" })
      .eq("id", documentId);

    return NextResponse.json(
      { error: err?.message || "Erro desconhecido na extração." },
      { status: 500 }
    );
  }
}
