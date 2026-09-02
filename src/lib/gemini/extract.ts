// src/lib/gemini/extract.ts
//
// Extração de dados de triagem via Gemini (Google AI Studio, FREE TIER).
// Usa responseSchema (JSON mode nativo do Gemini) para garantir saída
// estritamente tipada — equivalente ao Tool Use da Anthropic, mas sem custo.
//
// PROJETADO PARA O FREE TIER DE VERDADE — leia antes de mexer nos limites:
// o free tier tem RPM (requisições/minuto), TPM (tokens/minuto) e RPD
// (requisições/dia) reais. Estourar qualquer um deles = 429
// RESOURCE_EXHAUSTED. Este módulo:
//   1. Manda o processo inteiro numa ÚNICA chamada quando cabe no orçamento
//      de TPM (a maioria dos casos, já que a janela é de 1.000.000 tokens).
//   2. Se não couber, fatia e RESPEITA o limite de RPM entre chamadas
//      (60/RPM segundos de pausa, não um número arbitrário).
//   3. Tenta de novo com backoff em 429/503 — transitórios neste tier são
//      normais mesmo dentro da cota (variação de carga do lado da Google).

import { GoogleGenAI, Type } from "@google/genai";
import { getGeminiClient, MODEL_EXTRACAO, FREE_TIER_RPM } from "@/lib/gemini/client";
import type { ProcessoTriagemExtraido } from "@/lib/types";

export interface ProgressoProcessamento {
  progresso?: number;
  etapa?: string;
  status?: "processing" | "done" | "error";
  total_blocos?: number;
  blocos_concluidos?: number;
  estimativa_segundos?: number;
}

// Orçamento seguro por chamada: ~600.000 caracteres ≈ 150.000 tokens
// estimados, com boa margem dentro do TPM de 250.000 do free tier E da
// janela de 1.000.000 de tokens do modelo — mesmo um processo de 700+
// páginas normalmente cabe numa única chamada.
const MAX_CHARS_POR_BLOCO = 600_000;

// Pausa entre chamadas sequenciais = tempo real do limite de RPM do free
// tier, com uma margem de segurança de 20% (não o mínimo matemático exato).
const DELAY_ENTRE_BLOCOS_MS = Math.ceil((60_000 / FREE_TIER_RPM) * 1.2);

const MAX_TENTATIVAS = 4;
const BACKOFF_BASE_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErroTransitorio(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|503|resource_exhausted|unavailable|overloaded|rate limit|internal/i.test(msg);
}

/** Mensagem amigável — nunca expõe stack trace de SDK na tela do perito. */
export function humanizarErroGemini(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (/429|resource_exhausted|rate limit/i.test(msg)) {
    return (
      `Limite de uso gratuito do Gemini atingido no momento (máx. ${FREE_TIER_RPM} análises por minuto, ` +
      `250 por dia). Aguarde um instante e tente novamente — o limite diário reseta à meia-noite (horário do Pacífico, EUA).`
    );
  }
  if (/503|unavailable|overloaded/i.test(msg)) {
    return "O Gemini está temporariamente sobrecarregado. Tente novamente em alguns segundos.";
  }
  if (/api key|permission|unauthorized|401|403/i.test(msg)) {
    return "Falha de autenticação com a API do Gemini. Verifique a variável GEMINI_API_KEY no servidor.";
  }
  if (/404|not_found|no longer available/i.test(msg)) {
    return (
      "O modelo do Gemini configurado no servidor não está mais disponível para esta chave de API " +
      "(a Google troca a geração padrão do free tier com frequência). Verifique o modelo atual em " +
      "aistudio.google.com e atualize MODEL_EXTRACAO/MODEL_LAUDO em src/lib/gemini/client.ts."
    );
  }
  return msg;
}

async function comRetry<T>(fn: () => Promise<T>, contexto: string): Promise<T> {
  let ultimoErro: unknown;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      return await fn();
    } catch (err) {
      ultimoErro = err;
      if (!isErroTransitorio(err) || tentativa === MAX_TENTATIVAS) throw err;

      const espera = BACKOFF_BASE_MS * 2 ** (tentativa - 1) + Math.floor(Math.random() * 1000);
      console.warn(
        `[Gemini] ${contexto}: erro transitório na tentativa ${tentativa}/${MAX_TENTATIVAS}, tentando de novo em ${espera}ms.`
      );
      await delay(espera);
    }
  }

  throw ultimoErro;
}

// ---------------------------------------------------------------------------
// Schema de extração (JSON mode nativo do Gemini) — equivalente ao Tool Use
// da Anthropic. Campos ausentes no texto = simplesmente não incluídos pelo
// modelo (nullable), nunca um valor inventado.
// ---------------------------------------------------------------------------

const TRIAGEM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    numero_processo: { type: Type.STRING, nullable: true },
    vara: { type: Type.STRING, nullable: true },
    autor: { type: Type.STRING, nullable: true },
    reu: { type: Type.STRING, nullable: true },
    dib: { type: Type.STRING, nullable: true, description: "Formato DD/MM/AAAA" },
    der: { type: Type.STRING, nullable: true, description: "Formato DD/MM/AAAA" },
    rmi: { type: Type.NUMBER, nullable: true },
    indice_determinado_pelo_juiz: { type: Type.STRING, nullable: true },
    data_citacao: { type: Type.STRING, nullable: true, description: "Formato DD/MM/AAAA" },
    sistema_amortizacao: {
      type: Type.STRING,
      nullable: true,
      enum: ["PRICE", "SAC", "NAO_IDENTIFICADO"],
    },
    taxa_juros_contratada_am: { type: Type.NUMBER, nullable: true },
    observacoes_para_conferencia_humana: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    quesitos: {
      type: Type.OBJECT,
      properties: {
        autor: { type: Type.ARRAY, items: { type: Type.STRING } },
        juiz: { type: Type.ARRAY, items: { type: Type.STRING } },
        reu: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
    },
  },
} as unknown as import("@google/genai").Schema;

function buildSystemInstruction(): string {
  return `
Você é um assistente pericial especializado em triagem de processos judiciais brasileiros.
Extraia estritamente os dados literalmente presentes no texto, no formato JSON solicitado.

Regras inegociáveis:
- Extraia apenas o que está literalmente no texto. Nunca estime, nunca infira.
- Se um dado não estiver no texto, retorne null para o campo (nunca invente).
- Datas no formato DD/MM/AAAA, exatamente como aparecem no texto.
- Quesitos transcritos fielmente, sem parafrasear o mérito.
- Preencha "observacoes_para_conferencia_humana" sempre que houver ambiguidade.
- O texto pode conter marcadores [[FLS. N]] indicando o início de cada folha — eles NÃO
  são conteúdo do processo, nunca os copie para nenhum campo.
`.trim();
}

function normalizarResultado(input: any): ProcessoTriagemExtraido {
  return {
    numero_processo: input?.numero_processo ?? null,
    vara: input?.vara ?? null,
    autor: input?.autor ?? null,
    reu: input?.reu ?? null,
    dib: input?.dib ?? null,
    der: input?.der ?? null,
    rmi: input?.rmi ?? null,
    indice_determinado_pelo_juiz: input?.indice_determinado_pelo_juiz ?? null,
    data_citacao: input?.data_citacao ?? null,
    sistema_amortizacao: input?.sistema_amortizacao ?? null,
    taxa_juros_contratada_am: input?.taxa_juros_contratada_am ?? null,
    observacoes_para_conferencia_humana: input?.observacoes_para_conferencia_humana ?? [],
    quesitos: {
      autor: input?.quesitos?.autor ?? [],
      juiz: input?.quesitos?.juiz ?? [],
      reu: input?.quesitos?.reu ?? [],
    },
  };
}

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
    observacoes_para_conferencia_humana: parciais.flatMap((p) => p.observacoes_para_conferencia_humana ?? []),
    quesitos: {
      autor: parciais.flatMap((p) => p.quesitos?.autor ?? []),
      juiz: parciais.flatMap((p) => p.quesitos?.juiz ?? []),
      reu: parciais.flatMap((p) => p.quesitos?.reu ?? []),
    },
  };
}

async function extrairBloco(
  texto: string,
  blocoInfo?: { indice: number; total: number }
): Promise<ProcessoTriagemExtraido> {
  const client = getGeminiClient();
  const contexto = blocoInfo ? `bloco ${blocoInfo.indice}/${blocoInfo.total}` : "documento único";

  const prefixoBloco = blocoInfo
    ? `Bloco ${blocoInfo.indice}/${blocoInfo.total} de um processo extenso (trecho, não o documento ` +
      `inteiro). Campo ausente aqui = null (pode estar em outro bloco).\n\n`
    : "";

  const response = await comRetry(
    () =>
      client.models.generateContent({
        model: MODEL_EXTRACAO,
        contents: [{ role: "user", parts: [{ text: `${prefixoBloco}Texto do processo:\n${texto}` }] }],
        config: {
          systemInstruction: buildSystemInstruction(),
          responseMimeType: "application/json",
          responseSchema: TRIAGEM_SCHEMA,
          temperature: 0,
        },
      }),
    contexto
  );

  return normalizarResultado(JSON.parse(response.text ?? "{}"));
}

/**
 * Processa o texto completo do processo. Caminho rápido (uma chamada) para
 * a maioria dos casos; fatiamento com pausa respeitando o RPM real do free
 * tier para os poucos casos que excedem o orçamento de uma única chamada.
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
    onProgress?.({ progresso: 50, etapa: "Analisando o processo com o Gemini (gratuito)...", total_blocos: 1, blocos_concluidos: 0 });
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
      estimativa_segundos: Math.ceil(((totalBlocos - i) * DELAY_ENTRE_BLOCOS_MS) / 1000),
    });

    const parcial = await extrairBloco(blocos[i], { indice: i + 1, total: totalBlocos });
    parciais.push(parcial);

    // Respeita o RPM real do free tier antes do próximo bloco — não um
    // número arbitrário, é 60000/RPM com 20% de margem.
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

// Stub — extração de extrato bancário ainda não implementada (era stub nas
// versões anteriores também). A rota extract-extrato tem uma inconsistência
// pré-existente (espera documentId, cliente envia texto) fora deste escopo.
export async function extractExtratoBancario(
  _fileBase64OrText: string,
  _mimeType?: string
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
