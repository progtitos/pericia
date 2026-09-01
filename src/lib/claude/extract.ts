// src/lib/claude/extract.ts
//
// Substitui src/lib/gemini/extract.ts. Migração de Gemini para Claude
// (Anthropic), usando Tool Use para garantir saída JSON estritamente
// tipada — sem depender de "responseMimeType" nem de parsear texto livre.
//
// HISTÓRICO DE MODELO: este módulo foi escrito originalmente para
// claude-3-5-sonnet-20241022 (janela de 200.000 tokens), mas esse snapshot
// foi DESATIVADO pela Anthropic em 28/10/2025 (chamadas passaram a retornar
// 404 not_found_error). Migrado para claude-sonnet-5 (ver client.ts), cuja
// janela real é de 1.000.000 de tokens — MAIOR que a do Gemini usado antes.
// Os limiares de fatiamento abaixo foram recalculados para essa janela
// maior, mas o fatiamento em si foi mantido como rede de segurança: nenhuma
// janela é grande o bastante para justificar removê-lo por completo, ainda
// mais considerando que trocar de modelo no futuro pode mudar esse número
// de novo (e provavelmente vai).

import type Anthropic from "@anthropic-ai/sdk";
import { getClaudeClient, MODEL_NAME } from "@/lib/claude/client";
import type { ProcessoTriagemExtraido } from "@/lib/types";

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

export const SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK = 15;

// NOTA SOBRE JANELA DE CONTEXTO (histórico): quando este módulo foi escrito,
// o modelo em uso (claude-3-5-sonnet-20241022, hoje desativado) tinha janela
// de 200.000 tokens, MENOR que a do Gemini usado antes — por isso o
// fatiamento abaixo foi criado com um orçamento conservador por bloco.
// Atualizado para claude-sonnet-5, cuja janela real é de 1.000.000 de
// tokens (com até 128K de saída) — MAIOR que a do Gemini. Na prática, a
// grande maioria dos processos (mesmo os de 700+ páginas testados neste
// projeto, ~430.000 tokens) agora cabe numa única chamada. O fatiamento
// abaixo é mantido como rede de segurança para os poucos casos que ainda
// excedem esse orçamento — nunca é bom eliminar essa rede por completo,
// só porque a janela ficou maior.
//
// Orçamento seguro para caber numa ÚNICA chamada: ~2.800.000 caracteres.
// Estimativa por caracteres usa 3,5 chars/token (conservador) — a Anthropic
// documenta que o tokenizer do Sonnet 5 produz cerca de 30% mais tokens que
// o do Sonnet 4.6 para o mesmo texto, então preferimos superestimar o
// consumo a subestimar. ~2.800.000 chars ≈ 800.000 tokens estimados, com
// margem confortável dentro do 1.000.000 de tokens da janela para o prompt
// do sistema, o schema da tool e os tokens de saída.
const MAX_CHARS_SINGLE_SHOT = 2_800_000;
const MAX_CHARS_POR_BLOCO = MAX_CHARS_SINGLE_SHOT;

// Pausa leve entre blocos — não é para contornar instabilidade de free tier
// (a Anthropic não tem isso), é só uma cortesia para não rajar o rate limit
// por tokens/minuto da sua organização.
const DELAY_ENTRE_BLOCOS_MS = 800;

const MAX_TENTATIVAS = 3;
const BACKOFF_BASE_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Erros transitórios reais da API da Anthropic: rate limit (429), erro
 *  interno (500) e sobrecarga (529 — "overloaded_error", específico da
 *  Anthropic, equivalente ao 503 do Gemini). NÃO inclui 413 (request_too_large)
 *  — payload grande demais não se resolve tentando de novo, se resolve
 *  fatiando menor (ver extrairBlocoComRedeDeSeguranca). */
function isErroTransitorio(err: unknown): boolean {
  const status = (err as any)?.status;
  if ([429, 500, 529].includes(status)) return true;

  const msg = err instanceof Error ? err.message : String(err);
  return /rate_limit|overloaded|internal_server_error|429|500|529/i.test(msg);
}

function isPayloadGrandeDemais(err: unknown): boolean {
  const status = (err as any)?.status;
  const msg = err instanceof Error ? err.message : String(err);
  return status === 413 || /request_too_large|prompt is too long|maximum context length/i.test(msg);
}

/** Mensagem amigável em português — nunca expõe stack trace de SDK na tela. */
export function humanizarErroClaude(err: unknown): string {
  const status = (err as any)?.status;
  const msg = err instanceof Error ? err.message : String(err);

  if (status === 529 || /overloaded/i.test(msg)) {
    return "A Anthropic (Claude) está temporariamente sobrecarregada. Tente novamente em alguns segundos.";
  }
  if (status === 429 || /rate_limit/i.test(msg)) {
    return "Limite de requisições por minuto atingido na API da Anthropic. Aguarde um instante e tente novamente.";
  }
  if (status === 401 || /authentication|invalid x-api-key/i.test(msg)) {
    return "Falha de autenticação com a API da Anthropic. Verifique a variável ANTHROPIC_API_KEY no servidor.";
  }
  if (isPayloadGrandeDemais(err)) {
    return "Este trecho do processo é maior do que a janela de contexto do Claude suporta numa única chamada. O sistema tentará dividir automaticamente em partes menores.";
  }
  return msg;
}

/** Retry com backoff exponencial para erros transitórios. Propaga na hora
 *  qualquer erro não-transitório (ex.: chave inválida, payload grande demais
 *  — esse último é tratado por subdivisão, não por retry). */
export async function comRetry<T>(fn: () => Promise<T>, contexto: string): Promise<T> {
  let ultimoErro: unknown;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      return await fn();
    } catch (err) {
      ultimoErro = err;
      if (!isErroTransitorio(err) || tentativa === MAX_TENTATIVAS) throw err;

      const espera = BACKOFF_BASE_MS * 2 ** (tentativa - 1) + Math.floor(Math.random() * 500);
      console.warn(
        `[Claude] ${contexto}: erro transitório na tentativa ${tentativa}/${MAX_TENTATIVAS}, ` +
          `tentando de novo em ${espera}ms. Motivo: ${(err as Error)?.message ?? err}`
      );
      await delay(espera);
    }
  }

  throw ultimoErro;
}

// ---------------------------------------------------------------------------
// Tool Use (Structured Outputs) — garante retorno estritamente no formato de
// ProcessoTriagemExtraido, sem depender de parsear texto livre como JSON.
// ---------------------------------------------------------------------------

const NOME_DA_TOOL = "extrair_dados_processo";

const EXTRACTION_TOOL = {
  name: NOME_DA_TOOL,
  description:
    "Registra os dados estruturados de triagem extraídos de um processo judicial. " +
    "Chame esta ferramenta exatamente uma vez, com os campos que você conseguiu " +
    "localizar literalmente no texto. NUNCA inclua um campo cujo valor você esteja " +
    "estimando ou adivinhando — se não encontrar o dado no texto, simplesmente " +
    "omita essa propriedade (não invente, não use string vazia).",
  input_schema: {
    type: "object" as const,
    properties: {
      numero_processo: { type: "string", description: "Número do processo (CNJ), se encontrado." },
      vara: { type: "string", description: "Vara/juízo responsável." },
      autor: { type: "string", description: "Nome do autor/exequente." },
      reu: { type: "string", description: "Nome do réu/executado." },
      dib: { type: "string", description: "Data de Início do Benefício, formato DD/MM/AAAA." },
      der: { type: "string", description: "Data de Entrada do Requerimento, formato DD/MM/AAAA." },
      rmi: { type: "number", description: "Renda Mensal Inicial, valor numérico em reais." },
      indice_determinado_pelo_juiz: { type: "string", description: "Índice de correção determinado na decisão (ex.: IPCA-E)." },
      data_citacao: { type: "string", description: "Data da citação, formato DD/MM/AAAA." },
      sistema_amortizacao: {
        type: "string",
        enum: ["PRICE", "SAC", "NAO_IDENTIFICADO"],
        description: "Sistema de amortização do contrato, quando aplicável.",
      },
      taxa_juros_contratada_am: { type: "number", description: "Taxa de juros contratada, ao mês, em percentual." },
      observacoes_para_conferencia_humana: {
        type: "array",
        items: { type: "string" },
        description: "Pontos ambíguos, ilegíveis ou de baixa confiança que exigem revisão humana.",
      },
      quesitos: {
        type: "object",
        properties: {
          autor: { type: "array", items: { type: "string" } },
          juiz: { type: "array", items: { type: "string" } },
          reu: { type: "array", items: { type: "string" } },
        },
        description: "Quesitos formulados por cada parte, transcritos fielmente.",
      },
    },
    // Nenhum campo é obrigatório: um campo ausente do texto deve resultar em
    // propriedade OMITIDA na chamada da tool, nunca num valor inventado.
  },
};

function buildSystemPrompt(): string {
  return `
Você é um assistente pericial especializado em triagem de processos judiciais brasileiros.
Extraia estritamente os dados literalmente presentes no texto fornecido, usando a ferramenta
"${NOME_DA_TOOL}".

Regras inegociáveis:
- Extraia apenas o que está literalmente no texto. Nunca estime, nunca infira, nunca complete
  com conhecimento geral.
- Se um dado não estiver no texto, OMITA a propriedade correspondente na chamada da ferramenta
  — não a preencha com null, string vazia ou um "melhor palpite".
- Datas devem ser transcritas no formato DD/MM/AAAA exatamente como aparecem (ou o mais próximo
  disso que o texto permitir).
- Quesitos devem ser transcritos fielmente, sem parafrasear o mérito.
- Preencha "observacoes_para_conferencia_humana" sempre que houver ambiguidade, trecho cortado,
  texto ilegível ou dúvida razoável sobre um valor.
- O texto pode conter marcadores no formato [[FLS. N]] indicando o início de cada folha do
  processo — eles NÃO são conteúdo do processo, nunca os copie para nenhum campo.
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

function buildMensagemUsuario(texto: string, blocoInfo?: { indice: number; total: number }): string {
  const contextoBloco = blocoInfo
    ? `Este é o BLOCO ${blocoInfo.indice} de ${blocoInfo.total} de um processo extenso (um trecho, não ` +
      `o documento inteiro). Se um campo não aparecer neste trecho, simplesmente omita a propriedade — ` +
      `pode estar em outro bloco; a consolidação final é feita automaticamente por outro processo.\n\n`
    : "";

  return `${contextoBloco}Texto do processo:\n${texto}`;
}

/** Extrai um único bloco/documento via Tool Use. Se a Anthropic recusar por
 *  payload grande demais (413), subdivide o bloco ao meio e tenta de novo
 *  recursivamente, em vez de simplesmente falhar — rede de segurança para
 *  quando a estimativa por caracteres subestimar o tamanho real em tokens. */
async function extrairBlocoComRedeDeSeguranca(
  texto: string,
  blocoInfo?: { indice: number; total: number },
  profundidade = 0
): Promise<ProcessoTriagemExtraido> {
  const client = getClaudeClient();
  const contexto = blocoInfo ? `bloco ${blocoInfo.indice}/${blocoInfo.total}` : "documento único";

  try {
    const resposta = await comRetry(
      () =>
        client.messages.create({
          model: MODEL_NAME,
          max_tokens: 4096,
          system: buildSystemPrompt(),
          tools: [EXTRACTION_TOOL as any],
          tool_choice: { type: "tool", name: NOME_DA_TOOL },
          messages: [{ role: "user", content: buildMensagemUsuario(texto, blocoInfo) }],
        }),
      contexto
    );

    const toolUseBlock = resposta.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (!toolUseBlock) {
      throw new Error("O Claude não retornou uma chamada de ferramenta válida.");
    }

    return normalizarResultado(toolUseBlock.input);
  } catch (err) {
    const MIN_CHARS_PARA_SUBDIVIDIR = 20_000;
    const MAX_PROFUNDIDADE = 4;

    if (
      isPayloadGrandeDemais(err) &&
      texto.length > MIN_CHARS_PARA_SUBDIVIDIR &&
      profundidade < MAX_PROFUNDIDADE
    ) {
      const meio = Math.floor(texto.length / 2);
      const corte = texto.lastIndexOf("\n", meio) > 0 ? texto.lastIndexOf("\n", meio) : meio;

      const [a, b] = await Promise.all([
        extrairBlocoComRedeDeSeguranca(texto.slice(0, corte), blocoInfo, profundidade + 1),
        extrairBlocoComRedeDeSeguranca(texto.slice(corte), blocoInfo, profundidade + 1),
      ]);
      return mesclarParciais([a, b]);
    }

    throw err;
  }
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

/** Mescla extrações parciais de vários blocos: primeiro valor não-nulo
 *  vence, arrays são concatenados. Código determinístico — nunca uma
 *  chamada extra à IA — para não introduzir mais uma requisição sujeita a
 *  rate limit/sobrecarga só para "juntar" o que já foi extraído. */
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

/**
 * Processa o texto completo do processo:
 *  - Se couber no orçamento de uma única chamada (~480.000 caracteres, bem
 *    dentro da janela real de 200.000 tokens do Claude), faz UMA chamada —
 *    caminho rápido, onde cai a grande maioria dos processos.
 *  - Se for mais extenso, divide em blocos e processa sequencialmente,
 *    consolidando por código determinístico ao final.
 *  - Nunca corta/descarta parte do texto: documentos grandes são divididos,
 *    não truncados.
 */
export async function processarTextoProcesso(
  texto: string,
  caseId?: string,
  onProgress?: (info: ProgressoProcessamento) => void
): Promise<ProcessoTriagemExtraido> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("A chave ANTHROPIC_API_KEY não está configurada.");
  }

  const blocos = dividirEmBlocos(texto);
  const totalBlocos = blocos.length;

  if (totalBlocos === 1) {
    onProgress?.({ progresso: 50, etapa: "Analisando o processo com o Claude...", total_blocos: 1, blocos_concluidos: 0 });
    const resultado = await extrairBlocoComRedeDeSeguranca(blocos[0]);
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

    const parcial = await extrairBlocoComRedeDeSeguranca(blocos[i], { indice: i + 1, total: totalBlocos });
    parciais.push(parcial);

    if (i < blocos.length - 1) await delay(DELAY_ENTRE_BLOCOS_MS);
  }

  onProgress?.({
    progresso: 100,
    etapa: "Consolidando resultado final...",
    total_blocos: totalBlocos,
    blocos_concluidos: totalBlocos,
    status: "done",
  });

  const consolidado = mesclarParciais(parciais);
  return {
    ...consolidado,
    observacoes_para_conferencia_humana: [
      `Documento extenso (${totalBlocos} blocos) — revise os campos abaixo com atenção redobrada.`,
      ...consolidado.observacoes_para_conferencia_humana,
    ],
  };
}

// Mantido como stub — a extração de extrato bancário ainda não foi
// implementada nesta migração (já era um stub no módulo Gemini anterior).
// A rota /api/claude/extract-extrato também já tem uma inconsistência
// pré-existente (espera documentId, mas o client hoje envia texto) que não
// faz parte do escopo desta migração de provedor de IA.
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
