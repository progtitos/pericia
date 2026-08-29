import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfPagesText, buildTokenPreview } from "@/lib/gemini/chunking";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/gemini/count-tokens
 * body: { documentId: string }
 *
 * Rota leve chamada pelo FileUploader logo após o upload, ANTES de disparar
 * a extração completa. Baixa o PDF já enviado ao Storage, extrai só a
 * camada de texto e conta os tokens reais via Gemini — permite mostrar a
 * barra de capacidade da janela de contexto e bloquear o envio direto caso
 * o arquivo vá exigir o modo de Análise por Camadas.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const { documentId } = await req.json();
  if (!documentId) {
    return NextResponse.json({ error: "documentId é obrigatório." }, { status: 400 });
  }

  const { data: document, error: docError } = await supabase
    .from("case_documents")
    .select("file_path")
    .eq("id", documentId)
    .single();

  if (docError || !document) {
    return NextResponse.json({ error: "Documento não encontrado." }, { status: 404 });
  }

  try {
    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from("case-files")
      .download(document.file_path);
    if (downloadError || !fileBlob) {
      throw new Error(`Falha ao baixar arquivo do Storage: ${downloadError?.message}`);
    }

    const buffer = Buffer.from(await fileBlob.arrayBuffer());
    const pages = await extractPdfPagesText(buffer);
    const { preview } = await buildTokenPreview(pages);

    return NextResponse.json({ success: true, preview });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Erro ao estimar tokens do documento." },
      { status: 500 }
    );
  }
}
