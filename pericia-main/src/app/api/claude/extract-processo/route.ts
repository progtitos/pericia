import { NextRequest, NextResponse } from "next/server";
import { processarTextoProcesso, humanizarErroClaude } from "@/lib/claude/extract";

// Duração máxima da função serverless. Processos extensos ainda podem ser
// divididos em blocos processados em sequência (ver processarTextoProcesso em
// src/lib/claude/extract.ts — necessário porque a janela do Claude, 200.000
// tokens, é real e menor que a do Gemini usado antes). 300s é o teto do
// plano Vercel Pro; no plano Hobby o limite é 60s independente do que for
// configurado aqui.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { texto } = body;

    if (!texto || typeof texto !== "string") {
      return NextResponse.json(
        { error: "Nenhum texto válido foi fornecido." },
        { status: 400 }
      );
    }

    // Processa o texto extraído diretamente no Claude. Documentos extensos
    // são divididos em blocos (nunca truncados) e cada bloco tem retry
    // automático para erros transitórios (503 sobrecarga, 429 limite de taxa).
    const resultado = await processarTextoProcesso(texto);

    return NextResponse.json({
      status: "done",
      resultado,
    });
  } catch (error: any) {
    console.error("[API Extract Error]:", error);
    return NextResponse.json(
      { error: humanizarErroClaude(error) },
      { status: 500 }
    );
  }
}