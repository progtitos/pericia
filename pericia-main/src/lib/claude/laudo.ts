// src/lib/claude/laudo.ts
//
// Geração da minuta do laudo pericial via Claude (Anthropic). Substitui
// src/lib/gemini/laudo.ts. Mesmas duas restrições rígidas de antes:
//   1. Todo valor numérico do laudo DEVE vir de `resultadoCalculo`, gerado
//      por código determinístico (src/lib/calc/previdenciario.ts).
//   2. Toda citação a um fato/decisão do processo DEVE indicar a folha exata
//      (fls. N), localizada a partir dos marcadores [[FLS. N]]. Se não
//      conseguir localizar, deve dizer isso em vez de inventar um número.

import { getClaudeClient, MODEL_NAME, MAX_OUTPUT_TOKENS } from "@/lib/claude/client";
import { comRetry, humanizarErroClaude } from "@/lib/claude/extract";
import type { ProcessoTriagemExtraido } from "@/lib/types";

export { humanizarErroClaude };

// HISTÓRICO: este limite era 400.000 caracteres quando o modelo em uso
// tinha janela de 200.000 tokens (claude-3-5-sonnet-20241022, desativado em
// 28/10/2025 — ver client.ts). Com claude-sonnet-5 (janela de 1.000.000 de
// tokens), a mesma lógica de "recorte no meio, preservando início e fim" é
// mantida como rede de segurança, mas o orçamento sobe bastante: a grande
// maioria dos processos agora entra inteiro, com o texto completo disponível
// para citação de fls., em vez de só o começo e o fim.
const MAX_CHARS_TEXTO_PROCESSO_NO_PROMPT = 2_800_000;

interface QuesitoAprovado {
  author: string;
  question_text: string;
}

export interface GerarLaudoParams {
  processoTriagem: ProcessoTriagemExtraido | Record<string, unknown> | null;
  resultadoCalculo: unknown;
  quesitosAprovados: QuesitoAprovado[];
  textoPaginado?: string | null;
}

function recortarTextoParaPrompt(texto: string): { recorte: string; foiRecortado: boolean } {
  if (texto.length <= MAX_CHARS_TEXTO_PROCESSO_NO_PROMPT) {
    return { recorte: texto, foiRecortado: false };
  }

  const metade = Math.floor(MAX_CHARS_TEXTO_PROCESSO_NO_PROMPT / 2);
  const inicio = texto.slice(0, metade);
  const fim = texto.slice(texto.length - metade);

  return {
    recorte: `${inicio}\n\n[...TRECHO INTERMEDIÁRIO OMITIDO POR LIMITE DE TAMANHO...]\n\n${fim}`,
    foiRecortado: true,
  };
}

function buildSystemPrompt(): string {
  return `
Você é um perito judicial redigindo uma MINUTA de laudo pericial em conformidade com o CPC
brasileiro. Escreva em português formal técnico-jurídico, neutro, sem adjetivação favorável
a qualquer parte.
`.trim();
}

function buildLaudoPrompt(params: GerarLaudoParams): string {
  const textoInfo = params.textoPaginado ? recortarTextoParaPrompt(params.textoPaginado) : null;

  const avisoRecorte = textoInfo?.foiRecortado
    ? "O texto abaixo foi parcialmente omitido no meio por limite de tamanho (processo muito extenso); se precisar citar algo que pareça estar no trecho omitido, diga isso explicitamente em vez de adivinhar a folha."
    : "";

  const avisoSemTexto = !params.textoPaginado
    ? "ATENÇÃO: o texto do processo não foi fornecido nesta chamada. NÃO cite nenhuma folha — em vez disso, registre na conclusão que a minuta foi gerada sem acesso ao texto integral do processo, apenas aos dados já estruturados."
    : "";

  return `
REGRAS INEGOCIÁVEIS:

1. CITAÇÃO DE FOLHAS (fls.): o texto do processo abaixo contém marcadores no formato
   [[FLS. N]] indicando o início de cada página/folha. Sempre que você mencionar uma
   decisão, um fato ou um documento constante dos autos, cite a folha exata a partir do
   marcador mais próximo, no formato "fls. N" (ex.: "Conforme decisão de fls. 142...").
   NUNCA invente um número de folha. Se não conseguir localizar com segurança a folha de
   onde tirou uma informação, escreva "(folha não identificada)" em vez de um número —
   isso é preferível a uma citação incorreta.
   ${avisoRecorte}
   ${avisoSemTexto}

2. NÚMEROS: todos os valores numéricos do laudo (tabela demonstrativa, valor líquido
   final, honorários) DEVEM vir exatamente do objeto "resultadoCalculo" abaixo. Nunca
   calcule, arredonde de forma diferente, ou "estime" um número que não esteja lá.

3. Se um dado necessário para responder a um quesito não estiver disponível, responda de
   forma técnica e neutra que "o documento/dado X não foi disponibilizado nos autos para
   esta análise", em vez de inventar uma resposta.

4. Estrutura obrigatória da minuta (Markdown):
   ## 1. Identificação das Partes e Juízo
   ## 2. Histórico Processual (com citação de fls. sempre que aplicável)
   ## 3. Análise Técnica e Memória de Cálculo
   ## 4. Respostas aos Quesitos (com citação de fls. quando fundamentar em documento dos autos)
   ## 5. Conclusão
   ## 6. Tabela Demonstrativa Final

DADOS DA TRIAGEM PROCESSUAL:
${JSON.stringify(params.processoTriagem, null, 2)}

RESULTADO DO CÁLCULO (fonte única da verdade para números):
${JSON.stringify(params.resultadoCalculo, null, 2)}

QUESITOS APROVADOS PARA RESPOSTA:
${JSON.stringify(params.quesitosAprovados, null, 2)}

${textoInfo ? `TEXTO DO PROCESSO (com marcadores de folha [[FLS. N]]):\n"""\n${textoInfo.recorte}\n"""` : ""}

Redija a minuta agora.
`.trim();
}

/** Gera a minuta do laudo pericial (texto Markdown) via Claude. */
export async function gerarLaudoPericial(params: GerarLaudoParams): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("A chave ANTHROPIC_API_KEY não está configurada.");
  }

  const client = getClaudeClient();

  const resposta = await comRetry(
    () =>
      client.messages.create({
        model: MODEL_NAME,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: buildLaudoPrompt(params) }],
      }),
    "geração de laudo"
  );

  const blocoTexto = resposta.content.find((b) => b.type === "text");
  return blocoTexto && blocoTexto.type === "text" ? blocoTexto.text : "";
}
