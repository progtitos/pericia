import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { reconciliarExtrato } from "@/lib/calc/reconciliation";
import type { ExtratoExtraido } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/calculo/reconciliacao
 * body: { extrato: ExtratoExtraido }
 * Endpoint utilitário para re-rodar a checagem determinística de saldo
 * (ex.: depois que o perito corrige manualmente um lançamento suspeito
 * apontado pela IA, sem precisar refazer o OCR inteiro).
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const { extrato } = (await req.json()) as { extrato: ExtratoExtraido };
  if (!extrato) return NextResponse.json({ error: "extrato é obrigatório." }, { status: 400 });

  const reconciliacao = reconciliarExtrato(extrato);
  return NextResponse.json({ reconciliacao });
}
