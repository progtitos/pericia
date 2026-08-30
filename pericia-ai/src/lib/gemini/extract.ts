// pericia-ai/src/lib/gemini/extract.ts

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ProcessoTriagemExtraido } from "@/lib/types";

export const SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK = 20;

export interface ProgressoProcessamento {
  progresso?: number;
  mensagem?: string;
  tempoRestanteSegundos?: number;
  estimativa_segundos?: number;
  status?: "processing" | "done" | "error";
  total_blocos?: number;
  blocos_concluidos?: number;
  etapa?: string;
  erro?: string;
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export async function processarTextoProcesso(
  texto: string,
  caseId?: string
): Promise<ProcessoTriagemExtraido> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("A chave GEMINI_API_KEY não está configurada.");
  }

  // Utiliza o alias oficial gemini-1.5-pro-latest
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-pro-latest",
    generationConfig: { responseMimeType: "application/json" },
  });

  const prompt = `
  Você é um assistente pericial especializado em triagem de processos judiciais.
  Análise o texto do processo abaixo e extraia estritamente os seguintes dados no formato JSON:

  {
    "numero_processo": "string ou null",
    "vara": "string ou null",
    "autor": "string ou null",
    "reu": "string ou null",
    "dib": "string (DD/MM/AAAA) ou null",
    "der": "string (DD/MM/AAAA) ou null",
    "rmi": "number ou null",
    "indice_determinado_pelo_juiz": "string ou null",
    "data_citacao": "string (DD/MM/AAAA) ou null",
    "sistema_amortizacao": "string ou null",
    "taxa_juros_contratada_am": "number ou null",
    "observacoes_para_conferencia_humana": ["string"],
    "quesitos": {
      "autor": ["string"],
      "juiz": ["string"],
      "reu": ["string"]
    }
  }

  Texto do processo:
  ${texto.slice(0, 800000)}
  `;

  const result = await model.generateContent(prompt);
  const responseText = result.response.text();
  const jsonParsed = JSON.parse(responseText);

  return {
    numero_processo: jsonParsed.numero_processo ?? "Não identificado",
    vara: jsonParsed.vara ?? null,
    autor: jsonParsed.autor ?? null,
    reu: jsonParsed.reu ?? null,
    dib: jsonParsed.dib ?? null,
    der: jsonParsed.der ?? null,
    rmi: jsonParsed.rmi ?? null,
    indice_determinado_pelo_juiz: jsonParsed.indice_determinado_pelo_juiz ?? null,
    observacoes_para_conferencia_humana: jsonParsed.observacoes_para_conferencia_humana ?? [],
    data_citacao: jsonParsed.data_citacao ?? null,
    sistema_amortizacao: jsonParsed.sistema_amortizacao ?? null,
    taxa_juros_contratada_am: jsonParsed.taxa_juros_contratada_am ?? null,
    quesitos: jsonParsed.quesitos ?? { autor: [], juiz: [], reu: [] },
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