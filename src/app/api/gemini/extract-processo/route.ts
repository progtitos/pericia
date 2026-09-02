import { NextRequest, NextResponse } from "next/server";
import { processarTextoProcesso, humanizarErroGemini } from "@/lib/gemini/extract";

// Fatiamento (quando necessário) respeita o RPM do free tier — cada bloco
// pode levar alguns segundos de pausa antes do próximo. 300s cobre até
// documentos bem extensos; no plano Hobby da Vercel o teto real é 60s
// independente do valor aqui.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { texto } = body;

    if (!texto || typeof texto !== "string") {
      return NextResponse.json({ error: "Nenhum texto válido foi fornecido." }, { status: 400 });
    }

    const resultado = await processarTextoProcesso(texto);

    return NextResponse.json({ status: "done", resultado });
  } catch (error: any) {
    console.error("[API Extract Error]:", error);
    return NextResponse.json({ error: humanizarErroGemini(error) }, { status: 500 });
  }
}
