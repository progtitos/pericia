// src/lib/gemini/laudo.ts
//
// Geração da minuta do laudo pericial via Gemini (free tier). Mesmas
// restrições de sempre: números vêm só de resultadoCalculo (código
// determinístico), citações de fls. vêm dos marcadores [[FLS. N]] ou o
// modelo declara que não encontrou a folha — nunca inventa um número.

import { getGeminiClient, MODEL_LAUDO } from "@/lib/gemini/client";
import { humanizarErroGemini } from "@/lib/gemini/extract";
import type { ProcessoTriagemExtraido } from "@/lib/types";

export { humanizarErroGemini };

// Free tier: janela de 1.000.000 tokens, mas mantemos um teto para não
// gastar TPM à toa — a maioria dos processos cabe inteiro aqui mesmo assim.
const MAX_CHARS_TEXTO_PROCESSO_NO_PROMPT = 600_000;

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
  return {
    recorte:
      texto.slice(0, metade) +
      "\n\n[...TRECHO INTERMEDIÁRIO OMITIDO POR LIMITE DE TAMANHO...]\n\n" +
      texto.slice(texto.length - metade),
    foiRecortado: true,
  };
}

function buildLaudoPrompt(params: GerarLaudoParams): string {
  const textoInfo = params.textoPaginado ? recortarTextoParaPrompt(params.textoPaginado) : null;

  return `
Você é um perito judicial redigindo uma MINUTA de laudo pericial em conformidade com o CPC
brasileiro. Escreva em português formal técnico-jurídico, neutro.

REGRAS INEGOCIÁVEIS:

1. CITAÇÃO DE FOLHAS (fls.): o texto do processo contém marcadores [[FLS. N]] indicando o
   início de cada folha. Cite a folha exata sempre que mencionar uma decisão/fato dos autos,
   no formato "fls. N". NUNCA invente um número — se não localizar, escreva "(folha não
   identificada)".
   ${textoInfo?.foiRecortado ? "O texto foi parcialmente omitido no meio por limite de tamanho." : ""}
   ${!params.textoPaginado ? "O texto do processo não foi fornecido — não cite nenhuma folha." : ""}

2. NÚMEROS: todos os valores numéricos DEVEM vir exatamente de "resultadoCalculo" abaixo.
   Nunca calcule ou estime um número que não esteja lá.

3. Dado ausente para responder um quesito: diga que "não foi disponibilizado nos autos",
   nunca invente.

4. Estrutura obrigatória (Markdown): ## 1. Identificação das Partes e Juízo / ## 2. Histórico
   Processual / ## 3. Análise Técnica e Memória de Cálculo / ## 4. Respostas aos Quesitos /
   ## 5. Conclusão / ## 6. Tabela Demonstrativa Final

DADOS DA TRIAGEM: ${JSON.stringify(params.processoTriagem, null, 2)}

RESULTADO DO CÁLCULO: ${JSON.stringify(params.resultadoCalculo, null, 2)}

QUESITOS APROVADOS: ${JSON.stringify(params.quesitosAprovados, null, 2)}

${textoInfo ? `TEXTO DO PROCESSO (com marcadores [[FLS. N]]):\n"""\n${textoInfo.recorte}\n"""` : ""}

Redija a minuta agora.
`.trim();
}

export async function gerarLaudoPericial(params: GerarLaudoParams): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("A chave GEMINI_API_KEY não está configurada.");
  }

  const client = getGeminiClient();

  const response = await client.models.generateContent({
    model: MODEL_LAUDO,
    contents: [{ role: "user", parts: [{ text: buildLaudoPrompt(params) }] }],
    config: { temperature: 0.2 },
  });

  return response.text ?? "";
}
