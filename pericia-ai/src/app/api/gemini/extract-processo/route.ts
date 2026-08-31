// pericia-ai/src/app/api/gemini/extract-processo/route.ts

import { NextRequest, NextResponse } from "next/server";
import { processarTextoProcesso } from "@/lib/gemini/extract";

export async function POST(req: NextRequest) {
  try {
    const { texto, caseId } = await req.json();

    if (!texto || typeof texto !== "string") {
      return NextResponse.json(
        { error: "O texto do processo é obrigatório." },
        { status: 400 }
      );
    }

    // REDUÇÃO DE CARGA PARA FREE TIER (Evita estouro de TPM - 250k)
    // Limita o envio para no máximo 120.000 caracteres (~30k tokens)
    const LIMITE_MAXIMO = 120000;
    let textoAmostrado = texto;

    if (texto.length > LIMITE_MAXIMO) {
      const inicio = texto.slice(0, 84000); // 70% do limite (página inicial, petição)
      const fim = texto.slice(-36000);       // 30% do limite (sentença, acórdão)
      
      textoAmostrado = `${inicio}\n\n[... TEXTO INTERMEDIÁRIO OMITIDO PARA EVITAR OVERFLOW DE COTA ...]\n\n${fim}`;
    }

    // Executa apenas 1 chamada limpa para a API
    const dadosExtraidos = await processarTextoProcesso(textoAmostrado, caseId);

    return NextResponse.json({ success: true, data: dadosExtraidos });
  } catch (error: any) {
    console.error("[API Extract Error]:", error);

    // Tratamento amigável para erro de Cota (429)
    if (error?.status === 429 || error?.message?.includes("429")) {
      return NextResponse.json(
        {
          error: "Limite de requisições da API excedido. Por favor, aguarde 30 segundos e tente novamente.",
        },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: error?.message || "Erro interno ao processar o processo." },
      { status: 500 }
    );
  }
}