import { NextRequest, NextResponse } from "next/server";
import { gerarPlanilhaCalculo } from "@/lib/export/excel";
import type {
  ProcessoTriagemExtraido,
  ResultadoCalculoPrevidenciario,
  ReconciliacaoResultado,
} from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/export/planilha
 * body: { triagem, resultadoCalculo, reconciliacao?, valoresPagos? }
 *
 * O cliente já tem todos esses dados em memória (estado do CaseWorkspace),
 * então a rota é stateless: recebe o JSON, monta o .xlsx e devolve os bytes
 * prontos para download — sem depender de uma leitura extra do banco.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      triagem: ProcessoTriagemExtraido | null;
      resultadoCalculo: ResultadoCalculoPrevidenciario | null;
      reconciliacao?: ReconciliacaoResultado | null;
      valoresPagos?: Record<string, number>;
    };

    if (!body.resultadoCalculo) {
      return NextResponse.json(
        { error: "Execute o recálculo antes de baixar a planilha." },
        { status: 400 }
      );
    }

    const bytes = gerarPlanilhaCalculo(body);

    const numeroProcesso = body.triagem?.numero_processo?.replace(/[^\w.-]/g, "_") || "processo";

    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="calculo-pericial-${numeroProcesso}.xlsx"`,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Erro ao gerar a planilha." },
      { status: 500 }
    );
  }
}
