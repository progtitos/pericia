import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractExtratoBancario } from "@/lib/gemini/extract";
import { reconciliarExtrato } from "@/lib/calc/reconciliation";

export const runtime = "nodejs";

interface LancamentoExtrato {
  data: string;
  descricao: string;
  valor: number;
  tipo: "C" | "D";
}

interface ExtratoResult {
  banco?: string;
  conta?: string;
  saldo_inicial?: number;
  saldo_final?: number;
  alertas?: string[];
  lancamentos: LancamentoExtrato[];
}

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
    return NextResponse.json({ error: "documentId e caseId são obrigatórios." }, { status: 400 });
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
      throw new Error(`Falha ao baixar arquivo: ${downloadError?.message}`);
    }

    const mimeType = document.mime_type || "application/pdf";
    const fileBase64 = Buffer.from(await fileBlob.arrayBuffer()).toString("base64");

    const rawData = await extractExtratoBancario(fileBase64, mimeType);
    const extraido: ExtratoResult = {
      banco: rawData?.banco || "",
      conta: rawData?.conta || "",
      saldo_inicial: rawData?.saldo_inicial ?? 0,
      saldo_final: rawData?.saldo_final ?? 0,
      alertas: rawData?.alertas || [],
      lancamentos: rawData?.lancamentos || [],
    };

    const reconciliacao: any = reconciliarExtrato(extraido as any);

    const rows = (extraido.lancamentos || []).map((l: LancamentoExtrato, idx: number) => ({
      document_id: documentId,
      case_id: caseId,
      entry_date: l.data,
      description: l.descricao,
      amount: l.valor,
      entry_type: l.tipo,
      is_suspicious: reconciliacao?.suspeitos?.includes(idx) ?? false,
    }));

    if (rows.length > 0) {
      await supabase.from("bank_statements").insert(rows);
    }

    await supabase
      .from("case_documents")
      .update({ ocr_status: "done", extracted_json: { ...extraido, reconciliacao } })
      .eq("id", documentId);

    return NextResponse.json({ success: true, data: extraido, reconciliacao });
  } catch (err: any) {
    await supabase.from("case_documents").update({ ocr_status: "error" }).eq("id", documentId);
    return NextResponse.json(
      { error: err?.message || "Erro desconhecido na extração do extrato." },
      { status: 500 }
    );
  }
}
