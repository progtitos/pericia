import { NextRequest, NextResponse } from "next/server";
import { processarTextoProcesso, humanizarErroGemini } from "@/lib/gemini/extract";

// Duração máxima da função serverless. Processos extensos agora são
// divididos em vários blocos processados em SEQUÊNCIA (nunca truncados),
// cada um com retry automático em caso de 503/429 — isso pode levar mais
// tempo do que os 60s antigos. 300s é o teto do plano Vercel Pro; no plano
// Hobby o limite é 60s independente do que for configurado aqui — se o seu
// projeto estiver no Hobby e continuar expirando em documentos muito
// grandes, é necessário migrar para Pro (Fluid Compute) ou mover este
// processamento para um job em background.
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

    // Processa o texto extraído diretamente no Gemini. Documentos extensos
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
      { error: humanizarErroGemini(error) },
      { status: 500 }
    );
  }
}