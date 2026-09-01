import { NextResponse } from "next/server";
import { processarTextoProcesso } from "@/lib/claude/extract";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { texto, caseId } = await req.json();

    if (!texto) {
      return NextResponse.json(
        { error: "Texto do processo não fornecido." },
        { status: 400 }
      );
    }

    // Chama o Claude com a chave ANTHROPIC_API_KEY
    const resultado = await processarTextoProcesso(texto, caseId);

    return NextResponse.json(resultado);
  } catch (error: any) {
    console.error("[API Extract Error]:", error);
    return NextResponse.json(
      { error: error.message || "Erro durante o processamento do documento." },
      { status: 500 }
    );
  }
}