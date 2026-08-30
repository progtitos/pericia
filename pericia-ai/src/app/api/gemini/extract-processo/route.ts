import { NextRequest, NextResponse } from "next/server";
import { processarTextoProcesso } from "@/lib/gemini/extract";

export const maxDuration = 60; // Duração máxima Serverless Vercel

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

    // Processa o texto extraído diretamente no Gemini
    const resultado = await processarTextoProcesso(texto);

    return NextResponse.json({
      status: "done",
      resultado,
    });
  } catch (error: any) {
    console.error("[API Extract Error]:", error);
    return NextResponse.json(
      { error: error.message || "Erro interno ao processar o processo." },
      { status: 500 }
    );
  }
}