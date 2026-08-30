import { getGeminiClient, MODELS } from "@/lib/gemini/client";
import {
  SYSTEM_INSTRUCTION_TRIAGEM,
  buildTriagemBlocoPrompt,
  TRIAGEM_RESPONSE_SCHEMA,
  buildLaudoPrompt,
} from "@/lib/gemini/prompts";
import { anonymizeText, deanonymizeText } from "@/lib/lgpd/anonymize";
import type { ProcessoTriagemExtraido, ChunkingBlockInfo } from "@/lib/types";

/**
 * ---------------------------------------------------------------------------
 * MOTOR DE EXTRAÇÃO — MODO NÍVEL GRATUITO (FREE TIER) DO GEMINI
 * ---------------------------------------------------------------------------
 * Diferente de `chunking.ts` (que assume um plano pago e blocos de
 * 200k-300k tokens), este arquivo implementa uma estratégia deliberadamente
 * mais conservadora para funcionar 100% dentro da cota gratuita:
 *
 *   1. Extrai TEXTO PURO do PDF inteiro (pdf-parse) — nunca o binário.
 *   2. Fatia esse texto em blocos pequenos (40k-50k caracteres, ~10k-12k
 *      tokens) — bem abaixo do TPM do nível gratuito.
 *   3. Processa os blocos em SEQUÊNCIA (nunca em paralelo), com um delay
 *      fixo de segurança entre cada chamada, para respeitar o RPM.
 *   4. Reporta progresso a cada bloco concluído via callback `onProgress`
 *      (quem persiste isso no Supabase é a rota, não esta lib).
 *   5. Ao final, faz UMA chamada extra de síntese ao Gemini para consolidar
 *      todas as extrações parciais no JSON final único.
 *
 * Cada chamada individual (bloco pequeno de texto) fica muito abaixo do
 * limite de contexto e do timeout de requisição HTTP — o "documento gigante"
 * nunca é enviado de uma vez, nem para o Gemini nem em uma única requisição
 * serverless.
 */

// ---------------------------------------------------------------------------
// Configuração (todas sobrescrevíveis por env var, sem quebrar o default
// pedido: modelo gemini-1.5-flash, blocos de 40k-50k chars, delay de 6s)
// ---------------------------------------------------------------------------

/** Modelo usado no fluxo gratuito. Fixo em gemini-1.5-flash por exigência de
 *  cota — independente do que MODELS.FLASH aponte em client.ts. */
export const MODEL_FREE_TIER = process.env.GEMINI_FREE_TIER_MODEL || "gemini-1.5-flash";

/** Tamanho-alvo de cada bloco de texto, em caracteres (~10k-12k tokens). */
export const TAMANHO_ALVO_BLOCO_CHARS =
  Number(process.env.GEMINI_FREE_TIER_CHUNK_CHARS) || 45_000;

/** Delay de segurança OBRIGATÓRIO entre cada chamada ao Gemini, para nunca
 *  estourar o RPM (requisições por minuto) do Nível Gratuito. */
export const DELAY_ENTRE_BLOCOS_MS =
  Number(process.env.GEMINI_FREE_TIER_DELAY_MS) || 6000;

/** Estimativa grosseira de segundos por bloco (delay fixo + margem de
 *  latência da própria chamada), usada como fallback antes de termos dados
 *  reais suficientes para calcular uma média adaptativa. */
export const SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK =
  Math.ceil(DELAY_ENTRE_BLOCOS_MS / 1000) + 4;

/** Quantas tentativas fazemos por bloco antes de desistir dele e seguir em
 *  frente (para uma falha isolada não derrubar o processamento inteiro de
 *  um documento de 800 páginas). */
const MAX_TENTATIVAS_POR_BLOCO = 3;

// ---------------------------------------------------------------------------
// Utilitários genéricos
// ---------------------------------------------------------------------------

/** Aguarda `ms` milissegundos. Usado entre cada chamada de bloco. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanJsonResponse(rawText: string): string {
  if (!rawText) return "{}";

  let cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const startIdx = cleaned.indexOf("{");
  const endIdx = cleaned.lastIndexOf("}");
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }

  return cleaned;
}

/** Detecta erro de limite de taxa (429 / RESOURCE_EXHAUSTED / quota). */
function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes("429") ||
    lower.includes("resource_exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("quota")
  );
}

// ---------------------------------------------------------------------------
// Persistência de progresso (tipo compartilhado com a rota de status)
// ---------------------------------------------------------------------------

export type StatusProcessamento = "pending" | "processing" | "done" | "error";

/** Formato exato gravado na coluna jsonb `progress` de `case_documents`. */
export interface ProgressoProcessamento {
  status: StatusProcessamento;
  progresso: number; // 0 a 100
  blocos_concluidos: number;
  total_blocos: number;
  estimativa_segundos: number;
  mensagem: string;
  atualizado_em: string; // ISO 8601
  erro?: string;
}

/** Monta um snapshot de progresso pronto para persistir no Supabase. */
export function montarProgresso(params: {
  status: StatusProcessamento;
  blocosConcluidos: number;
  totalBlocos: number;
  segundosRestantes: number;
  mensagem: string;
  erro?: string;
}): ProgressoProcessamento {
  const totalBlocos = Math.max(params.totalBlocos, 0);
  const blocosConcluidos = Math.max(
    0,
    totalBlocos > 0 ? Math.min(params.blocosConcluidos, totalBlocos) : params.blocosConcluidos
  );

  const progresso =
    params.status === "done"
      ? 100
      : totalBlocos > 0
      ? Math.min(99, Math.round((blocosConcluidos / totalBlocos) * 100))
      : 0;

  return {
    status: params.status,
    progresso,
    blocos_concluidos: blocosConcluidos,
    total_blocos: totalBlocos,
    estimativa_segundos: Math.max(0, Math.round(params.segundosRestantes)),
    mensagem: params.mensagem,
    atualizado_em: new Date().toISOString(),
    ...(params.erro ? { erro: params.erro } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. Extração de texto puro do PDF
// ---------------------------------------------------------------------------

/**
 * Extrai a string de texto completa de um PDF usando pdf-parse. Roda apenas
 * no servidor (Node) — import dinâmico para não entrar em bundle de client.
 */
export async function extrairTextoCompletoDoPdf(pdfBuffer: Buffer): Promise<string> {
  const pdfParse = (await import("pdf-parse")).default;
  const dados = await pdfParse(pdfBuffer);
  const texto = (dados.text || "").trim();

  if (texto.length < 20) {
    throw new Error(
      "Não foi possível extrair texto deste PDF (provavelmente um documento " +
        "digitalizado como imagem, sem camada de texto pesquisável)."
    );
  }

  return texto;
}

// ---------------------------------------------------------------------------
// 2. Fatiamento em memória (chunking em lote de texto puro)
// ---------------------------------------------------------------------------

/**
 * Divide o texto completo em blocos de no máximo `tamanhoMaximoCaracteres`
 * (padrão: 40k-50k). Respeita fronteiras de parágrafo sempre que possível;
 * se um único parágrafo isolado já ultrapassar o limite (ex.: uma tabela
 * densa extraída como uma linha só), corta à força em um espaço em branco
 * para nunca partir uma palavra ao meio.
 */
export function fatiarTextoEmBlocos(
  textoCompleto: string,
  tamanhoMaximoCaracteres: number = TAMANHO_ALVO_BLOCO_CHARS
): string[] {
  const paragrafos = textoCompleto.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  const trechosBrutos: string[] = [];
  for (const paragrafo of paragrafos) {
    if (paragrafo.length <= tamanhoMaximoCaracteres) {
      trechosBrutos.push(paragrafo);
      continue;
    }

    let restante = paragrafo;
    while (restante.length > tamanhoMaximoCaracteres) {
      let corte = restante.lastIndexOf(" ", tamanhoMaximoCaracteres);
      if (corte <= 0) corte = tamanhoMaximoCaracteres;
      trechosBrutos.push(restante.slice(0, corte));
      restante = restante.slice(corte);
    }
    if (restante.trim().length > 0) trechosBrutos.push(restante);
  }

  const blocos: string[] = [];
  let bufferAtual = "";
  for (const trecho of trechosBrutos) {
    if (
      bufferAtual.length + trecho.length + 2 > tamanhoMaximoCaracteres &&
      bufferAtual.length > 0
    ) {
      blocos.push(bufferAtual);
      bufferAtual = "";
    }
    bufferAtual += (bufferAtual ? "\n\n" : "") + trecho;
  }
  if (bufferAtual.trim().length > 0) blocos.push(bufferAtual);

  return blocos;
}

// ---------------------------------------------------------------------------
// 3. Chamada individual por bloco (com retentativa) + delay de segurança
// ---------------------------------------------------------------------------

async function extrairBlocoComGeminiFreeTier(
  textoBloco: string,
  blocoIndex: number,
  totalBlocos: number
): Promise<Partial<ProcessoTriagemExtraido>> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: MODEL_FREE_TIER,
    contents: [
      {
        role: "user",
        parts: [{ text: buildTriagemBlocoPrompt(textoBloco, blocoIndex, totalBlocos) }],
      },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION_TRIAGEM,
      responseMimeType: "application/json",
      responseSchema: TRIAGEM_RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  try {
    return JSON.parse(cleanJsonResponse(response.text ?? "{}")) as Partial<ProcessoTriagemExtraido>;
  } catch {
    throw new Error(`O modelo retornou um JSON inválido para o bloco ${blocoIndex}/${totalBlocos}.`);
  }
}

/**
 * Executa um bloco com até MAX_TENTATIVAS_POR_BLOCO tentativas. Se todas
 * falharem (ex.: rate limit persistente), o bloco NÃO derruba o
 * processamento inteiro — ele é registrado como "não processado" em
 * observações e o fluxo segue para o próximo bloco.
 */
async function extrairBlocoComRetentativa(
  textoBloco: string,
  blocoIndex: number,
  totalBlocos: number
): Promise<Partial<ProcessoTriagemExtraido>> {
  let ultimoErro: unknown = null;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_POR_BLOCO; tentativa++) {
    try {
      return await extrairBlocoComGeminiFreeTier(textoBloco, blocoIndex, totalBlocos);
    } catch (err) {
      ultimoErro = err;
      const ehLimiteDeTaxa = isRateLimitError(err);
      const aindaTemTentativa = tentativa < MAX_TENTATIVAS_POR_BLOCO;

      console.error(
        `[extract-processo] Falha ao processar bloco ${blocoIndex}/${totalBlocos} ` +
          `(tentativa ${tentativa}/${MAX_TENTATIVAS_POR_BLOCO}):`,
        err instanceof Error ? err.message : err
      );

      if (!aindaTemTentativa) break;

      // Backoff extra além do delay fixo entre blocos: mais generoso quando
      // o erro é explicitamente de cota, pois a janela de 1 minuto pode
      // ainda não ter resetado.
      await delay(ehLimiteDeTaxa ? DELAY_ENTRE_BLOCOS_MS * tentativa : 2000);
    }
  }

  const mensagemErro = ultimoErro instanceof Error ? ultimoErro.message : String(ultimoErro);
  return {
    observacoes_para_conferencia_humana: [
      `Bloco ${blocoIndex}/${totalBlocos} não pôde ser processado após ${MAX_TENTATIVAS_POR_BLOCO} ` +
        `tentativas e foi ignorado (erro: ${mensagemErro}). Revise manualmente o trecho correspondente do PDF.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// 4. Mesclagem determinística de reserva + normalização final
// ---------------------------------------------------------------------------

function mesclarParciaisDeterministicamente(
  parciais: Partial<ProcessoTriagemExtraido>[]
): Partial<ProcessoTriagemExtraido> {
  const primeiroNaoNulo = <T,>(vals: (T | null | undefined)[]): T | null =>
    vals.find((v) => v !== null && v !== undefined) ?? null;

  return {
    numero_processo: primeiroNaoNulo(parciais.map((p) => p.numero_processo)),
    autor: primeiroNaoNulo(parciais.map((p) => p.autor)),
    reu: primeiroNaoNulo(parciais.map((p) => p.reu)),
    vara: primeiroNaoNulo(parciais.map((p) => p.vara)),
    data_citacao: primeiroNaoNulo(parciais.map((p) => p.data_citacao)),
    dib: primeiroNaoNulo(parciais.map((p) => p.dib)),
    der: primeiroNaoNulo(parciais.map((p) => p.der)),
    rmi: primeiroNaoNulo(parciais.map((p) => p.rmi)),
    indice_determinado_pelo_juiz: primeiroNaoNulo(parciais.map((p) => p.indice_determinado_pelo_juiz)),
    sistema_amortizacao: primeiroNaoNulo(parciais.map((p) => p.sistema_amortizacao)),
    taxa_juros_contratada_am: primeiroNaoNulo(parciais.map((p) => p.taxa_juros_contratada_am)),
    quesitos: {
      autor: Array.from(new Set(parciais.flatMap((p) => p.quesitos?.autor ?? []))),
      juiz: Array.from(new Set(parciais.flatMap((p) => p.quesitos?.juiz ?? []))),
      reu: Array.from(new Set(parciais.flatMap((p) => p.quesitos?.reu ?? []))),
    },
    observacoes_para_conferencia_humana: Array.from(
      new Set(parciais.flatMap((p) => p.observacoes_para_conferencia_humana ?? []))
    ),
  };
}

function normalizarResultadoFinal(
  consolidado: Partial<ProcessoTriagemExtraido>
): ProcessoTriagemExtraido {
  return {
    numero_processo: consolidado.numero_processo ?? null,
    autor: consolidado.autor ?? null,
    reu: consolidado.reu ?? null,
    vara: consolidado.vara ?? null,
    data_citacao: consolidado.data_citacao ?? null,
    dib: consolidado.dib ?? null,
    der: consolidado.der ?? null,
    rmi: consolidado.rmi ?? null,
    indice_determinado_pelo_juiz: consolidado.indice_determinado_pelo_juiz ?? null,
    sistema_amortizacao: consolidado.sistema_amortizacao ?? null,
    taxa_juros_contratada_am: consolidado.taxa_juros_contratada_am ?? null,
    quesitos: {
      autor: consolidado.quesitos?.autor ?? [],
      juiz: consolidado.quesitos?.juiz ?? [],
      reu: consolidado.quesitos?.reu ?? [],
    },
    observacoes_para_conferencia_humana: consolidado.observacoes_para_conferencia_humana ?? [],
  };
}

function desanonimizarProfundo<T>(valor: T, tokenMap: Record<string, string>): T {
  if (typeof valor === "string") {
    return deanonymizeText(valor, tokenMap) as unknown as T;
  }
  if (Array.isArray(valor)) {
    return valor.map((item) => desanonimizarProfundo(item, tokenMap)) as unknown as T;
  }
  if (valor !== null && typeof valor === "object") {
    const resultado: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(valor as Record<string, unknown>)) {
      resultado[chave] = desanonimizarProfundo(item, tokenMap);
    }
    return resultado as T;
  }
  return valor;
}

// ---------------------------------------------------------------------------
// 5. Consolidação final — chamada de síntese ao Gemini
// ---------------------------------------------------------------------------

function buildConsolidacaoPrompt(parciais: Partial<ProcessoTriagemExtraido>[]): string {
  return `
Você recebeu ${parciais.length} extrações PARCIAIS de um mesmo processo judicial extenso,
cada uma feita separadamente sobre um TRECHO diferente do documento (em ordem sequencial).
Alguns campos podem estar repetidos entre trechos, outros podem faltar em um trecho e
existir em outro, e listas (quesitos, observações) podem estar fragmentadas.

Consolide essas extrações parciais em um único objeto final, seguindo estas regras:
- Para campos de valor único (numero_processo, autor, reu, vara, data_citacao, dib, der,
  rmi, indice_determinado_pelo_juiz, sistema_amortizacao, taxa_juros_contratada_am): use o
  primeiro valor não nulo encontrado entre os trechos, na ordem em que aparecem abaixo.
- Para "quesitos" (autor/juiz/reu) e "observacoes_para_conferencia_humana": una todos os
  itens de todos os trechos, sem duplicar itens idênticos.
- Nunca invente ou estime um valor que não esteja literalmente presente em algum trecho.

EXTRAÇÕES PARCIAIS (JSON, uma por trecho, em ordem):
${JSON.stringify(parciais)}
`.trim();
}

async function consolidarBlocosComGemini(
  parciais: Partial<ProcessoTriagemExtraido>[]
): Promise<ProcessoTriagemExtraido> {
  if (parciais.length === 1) {
    // Só um bloco: não há nada para sintetizar — evita gastar mais uma
    // chamada de API à toa (relevante no plano gratuito).
    return normalizarResultadoFinal(parciais[0]);
  }

  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: MODEL_FREE_TIER,
    contents: [{ role: "user", parts: [{ text: buildConsolidacaoPrompt(parciais) }] }],
    config: {
      systemInstruction:
        "Você consolida extrações parciais de processos judiciais em um único JSON final, " +
        "por mesclagem determinística — nunca inventa dados que não estejam nos trechos recebidos.",
      responseMimeType: "application/json",
      responseSchema: TRIAGEM_RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  let consolidado: Partial<ProcessoTriagemExtraido>;
  try {
    consolidado = JSON.parse(cleanJsonResponse(response.text ?? "{}"));
  } catch {
    console.error(
      "[extract-processo] JSON inválido na consolidação final; aplicando mesclagem determinística de reserva."
    );
    consolidado = mesclarParciaisDeterministicamente(parciais);
  }

  return normalizarResultadoFinal(consolidado);
}

// ---------------------------------------------------------------------------
// Orquestrador principal — chamado pela rota /api/gemini/extract-processo
// ---------------------------------------------------------------------------

export async function processarExtracaoProcessoFreeTier(
  pdfBuffer: Buffer,
  opcoes: {
    /** Chamado após cada bloco concluído e antes/depois da consolidação. */
    onProgress?: (progresso: ProgressoProcessamento) => Promise<void> | void;
    /** Se true, aplica mascaramento de CPF/CNPJ/conta ANTES de enviar o
     *  texto ao Gemini (ver lib/lgpd/anonymize.ts) e reverte no resultado
     *  final antes de retornar. */
    anonimizarAntesDoEnvio?: boolean;
  } = {}
): Promise<ProcessoTriagemExtraido> {
  const textoCompleto = await extrairTextoCompletoDoPdf(pdfBuffer);

  let textoParaProcessar = textoCompleto;
  let tokenMap: Record<string, string> | null = null;

  if (opcoes.anonimizarAntesDoEnvio) {
    const anonimizado = anonymizeText(textoCompleto);
    textoParaProcessar = anonimizado.anonymizedText;
    tokenMap = anonimizado.tokenMap;
  }

  const blocos = fatiarTextoEmBlocos(textoParaProcessar);
  const totalBlocos = blocos.length;

  if (totalBlocos === 0) {
    throw new Error("Não há conteúdo de texto para processar após o fatiamento do PDF.");
  }

  const blocosInfo: ChunkingBlockInfo[] = [];
  const parciais: Partial<ProcessoTriagemExtraido>[] = [];
  const inicio = Date.now();

  for (let i = 0; i < totalBlocos; i++) {
    // Delay de segurança ANTES de cada chamada (exceto a primeiríssima) —
    // garante ao menos 6s de intervalo entre requisições ao Gemini,
    // respeitando o RPM do Nível Gratuito.
    if (i > 0) {
      await delay(DELAY_ENTRE_BLOCOS_MS);
    }

    const parcial = await extrairBlocoComRetentativa(blocos[i], i + 1, totalBlocos);
    parciais.push(parcial);

    blocosInfo.push({
      indice: i + 1,
      rotulo: `Bloco ${i + 1}`,
      // Não rastreamos página aqui (o texto é tratado como uma única string
      // contínua, não por página) — mantidos em 0 apenas para satisfazer o
      // formato compartilhado ChunkingBlockInfo.
      paginaInicial: 0,
      paginaFinal: 0,
      tokensEstimados: Math.ceil(blocos[i].length / 3.5),
    });

    const segundosDecorridos = (Date.now() - inicio) / 1000;
    const mediaSegundosPorBloco = segundosDecorridos / (i + 1);
    const blocosRestantes = totalBlocos - (i + 1);
    const estimativaSegundosRestantes =
      blocosRestantes > 0
        ? mediaSegundosPorBloco * blocosRestantes
        : SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK;

    await opcoes.onProgress?.(
      montarProgresso({
        status: "processing",
        blocosConcluidos: i + 1,
        totalBlocos,
        segundosRestantes: estimativaSegundosRestantes,
        mensagem:
          blocosRestantes > 0
            ? `Processando bloco ${i + 1} de ${totalBlocos}...`
            : `Bloco ${i + 1} de ${totalBlocos} concluído. Preparando consolidação final...`,
      })
    );
  }

  // Delay de segurança também antes da chamada de consolidação: ela é mais
  // uma requisição ao Gemini e conta para a mesma cota por minuto.
  await delay(DELAY_ENTRE_BLOCOS_MS);

  await opcoes.onProgress?.(
    montarProgresso({
      status: "processing",
      blocosConcluidos: totalBlocos,
      totalBlocos,
      segundosRestantes: SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK,
      mensagem: "Consolidando resultado final com a IA...",
    })
  );

  let resultadoConsolidado: ProcessoTriagemExtraido;
  try {
    resultadoConsolidado = await consolidarBlocosComGemini(parciais);
  } catch (err) {
    console.error(
      "[extract-processo] Falha na chamada de consolidação final; aplicando mesclagem determinística de reserva:",
      err
    );
    resultadoConsolidado = normalizarResultadoFinal(mesclarParciaisDeterministicamente(parciais));
  }

  if (tokenMap) {
    resultadoConsolidado = desanonimizarProfundo(resultadoConsolidado, tokenMap);
  }

  return {
    ...resultadoConsolidado,
    observacoes_para_conferencia_humana: [
      `Documento processado em modo Nível Gratuito (chunking em ${totalBlocos} blocos de texto puro) — ` +
        `revise os campos abaixo com atenção redobrada.`,
      ...resultadoConsolidado.observacoes_para_conferencia_humana,
    ],
    _chunking_info: {
      chunked: true,
      totalBlocos: blocosInfo.length,
      blocos: blocosInfo,
    },
  };
}

// ---------------------------------------------------------------------------
// Demais funções do módulo (mantidas, apenas corrigidas para usar o SDK
// @google/genai — a versão anterior usava @google/generative-ai, que não
// está mais no package.json e quebrava o build).
// ---------------------------------------------------------------------------

/** Extrai lançamentos de um extrato bancário (imagem/PDF) via OCR multimodal. */
export async function extractExtratoBancario(
  fileInput: Buffer | string,
  mimeType: string = "application/pdf"
): Promise<any> {
  const ai = getGeminiClient();
  const base64Data = typeof fileInput === "string" ? fileInput : fileInput.toString("base64");

  const response = await ai.models.generateContent({
    model: MODELS.FLASH,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: base64Data, mimeType } },
          {
            text:
              "Extraia as movimentações financeiras deste extrato bancário em JSON estrito, " +
              "com os campos: banco, conta, saldo_inicial, saldo_final, alertas (array de " +
              "strings) e lancamentos (array de objetos { data, descricao, valor, tipo: 'C' | 'D' }).",
          },
        ],
      },
    ],
    config: { responseMimeType: "application/json", temperature: 0 },
  });

  return JSON.parse(cleanJsonResponse(response.text ?? "{}"));
}

/** Gera a minuta (Markdown) do laudo pericial a partir de dados já calculados. */
export async function generateLaudoMinuta(params: {
  processoTriagem: unknown;
  resultadoCalculo: unknown;
  quesitosAprovados: { author: string; question_text: string }[];
}): Promise<string> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: MODELS.FLASH,
    contents: [{ role: "user", parts: [{ text: buildLaudoPrompt(params) }] }],
    config: { temperature: 0.2 },
  });

  return response.text ?? "";
}