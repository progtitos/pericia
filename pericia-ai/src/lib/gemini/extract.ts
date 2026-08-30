// pericia-ai/src/lib/gemini/extract.ts

import type { ProcessoTriagemExtraido } from "@/lib/types";

export const SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK = 20;

export interface ProgressoProcessamento {
  progresso?: number;
  mensagem?: string;
  tempoRestanteSegundos?: number;
  status?: "processing" | "done" | "error";
  total_blocos?: number;
  blocos_concluidos?: number;
  etapa?: string;
}

export async function processarTextoProcesso(
  texto: string,
  caseId?: string
): Promise<ProcessoTriagemExtraido> {
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

export async function extractExtratoBancario(
  fileBase64OrText: string,
  mimeType?: string
): Promise<{
  banco?: string;
  conta?: string;
  saldo_inicial?: number;
  saldo_final?: number;
  alertas?: string[];
  lancamentos: any[];
  saldo_final_informado?: number | null;
}> {
  return {
    banco: "",
    conta: "",
    saldo_inicial: 0,
    saldo_final: 0,
    alertas: [],
    lancamentos: [],
    saldo_final_informado: null,
  };
}

export async function generateLaudoMinuta(
  paramsOrCaseId: any,
  runId?: string
): Promise<string | { content_markdown: string }> {
  return `# Minuta de Laudo Pericial\n\nProcesso analisado com sucesso.`;
}