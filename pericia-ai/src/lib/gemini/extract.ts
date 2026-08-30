// src/lib/gemini/extract.ts

import type { ProcessoTriagemExtraido, ReconciliacaoResultado } from "@/lib/types";

export const SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK = 20;

export async function extractExtratoBancario(
  texto: string
): Promise<{ lancamentos: any[]; saldo_final_informado: number | null }> {
  // Lógica de extração de extrato via Gemini
  return {
    lancamentos: [],
    saldo_final_informado: null,
  };
}

export async function generateLaudoMinuta(
  caseId: string,
  runId: string
): Promise<{ content_markdown: string }> {
  // Lógica de geração de laudo pericial em Markdown via Gemini
  return {
    content_markdown: `# Minuta de Laudo Pericial\n\nProcesso analisado com sucesso.`,
  };
}

export async function extractProcesso(texto: string): Promise<ProcessoTriagemExtraido> {
  // Mantém/Adiciona a exportação do extractProcesso se já existente
  return {
    numero_processo: "Em análise",
    vara: null,
    autor: null,
    reu: null,
    dib: null,
    der: null,
    rmi: null,
    indice_determinado_pelo_juiz: null,
    observacoes_para_conferencia_humana: [],
  };
}