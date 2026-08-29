import { getGeminiClient, MODELS } from "@/lib/gemini/client";
import {
  SYSTEM_INSTRUCTION_TRIAGEM,
  buildTriagemBlocoPrompt,
  TRIAGEM_RESPONSE_SCHEMA,
} from "@/lib/gemini/prompts";
import type {
  ProcessoTriagemExtraido,
  ChunkingBlockInfo,
  ChunkingInfo,
  TokenPreviewInfo,
  TokenWindowStatus,
} from "@/lib/types";

/**
 * Serviço de pré-processamento de PDF em camadas.
 *
 * Estratégia adotada para evitar HTTP 400 (context window excedida) do Gemini
 * ao enviar processos judiciais extensos:
 *   1. Extrai primeiro a CAMADA DE TEXTO do PDF (pdf-parse), em vez de mandar
 *      o binário como multimodal — texto puro consome uma fração dos tokens
 *      que a mesma página enviada como imagem consumiria.
 *   2. Conta os tokens reais via API do Gemini (countTokens) sobre esse texto.
 *   3. Se ultrapassar o limite seguro, divide o texto em blocos por orçamento
 *      de tokens (mantendo a ordem das páginas) e roda extração página-a-bloco
 *      (map), depois consolida tudo por código determinístico (reduce) — a
 *      IA nunca decide sozinha qual bloco "vale mais", apenas extrai por parte.
 */

// Limite de contexto do Gemini 1.5 Pro é 1.048.576 tokens; mantemos uma
// margem de segurança generosa para overhead do system prompt + schema.
export const MODEL_CONTEXT_WINDOW = 1_048_576;
export const SAFE_CHUNKING_THRESHOLD = 600_000; // acima disso, ativa chunking
export const MAX_TOKENS_PER_BLOCK = 180_000; // orçamento por bloco no modo camadas

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
 * Extrai o texto de cada página de um PDF usando pdf-parse. Roda apenas no
 * servidor (usa Buffer/Node APIs).
 */
export async function extractPdfPagesText(pdfBuffer: Buffer): Promise<string[]> {
  // Import dinâmico: pdf-parse toca em APIs de Node que não devem entrar no
  // bundle de client components.
  const pdfParse = (await import("pdf-parse")).default;

  const pages: string[] = [];
  await pdfParse(pdfBuffer, {
    pagerender: (pageData: any) => {
      return pageData.getTextContent().then((textContent: any) => {
        const text = textContent.items.map((item: any) => item.str).join(" ");
        pages.push(text);
        return text;
      });
    },
  });

  return pages;
}

/** Conta tokens reais via API do Gemini (mais preciso que estimar por caracteres). */
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

/** Monta a prévia de consumo de tokens exibida no upload, antes de qualquer chamada de extração. */
export async function buildTokenPreview(
  pages: string[]
): Promise<{ preview: TokenPreviewInfo; fullText: string }> {
  const fullText = pages.join("\n\n");
  const totalTokens = await countTokensGemini(fullText);
  const percentualOcupado = Math.round((totalTokens / MODEL_CONTEXT_WINDOW) * 1000) / 10;

  const preview: TokenPreviewInfo = {
    totalTokens,
    modelLimit: MODEL_CONTEXT_WINDOW,
    percentualOcupado,
    status: statusFromPercentual(percentualOcupado),
    exigeChunking: totalTokens > SAFE_CHUNKING_THRESHOLD,
    totalPaginas: pages.length,
  };

  return { preview, fullText };
}

/**
 * Divide as páginas em blocos respeitando um orçamento de tokens por bloco
 * (estimativa rápida por caracteres para não gastar uma chamada countTokens
 * por página; a contagem real é feita só quando necessário).
 */
function splitPagesIntoBlocks(pages: string[]): { texto: string; paginaInicial: number; paginaFinal: number }[] {
  const CHARS_POR_TOKEN_ESTIMADO = 4;
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

/**
 * Roda a extração de um único bloco de texto (map). Reaproveita o mesmo
 * schema estruturado da triagem normal, mas com um prompt que avisa a IA de
 * que está vendo apenas uma FATIA do processo.
 */
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
 * Reduce determinístico: combina os resultados parciais de cada bloco em uma
 * única extração consolidada. A escolha de qual bloco "vence" um campo é
 * regra de código (primeiro valor não-nulo encontrado, na ordem dos blocos),
 * nunca decidida pela IA — mantém o sistema auditável.
 */
function reduzirExtracoesParciais(
  parciais: ProcessoTriagemExtraido[],
  blocosInfo: ChunkingBlockInfo[]
): ProcessoTriagemExtraido {
  const primeiroNaoNulo = <T,>(vals: (T | null)[]): T | null =>
    vals.find((v) => v !== null && v !== undefined) ?? null;

  const consolidado: ProcessoTriagemExtraido = {
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
    observacoes_para_conferencia_humana: [
      `Documento processado em modo de Análise por Camadas (${blocosInfo.length} blocos) — revise os campos abaixo com atenção redobrada, pois foram consolidados a partir de trechos processados separadamente.`,
      ...parciais.flatMap((p) => p.observacoes_para_conferencia_humana ?? []),
    ],
    _chunking_info: {
      chunked: true,
      totalBlocos: blocosInfo.length,
      blocos: blocosInfo,
    },
  };

  return consolidado;
}

/**
 * Orquestra o fluxo completo de map-reduce para um processo extenso:
 * divide em blocos por orçamento de tokens, extrai cada bloco em sequência
 * (encadeado, para não estourar rate limit) e consolida o resultado final.
 */
export async function processarProcessoEmCamadas(
  pages: string[],
  onProgress?: (blocoAtual: number, totalBlocos: number, rotulo: string) => void
): Promise<ProcessoTriagemExtraido> {
  const blocosBrutos = splitPagesIntoBlocks(pages);
  const totalBlocos = blocosBrutos.length;

  const blocosInfo: ChunkingBlockInfo[] = [];
  const parciais: ProcessoTriagemExtraido[] = [];

  // Processamento encadeado (não paralelo) — cada bloco depende da conclusão
  // do anterior apenas para respeitar rate limit da API; a extração em si é
  // independente por bloco (não é um "chat" com memória entre chamadas).
  for (let i = 0; i < blocosBrutos.length; i++) {
    const bloco = blocosBrutos[i];
    const rotulo = rotularBloco(bloco.texto, i + 1);
    onProgress?.(i + 1, totalBlocos, rotulo);

    const tokensEstimados = Math.round(bloco.texto.length / 4);
    blocosInfo.push({
      indice: i + 1,
      rotulo,
      paginaInicial: bloco.paginaInicial,
      paginaFinal: bloco.paginaFinal,
      tokensEstimados,
    });

    const parcial = await extractBloco(bloco.texto, i + 1, totalBlocos);
    parciais.push(parcial);
  }

  return reduzirExtracoesParciais(parciais, blocosInfo);
}

/** Detecta se um erro retornado pela API do Gemini é de excedimento de tokens/contexto. */
export function isTokenLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes("400") ||
    lower.includes("invalid_argument") ||
    lower.includes("token") && (lower.includes("limit") || lower.includes("exceed") || lower.includes("context"))
  );
}
