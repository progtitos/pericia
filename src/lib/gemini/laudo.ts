// pericia-ai/src/lib/gemini/laudo.ts
//
// Geração da minuta do laudo pericial. Diferente da triagem (que só extrai
// dados), aqui a IA redige texto corrido — mas com duas restrições rígidas:
//   1. Todo valor numérico do laudo (tabela demonstrativa, total, honorários)
//      DEVE vir do objeto `resultadoCalculo`, que é gerado por código
//      determinístico (src/lib/calc/previdenciario.ts). A IA nunca calcula.
//   2. Toda citação a um fato/decisão do processo DEVE indicar a folha exata
//      (ex.: "conforme decisão de fls. 142"), localizada a partir dos
//      marcadores [[FLS. N]] presentes no texto do processo. Se a IA não
//      conseguir localizar a folha com segurança, ela deve dizer isso
//      explicitamente ("folha não identificada") em vez de inventar um
//      número — inventar uma folha é pior do que não citar nenhuma, porque
//      passa uma falsa sensação de rastreabilidade.

import { comRetry, humanizarErroGemini } from "@/lib/gemini/extract";
import type { ProcessoTriagemExtraido } from "@/lib/types";

export { humanizarErroGemini };

// Modelos como o Flash têm janela de contexto grande, mas processos muito
// extensos (o texto paginado com marcadores [[FLS. N]]) ainda assim podem
// ultrapassar o que vale a pena mandar numa única chamada de redação. Damos
// prioridade ao início (identificação/petição) e ao final (normalmente onde
// está a sentença/decisão) quando o texto excede este limite.
const MAX_CHARS_TEXTO_PROCESSO_NO_PROMPT = 400_000;

interface QuesitoAprovado {
  author: string;
  question_text: string;
}

export interface GerarLaudoParams {
  processoTriagem: ProcessoTriagemExtraido | Record<string, unknown> | null;
  resultadoCalculo: unknown;
  quesitosAprovados: QuesitoAprovado[];
  /** Texto completo do processo, com marcadores [[FLS. N]] inseridos por
   *  página (ver src/lib/pdf-reader.ts). Opcional: se ausente, o laudo é
   *  gerado sem citação de folha (a IA é instruída a avisar disso). */
  textoPaginado?: string | null;
}

/**
 * Se o texto paginado for maior que o orçamento definido, mantemos o
 * começo (identificação/petição inicial) e o final (sentença/decisão —
 * normalmente onde estão os fatos mais citados no laudo), descartando o
 * meio. Isso é declarado explicitamente no prompt (nunca escondido), para
 * que o perito saiba que uma citação de fls. fora dessas faixas pode não
 * ter sido encontrada.
 */
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

function buildLaudoPrompt(params: GerarLaudoParams): string {
  const textoInfo = params.textoPaginado ? recortarTextoParaPrompt(params.textoPaginado) : null;

  const avisoRecorte = textoInfo?.foiRecortado
    ? "O texto abaixo foi parcialmente omitido no meio por limite de tamanho (processo muito extenso); se precisar citar algo que pareça estar no trecho omitido, diga isso explicitamente em vez de adivinhar a folha."
    : "";

  const avisoSemTexto = !params.textoPaginado
    ? "ATENÇÃO: o texto do processo não foi fornecido nesta chamada. NÃO cite nenhuma folha — em vez disso, registre na conclusão que a minuta foi gerada sem acesso ao texto integral do processo, apenas aos dados já estruturados."
    : "";

  return `
Você é um perito judicial redigindo uma MINUTA de laudo pericial em conformidade com o CPC.

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

Redija a minuta agora, em português formal técnico-jurídico, neutro e sem adjetivação
favorável a qualquer parte.
`.trim();
}

/** Gera a minuta do laudo pericial (texto Markdown). Retry automático para
 *  erros transitórios (503/429) reaproveitado de lib/gemini/extract.ts. */
export async function gerarLaudoPericial(params: GerarLaudoParams): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("A chave GEMINI_API_KEY não está configurada.");
  }

  // A geração de laudo pede texto livre (Markdown), não JSON estruturado —
  // por isso monta um model próprio, sem forçar responseMimeType JSON.
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });

  const texto = await comRetry(async () => {
    const result = await model.generateContent(buildLaudoPrompt(params));
    return result.response.text();
  }, "geração de laudo");

  return texto;
}
