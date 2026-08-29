import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractExtratoBancario } from "@/lib/gemini/extract";
import { reconciliarExtrato } from "@/lib/calc/reconciliation";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/gemini/extract-extrato
 * body: { documentId: string, caseId: string, mimeType: "application/pdf" | "image/png" | "image/jpeg" }
 *
 * Fluxo: OCR via Gemini -> gravação de linhas normalizadas em statement_entries
 * -> reconciliação DETERMINÍSTICA (saldo inicial + entradas - saídas = saldo final).
 * A reconciliação NUNCA é feita pela IA — é código puro, para ser auditável e
 * imune a alucinação.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const { documentId, caseId, mimeType } = await req.json();
  if (!documentId || !caseId || !mimeType) {
    return NextResponse.json(
      { error: "documentId, caseId e mimeType são obrigatórios." },
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
    await supabase.from("case_documents").update({ ocr_status: "processing" }).eq("id", documentId);

    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from("case-files")
      .download(document.file_path);
    if (downloadError || !fileBlob) {
      throw new Error(`Falha ao baixar arquivo do Storage: ${downloadError?.message}`);
    }

    const fileBase64 = Buffer.from(await fileBlob.arrayBuffer()).toString("base64");
    const extraido = await extractExtratoBancario(fileBase64, mimeType);

    // Validação determinística de consistência — NÃO é feita pela IA.
    const reconciliacao = reconciliarExtrato(extraido);

    // Grava lançamentos normalizados, marcando os suspeitos.
    const rows = extraido.lancamentos.map((l, idx) => ({
      document_id: documentId,
      case_id: caseId,
      entry_date: l.data,
      description: l.descricao,
      debit: l.debito,
      credit: l.credito,
      running_balance: l.saldo_apos_lancamento,
      ocr_confidence: l.confianca_ocr,
      flagged_for_review:
        reconciliacao.linhas_suspeitas.includes(idx) || !reconciliacao.consistente,
    }));

    if (rows.length > 0) {
      const { error: insertError } = await supabase.from("statement_entries").insert(rows);
      if (insertError) throw new Error(`Falha ao gravar lançamentos: ${insertError.message}`);
    }

    await supabase
      .from("case_documents")
      .update({
        ocr_status: "done",
        extracted_json: { ...extraido, reconciliacao },
      })
      .eq("id", documentId);

    return NextResponse.json({
      success: true,
      reconciliacao,
      alertaConferenciaObrigatoria: !reconciliacao.consistente,
      totalLancamentos: rows.length,
    });
  } catch (err: any) {
    await supabase.from("case_documents").update({ ocr_status: "error" }).eq("id", documentId);
    return NextResponse.json(
      { error: err?.message || "Erro desconhecido na extração do extrato." },
      { status: 500 }
    );
  }
}
