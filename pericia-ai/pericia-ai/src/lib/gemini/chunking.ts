import { getGeminiClient, MODELS } from "@/lib/gemini/client";
import {
  SYSTEM_INSTRUCTION_TRIAGEM,
  buildTriagemBlocoPrompt,
  TRIAGEM_RESPONSE_SCHEMA,
} from "@/lib/gemini/prompts";
import type {
  ProcessoTriagemExtraido,
  ChunkingBlockInfo,
  TokenPreviewInfo,
  TokenWindowStatus,
} from "@/lib/types";

/**
 * Serviço de pré-processamento de PDF em camadas.
 *
 * Estratégia para evitar HTTP 400 (context window excedida) do Gemini ao
 * processar processos judiciais extensos (700+ páginas):
 *
 *   1. Extrai a CAMADA DE TEXTO do PDF (pdf-parse) — nunca o binário como
 *      multimodal, que consumiria muito mais tokens por página.
 *   2. LIMPA o texto de ruído repetido por página (timbre, "Assinado
 *      eletronicamente...", numeração de folha, cabeçalho/rodapé do
 *      tribunal) — em processos longos, esse ruído sozinho pode somar
 *      dezenas/centenas de milhares de tokens sem agregar nenhum dado de
 *      cálculo. Ver limparRuidoJudicial().
 *   3. Decide se precisa de chunking usando uma ESTIMATIVA POR CARACTERES
 *      primeiro (barata, sem chamada de API). Só chama a API real de
 *      contagem de tokens (countTokens) quando a estimativa já indica que o
 *      texto está confortavelmente dentro do limite — isto é o que corrige
 *      o bug original: antes, contávamos tokens do DOCUMENTO INTEIRO via
 *      API antes de decidir dividir, e essa própria chamada podia estourar
 *      em documentos muito longos.
 *   4. Se exceder o limite seguro, divide em blocos pequenos (200k–300k
 *      tokens cada, bem abaixo da janela de 1.048.576) e processa cada um
 *      sequencialmente (map), consolidando por código determinístico
 *      (reduce) — a IA nunca decide qual bloco "vale mais".
 *   5. Rede de segurança adicional: se mesmo assim um bloco individual for
 *      recusado pela API por excedimento de contexto, o próprio bloco é
 *      subdividido ao meio recursivamente e reprocessado — a extração só
 *      falha de vez se isso ainda não resolver após algumas tentativas.
 */

// Limite de contexto do Gemini 1.5 Pro é 1.048.576 tokens.
export const MODEL_CONTEXT_WINDOW = 1_048_576;

// Acima disto, ativa o modo de Análise por Camadas (chunking).
// Reduzido para dar mais margem de segurança em relação ao limite do modelo.
export const SAFE_CHUNKING_THRESHOLD = 450_000;

// Orçamento máximo de tokens por bloco/requisição no modo em camadas.
// Mantido na faixa de 200k-300k pedida: bem abaixo da janela do modelo,
// sobrando espaço de sobra para o system prompt, o schema e a resposta.
export const MAX_TOKENS_PER_BLOCK = 250_000;

// Estimativa conservadora de tokens por caractere para textos jurídicos em
// português (uso 3,5 em vez de 4 para SUPERestimar levemente — é mais seguro
// achar que o texto tem mais tokens do que menos, numa etapa de triagem
// barata que roda sem chamar a API).
const CHARS_POR_TOKEN_ESTIMADO = 3.5;

// Só chamamos a API real de contagem de tokens (countTokens) quando a
// estimativa por caracteres já indica um valor confortavelmente abaixo
// deste teto — evita que a PRÓPRIA chamada de contagem estoure em
// documentos muito longos (a causa raiz do bug original).
const TETO_SEGURO_PARA_CONTAGEM_REAL = 700_000;

// Menor tamanho de bloco (em caracteres) que ainda vale a pena subdividir
// recursivamente quando a API recusa por excedimento — abaixo disso,
// desistimos de subdividir e propagamos o erro.
const MIN_CHARS_PARA_SUBDIVIDIR = 20_000;
const MAX_PROFUNDIDADE_SUBDIVISAO = 4;

function estimarTokensPorCaracteres(texto: string): number {
  return Math.ceil(texto.length / CHARS_POR_TOKEN_ESTIMADO);
}

// ---------------------------------------------------------------------------
// Limpeza de ruído judicial (reduz tokens sem perder nenhum dado de cálculo)
// ---------------------------------------------------------------------------

const PADROES_RUIDO: RegExp[] = [
  // Blocos de assinatura eletrônica (aparecem em praticamente toda página de
  // PDF gerado por sistema de processo eletrônico brasileiro).
  /assinado (eletronicamente|digitalmente) por[^\n]*/gi,
  /documento assinado digitalmente conforme (a )?mp n?º?\s*2\.200-2\/2001[^\n]*/gi,
  /este documento (pode ser|foi) (assinado|verificado)[^\n]*/gi,
  /para conferir a autenticidade deste documento[^\n]*/gi,
  /código de verificação[:\s][^\n]*/gi,
  /assinatura eletrônica[:\s][^\n]*/gi,

  // Numeração de folha e paginação repetida.
  /\bfls?\.?\s*\d+\b/gi,
  /p[aá]gina\s+\d+\s+de\s+\d+/gi,

  // Timbres/cabeçalhos institucionais repetidos em cada página.
  /poder judici[aá]rio[^\n]*/gi,
  /tribunal de justiça d[eo][^\n]*/gi,
  /justiça federal[^\n]*(seção|subseção)[^\n]*/gi,

  // Sequências longas de caracteres alfanuméricos típicas de hash/token de
  // autenticação de documento (não carregam dado de cálculo).
  /\b[0-9a-f]{24,}\b/gi,
];

/**
 * Remove ruído repetitivo do texto de uma página — timbre, numeração de
 * folha, blocos de assinatura eletrônica — SEM tocar em nenhum valor
 * numérico, data ou nome que possa ser dado de cálculo. Isso é feito por
 * código determinístico (regex), nunca pela IA, então não há risco de
 * remover por engano algo relevante para o mérito.
 */
export function limparRuidoJudicial(textoPagina: string): string {
  let limpo = textoPagina;
  for (const padrao of PADROES_RUIDO) {
    limpo = limpo.replace(padrao, " ");
  }
  // Colapsa espaços múltiplos deixados pela remoção acima.
  return limpo.replace(/[ \t]{2,}/g, " ").trim();
}

const KEYWORD_LABELS: { rotulo: string; termos: string[] }[] = [
  {
    rotulo: "Petição Inicial / Cálculos Iniciais",
    termos: ["petição inicial", "exordial", "requer a procedência", "planilha de cálculo"],
  },
  {
    rotulo: "Contestação / Impugnação / Despachos",
    termos: ["contestação", "impugnação", "excesso de execução", "embargos à execução", "despacho"],
  },
  {
    rotulo: "Sentença / Decisão / Acórdão",
    termos: ["sentença", "dispositivo", "julgo procedente", "julgo improcedente", "acórdão", "voto do relator"],
  },
];

function rotularBloco(texto: string, indice: number): string {
  const textoLower = texto.toLowerCase();
  for (const { rotulo, termos } of KEYWORD_LABELS) {
    if (termos.some((t) => textoLower.includes(t))) return rotulo;
  }
  return `Trecho ${indice}`;
}

/**
 * Extrai o texto de cada página de um PDF usando pdf-parse e já aplica a
 * limpeza de ruído judicial página a página. Roda apenas no servidor (usa
 * Buffer/Node APIs).
 */
export async function extractPdfPagesText(pdfBuffer: Buffer): Promise<string[]> {
  // Import dinâmico: pdf-parse toca em APIs de Node que não devem entrar no
  // bundle de client components.
  const pdfParse = (await import("pdf-parse")).default;

  const pages: string[] = [];
  await pdfParse(pdfBuffer, {
    pagerender: (pageData: any) => {
      return pageData.getTextContent().then((textContent: any) => {
        const textoBruto = textContent.items.map((item: any) => item.str).join(" ");
        pages.push(limparRuidoJudicial(textoBruto));
        return textoBruto;
      });
    },
  });

  return pages;
}

/** Conta tokens reais via API do Gemini. Só deve ser chamada sobre textos já
 *  sabidamente pequenos o bastante (ver TETO_SEGURO_PARA_CONTAGEM_REAL) —
 *  chamar isso sobre um documento inteiro de 700+ páginas é o que causava o
 *  estouro original, antes mesmo de qualquer chunking acontecer. */
export async function countTokensGemini(text: string): Promise<number> {
  const ai = getGeminiClient();
  const result = await ai.models.countTokens({
    model: MODELS.PRO,
    contents: [{ role: "user", parts: [{ text }] }],
  });
  return result.totalTokens ?? 0;
}

function statusFromPercentual(pct: number): TokenWindowStatus {
  if (pct >= 90) return "critico";
  if (pct >= 60) return "atencao";
  return "ok";
}

/**
 * Monta a prévia de consumo de tokens exibida no upload, antes de qualquer
 * chamada de extração.
 *
 * CORREÇÃO DO BUG PRINCIPAL: em vez de sempre chamar a API real de contagem
 * de tokens sobre o texto INTEIRO (o que podia, por si só, estourar em
 * processos de 700+ páginas), agora:
 *   1. Estima tokens por caracteres primeiro — instantâneo, sem chamada de API.
 *   2. Só chama a API real de contagem se a estimativa já indicar que o
 *      texto está confortavelmente abaixo de um teto seguro. Caso contrário,
 *      usa a própria estimativa (marcada como `estimado: true`) e já
 *      encaminha para o modo de chunking, sem arriscar uma chamada de API
 *      fadada a falhar.
 */
export async function buildTokenPreview(
  pages: string[]
): Promise<{ preview: TokenPreviewInfo; fullText: string }> {
  const fullText = pages.join("\n\n");
  const tokensEstimados = estimarTokensPorCaracteres(fullText);

  let totalTokens = tokensEstimados;
  let estimado = true;

  if (tokensEstimados <= TETO_SEGURO_PARA_CONTAGEM_REAL) {
    try {
      totalTokens = await countTokensGemini(fullText);
      estimado = false;
    } catch {
      // Se mesmo assim a contagem real falhar por qualquer motivo, seguimos
      // com a estimativa por caracteres em vez de derrubar o fluxo inteiro.
      totalTokens = tokensEstimados;
      estimado = true;
    }
  }

  const percentualOcupado = Math.round((totalTokens / MODEL_CONTEXT_WINDOW) * 1000) / 10;

  const preview: TokenPreviewInfo = {
    totalTokens,
    modelLimit: MODEL_CONTEXT_WINDOW,
    percentualOcupado,
    status: statusFromPercentual(percentualOcupado),
    exigeChunking: totalTokens > SAFE_CHUNKING_THRESHOLD,
    totalPaginas: pages.length,
    estimado,
  };

  return { preview, fullText };
}

/**
 * Divide as páginas em blocos respeitando o orçamento de tokens por bloco
 * (MAX_TOKENS_PER_BLOCK, 200k-300k). Usa estimativa por caracteres — barata
 * e suficiente aqui, já que o objetivo é só garantir que cada bloco fique
 * bem abaixo do limite do modelo, não medir com precisão cirúrgica.
 */
function splitPagesIntoBlocks(pages: string[]): { texto: string; paginaInicial: number; paginaFinal: number }[] {
  const maxCharsPorBloco = MAX_TOKENS_PER_BLOCK * CHARS_POR_TOKEN_ESTIMADO;

  const blocos: { texto: string; paginaInicial: number; paginaFinal: number }[] = [];
  let bufferTexto = "";
  let paginaInicial = 1;

  pages.forEach((paginaTexto, idx) => {
    const numeroPagina = idx + 1;
    if (bufferTexto.length + paginaTexto.length > maxCharsPorBloco && bufferTexto.length > 0) {
      blocos.push({ texto: bufferTexto, paginaInicial, paginaFinal: numeroPagina - 1 });
      bufferTexto = "";
      paginaInicial = numeroPagina;
    }
    bufferTexto += (bufferTexto ? "\n\n" : "") + paginaTexto;
  });

  if (bufferTexto.length > 0) {
    blocos.push({ texto: bufferTexto, paginaInicial, paginaFinal: pages.length });
  }

  return blocos;
}

/** Roda a extração de um único bloco de texto (map) — uma chamada de API. */
async function extractBloco(
  textoBloco: string,
  blocoIndex: number,
  totalBlocos: number
): Promise<ProcessoTriagemExtraido> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: MODELS.PRO,
    contents: [
      { role: "user", parts: [{ text: buildTriagemBlocoPrompt(textoBloco, blocoIndex, totalBlocos) }] },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION_TRIAGEM,
      responseMimeType: "application/json",
      responseSchema: TRIAGEM_RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  return JSON.parse(response.text ?? "{}") as ProcessoTriagemExtraido;
}

/**
 * Mescla duas (ou mais) extrações parciais em uma só, pela mesma regra
 * determinística usada na consolidação final (primeiro valor não-nulo
 * vence, arrays são concatenados). Usada tanto no reduce final quanto na
 * rede de segurança de subdivisão recursiva abaixo.
 */
function mesclarExtracoesParciais(parciais: ProcessoTriagemExtraido[]): ProcessoTriagemExtraido {
  const primeiroNaoNulo = <T,>(vals: (T | null)[]): T | null =>
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
      autor: parciais.flatMap((p) => p.quesitos?.autor ?? []),
      juiz: parciais.flatMap((p) => p.quesitos?.juiz ?? []),
      reu: parciais.flatMap((p) => p.quesitos?.reu ?? []),
    },
    observacoes_para_conferencia_humana: parciais.flatMap(
      (p) => p.observacoes_para_conferencia_humana ?? []
    ),
  };
}

/**
 * Rede de segurança: tenta extrair um bloco normalmente; se a API recusar
 * por excedimento de contexto (o que não deveria acontecer com blocos de
 * 200k-300k tokens, mas pode ocorrer em casos extremos — ex.: uma tabela
 * densíssima que o pdf-parse extraiu de forma anormalmente longa), o bloco
 * é cortado ao meio (numa quebra de linha, para não partir uma frase) e
 * cada metade é tentada recursivamente. Isso torna o chunking auto-resiliente
 * em vez de simplesmente propagar o erro 400 para o usuário.
 */
async function extractBlocoComRedeDeSeguranca(
  textoBloco: string,
  blocoIndex: number,
  totalBlocos: number,
  profundidade: number = 0
): Promise<ProcessoTriagemExtraido> {
  try {
    return await extractBloco(textoBloco, blocoIndex, totalBlocos);
  } catch (err) {
    const podeSubdividir =
      isTokenLimitError(err) &&
      textoBloco.length > MIN_CHARS_PARA_SUBDIVIDIR &&
      profundidade < MAX_PROFUNDIDADE_SUBDIVISAO;

    if (!podeSubdividir) throw err;

    const meio = Math.floor(textoBloco.length / 2);
    const pontoDeCorte = textoBloco.lastIndexOf("\n", meio);
    const corte = pontoDeCorte > 0 ? pontoDeCorte : meio;

    const parteA = textoBloco.slice(0, corte);
    const parteB = textoBloco.slice(corte);

    const [resultadoA, resultadoB] = [
      await extractBlocoComRedeDeSeguranca(parteA, blocoIndex, totalBlocos, profundidade + 1),
      await extractBlocoComRedeDeSeguranca(parteB, blocoIndex, totalBlocos, profundidade + 1),
    ];

    return mesclarExtracoesParciais([resultadoA, resultadoB]);
  }
}

/**
 * Orquestra o fluxo completo de map-reduce para um processo extenso:
 * divide em blocos por orçamento de tokens, extrai cada bloco em sequência
 * (encadeado, para não estourar rate limit, e com rede de segurança
 * individual por bloco) e consolida o resultado final.
 */
export async function processarProcessoEmCamadas(
  pages: string[],
  onProgress?: (blocoAtual: number, totalBlocos: number, rotulo: string) => void
): Promise<ProcessoTriagemExtraido> {
  const blocosBrutos = splitPagesIntoBlocks(pages);
  const totalBlocos = blocosBrutos.length;

  const blocosInfo: ChunkingBlockInfo[] = [];
  const parciais: ProcessoTriagemExtraido[] = [];

  // Processamento encadeado (não paralelo): cada bloco é processado até o
  // fim antes do próximo começar, tanto para respeitar rate limit da API
  // quanto porque a rede de segurança acima pode gerar chamadas extras
  // (subdivisão) que não queremos disparar todas em paralelo.
  for (let i = 0; i < blocosBrutos.length; i++) {
    const bloco = blocosBrutos[i];
    const rotulo = rotularBloco(bloco.texto, i + 1);
    onProgress?.(i + 1, totalBlocos, rotulo);

    blocosInfo.push({
      indice: i + 1,
      rotulo,
      paginaInicial: bloco.paginaInicial,
      paginaFinal: bloco.paginaFinal,
      tokensEstimados: estimarTokensPorCaracteres(bloco.texto),
    });

    const parcial = await extractBlocoComRedeDeSeguranca(bloco.texto, i + 1, totalBlocos);
    parciais.push(parcial);
  }

  const consolidado = mesclarExtracoesParciais(parciais);

  return {
    ...consolidado,
    observacoes_para_conferencia_humana: [
      `Documento processado em modo de Análise por Camadas (${blocosInfo.length} blocos) — revise os campos abaixo com atenção redobrada, pois foram consolidados a partir de trechos processados separadamente.`,
      ...consolidado.observacoes_para_conferencia_humana,
    ],
    _chunking_info: {
      chunked: true,
      totalBlocos: blocosInfo.length,
      blocos: blocosInfo,
    },
  };
}

/** Detecta se um erro retornado pela API do Gemini é de excedimento de tokens/contexto. */
export function isTokenLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes("400") ||
    lower.includes("invalid_argument") ||
    (lower.includes("token") && (lower.includes("limit") || lower.includes("exceed") || lower.includes("context")))
  );
}
