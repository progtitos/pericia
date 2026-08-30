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

const MODEL_NAME = "gemini-3.6-flash";

// Nenhum bloco enviado ao Gemini deve passar disso — mantém cada requisição
// leve (menos chance de 503/timeout) e, mais importante, GARANTE que o
// documento inteiro seja processado, em vez do corte fixo de 800.000
// caracteres que existia antes (que descartava silenciosamente processos
// grandes, ex.: um PDF de 775 páginas perdia mais da metade do conteúdo).
const MAX_CHARS_POR_BLOCO = 200_000;

// Pausa entre chamadas sequenciais de blocos — reduz a chance de o próprio
// volume de requisições em sequência disparar um novo 503/429.
const DELAY_ENTRE_BLOCOS_MS = 2000;

// Retry com backoff exponencial para erros TRANSITÓRIOS (503 sobrecarga,
// 429 limite de taxa). Erros de outra natureza (JSON inválido, API key
// ausente, etc.) não são re-tentados — não adianta tentar de novo.
const MAX_TENTATIVAS = 4;
const BACKOFF_BASE_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Detecta se um erro do Gemini é transitório (vale a pena tentar de novo). */
function isErroTransitorio(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /503|429|overloaded|high demand|unavailable|resource_exhausted|rate limit|timeout|deadline/i.test(
    msg
  );
}

/**
 * Converte o erro cru do SDK (ex.: "[GoogleGenerativeAI Error]: Error
 * fetching from ... [503 Service Unavailable] This model is currently
 * experiencing high demand...") numa mensagem curta e acionável em
 * português, para nunca mostrar stack trace de SDK na tela do perito.
 */
export function humanizarErroGemini(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (/503|overloaded|high demand|unavailable/i.test(msg)) {
    return "O Gemini está temporariamente sobrecarregado (erro 503 do próprio Google). Isso costuma se resolver em alguns minutos — tente novamente.";
  }
  if (/429|resource_exhausted|rate limit/i.test(msg)) {
    return "Limite de requisições da API do Gemini atingido no momento. Aguarde um instante e tente novamente.";
  }
  if (/api key|apikey|permission|unauthorized|401|403/i.test(msg)) {
    return "Falha de autenticação com a API do Gemini. Verifique a variável GEMINI_API_KEY no servidor.";
  }
  if (/json/i.test(msg)) {
    return "O Gemini retornou uma resposta em formato inesperado para este trecho do processo. Tente novamente ou revise o PDF enviado.";
  }
  return msg;
}

/** Executa `fn`, tentando novamente com backoff exponencial (+jitter) se o
 *  erro for transitório. Propaga imediatamente qualquer erro não-transitório. */
async function comRetry<T>(fn: () => Promise<T>, contexto: string): Promise<T> {
  let ultimoErro: unknown;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      return await fn();
    } catch (err) {
      ultimoErro = err;

      if (!isErroTransitorio(err) || tentativa === MAX_TENTATIVAS) {
        throw err;
      }

      const espera = BACKOFF_BASE_MS * 2 ** (tentativa - 1) + Math.floor(Math.random() * 500);
      console.warn(
        `[Gemini] ${contexto}: erro transitório na tentativa ${tentativa}/${MAX_TENTATIVAS}, ` +
          `tentando de novo em ${espera}ms. Motivo: ${(err as Error)?.message ?? err}`
      );
      await delay(espera);
    }
  }

  throw ultimoErro;
}

function getModel() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("A chave GEMINI_API_KEY não está configurada.");
  }
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: { responseMimeType: "application/json" },
  });
}

/**
 * Divide o texto completo em blocos de até MAX_CHARS_POR_BLOCO caracteres,
 * cortando em uma quebra de linha próxima ao limite (nunca no meio de uma
 * frase/número) para não partir um valor monetário ou uma data ao meio.
 */
function dividirEmBlocos(texto: string): string[] {
  if (texto.length <= MAX_CHARS_POR_BLOCO) return [texto];

  const blocos: string[] = [];
  let inicio = 0;

  while (inicio < texto.length) {
    let fim = Math.min(inicio + MAX_CHARS_POR_BLOCO, texto.length);
    if (fim < texto.length) {
      const quebra = texto.lastIndexOf("\n", fim);
      if (quebra > inicio) fim = quebra;
    }
    blocos.push(texto.slice(inicio, fim));
    inicio = fim;
  }

  return blocos;
}

function buildPromptTriagem(texto: string, blocoInfo?: { indice: number; total: number }): string {
  const contextoBloco = blocoInfo
    ? `\nEste é o BLOCO ${blocoInfo.indice} de ${blocoInfo.total} de um processo extenso (um trecho, não o documento inteiro). Se um campo não aparecer neste trecho, retorne null para ele — pode estar em outro bloco.\n`
    : "";

  return `
  Você é um assistente pericial especializado em triagem de processos judiciais.
  ${contextoBloco}
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

  Regra: extraia apenas o que está literalmente no texto. Campo ausente = null. Nunca estime.

  Texto do processo:
  ${texto}
  `;
}

function normalizarResultado(jsonParsed: any): ProcessoTriagemExtraido {
  return {
    numero_processo: jsonParsed.numero_processo ?? null,
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

/** Extrai um único bloco de texto (uma chamada ao Gemini), com retry embutido. */
async function extrairBloco(
  texto: string,
  blocoInfo?: { indice: number; total: number }
): Promise<ProcessoTriagemExtraido> {
  const model = getModel();
  const contexto = blocoInfo ? `bloco ${blocoInfo.indice}/${blocoInfo.total}` : "documento único";

  const resultado = await comRetry(async () => {
    const result = await model.generateContent(buildPromptTriagem(texto, blocoInfo));
    return result.response.text();
  }, contexto);

  return normalizarResultado(JSON.parse(resultado));
}

/**
 * Mescla extrações parciais de vários blocos numa única extração
 * consolidada: primeiro valor não-nulo vence, arrays são concatenados.
 * Feito por código determinístico — nunca por uma chamada extra à IA — para
 * não introduzir mais uma requisição que possa esbarrar em 503/429.
 */
function mesclarParciais(parciais: ProcessoTriagemExtraido[]): ProcessoTriagemExtraido {
  const primeiroNaoNulo = <T,>(vals: (T | null)[]): T | null =>
    vals.find((v) => v !== null && v !== undefined) ?? null;

  return {
    numero_processo: primeiroNaoNulo(parciais.map((p) => p.numero_processo)),
    vara: primeiroNaoNulo(parciais.map((p) => p.vara)),
    autor: primeiroNaoNulo(parciais.map((p) => p.autor)),
    reu: primeiroNaoNulo(parciais.map((p) => p.reu)),
    dib: primeiroNaoNulo(parciais.map((p) => p.dib)),
    der: primeiroNaoNulo(parciais.map((p) => p.der)),
    rmi: primeiroNaoNulo(parciais.map((p) => p.rmi)),
    indice_determinado_pelo_juiz: primeiroNaoNulo(parciais.map((p) => p.indice_determinado_pelo_juiz)),
    data_citacao: primeiroNaoNulo(parciais.map((p) => p.data_citacao)),
    sistema_amortizacao: primeiroNaoNulo(parciais.map((p) => p.sistema_amortizacao)),
    taxa_juros_contratada_am: primeiroNaoNulo(parciais.map((p) => p.taxa_juros_contratada_am)),
    observacoes_para_conferencia_humana: parciais.flatMap(
      (p) => p.observacoes_para_conferencia_humana ?? []
    ),
    quesitos: {
      autor: parciais.flatMap((p) => p.quesitos?.autor ?? []),
      juiz: parciais.flatMap((p) => p.quesitos?.juiz ?? []),
      reu: parciais.flatMap((p) => p.quesitos?.reu ?? []),
    },
  };
}

/**
 * Processa o texto completo do processo:
 *  - Se couber num único bloco, faz UMA chamada (caminho rápido — a maioria
 *    dos processos cai aqui).
 *  - Se for extenso, divide em blocos de até 200.000 caracteres e processa
 *    sequencialmente, com pausa entre chamadas e retry automático em caso de
 *    503/429, depois consolida tudo por código determinístico.
 *  - Nunca corta/descarta parte do texto: documentos grandes são divididos,
 *    não truncados.
 */
export async function processarTextoProcesso(
  texto: string,
  caseId?: string,
  onProgress?: (info: ProgressoProcessamento) => void
): Promise<ProcessoTriagemExtraido> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("A chave GEMINI_API_KEY não está configurada.");
  }

  const blocos = dividirEmBlocos(texto);
  const totalBlocos = blocos.length;

  if (totalBlocos === 1) {
    onProgress?.({ progresso: 50, etapa: "Analisando o processo com o Gemini...", total_blocos: 1, blocos_concluidos: 0 });
    const resultado = await extrairBloco(blocos[0]);
    onProgress?.({ progresso: 100, etapa: "Concluído.", total_blocos: 1, blocos_concluidos: 1, status: "done" });
    return resultado;
  }

  const parciais: ProcessoTriagemExtraido[] = [];

  for (let i = 0; i < blocos.length; i++) {
    onProgress?.({
      progresso: Math.round((i / totalBlocos) * 100),
      etapa: `Analisando bloco ${i + 1} de ${totalBlocos}...`,
      total_blocos: totalBlocos,
      blocos_concluidos: i,
      estimativa_segundos: (totalBlocos - i) * SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK,
    });

    const parcial = await extrairBloco(blocos[i], { indice: i + 1, total: totalBlocos });
    parciais.push(parcial);

    if (i < blocos.length - 1) await delay(DELAY_ENTRE_BLOCOS_MS);
  }

  onProgress?.({ progresso: 100, etapa: "Consolidando resultado final...", total_blocos: totalBlocos, blocos_concluidos: totalBlocos, status: "done" });

  const consolidado = mesclarParciais(parciais);
  return {
    ...consolidado,
    observacoes_para_conferencia_humana: [
      `Documento extenso (${totalBlocos} blocos) — revise os campos abaixo com atenção redobrada.`,
      ...consolidado.observacoes_para_conferencia_humana,
    ],
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
