import { getGeminiClient, MODELS } from "@/lib/gemini/client";
import {
  SYSTEM_INSTRUCTION_TRIAGEM,
  TRIAGEM_RESPONSE_SCHEMA,
  SYSTEM_INSTRUCTION_EXTRATO,
  EXTRATO_RESPONSE_SCHEMA,
  buildLaudoPrompt,
} from "@/lib/gemini/prompts";
import {
  extractPdfPagesText,
  buildTokenPreview,
  processarProcessoEmCamadas,
  isTokenLimitError,
} from "@/lib/gemini/chunking";
import type { ProcessoTriagemExtraido, ExtratoExtraido } from "@/lib/types";

/**
 * Fase 1: Triagem processual (PDF -> JSON estruturado).
 *
 * Estratégia em camadas (ver src/lib/gemini/chunking.ts para os detalhes):
 *   1. Extrai primeiro a camada de TEXTO do PDF (muito mais barato em tokens
 *      do que enviar o binário como multimodal).
 *   2. Conta os tokens reais. Se estiver dentro do limite seguro, envia o
 *      texto inteiro em uma única chamada (mais rápido e mais barato que o
 *      fluxo multimodal anterior).
 *   3. Se ultrapassar o limite seguro — ou se, mesmo assim, a API retornar um
 *      erro de excedimento de contexto (400/INVALID_ARGUMENT) — cai
 *      automaticamente para o modo de Análise por Camadas (map-reduce).
 *
 * @param pdfBuffer conteúdo binário do PDF
 * @param onProgress callback opcional para reportar progresso do chunking à UI
 */
export async function extractProcessoTriagem(
  pdfBuffer: Buffer,
  onProgress?: (blocoAtual: number, totalBlocos: number, rotulo: string) => void
): Promise<ProcessoTriagemExtraido> {
  const pages = await extractPdfPagesText(pdfBuffer);
  const { preview, fullText } = await buildTokenPreview(pages);

  if (preview.exigeChunking) {
    return processarProcessoEmCamadas(pages, onProgress);
  }

  try {
    return await extractProcessoTriagemFromText(fullText);
  } catch (err) {
    // Rede de segurança: mesmo com a prévia indicando estar dentro do limite,
    // overhead de schema/system prompt ou variações do modelo podem ainda
    // assim estourar o contexto. Nesse caso, tentamos automaticamente pelo
    // modo em camadas antes de propagar o erro ao usuário.
    if (isTokenLimitError(err)) {
      return processarProcessoEmCamadas(pages, onProgress);
    }
    throw err;
  }
}

/** Extração estruturada a partir de texto puro já extraído do PDF (sem multimodal). */
async function extractProcessoTriagemFromText(
  texto: string
): Promise<ProcessoTriagemExtraido> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: MODELS.PRO,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Extraia os dados estruturados deste processo judicial conforme instruções do sistema.\n\nTEXTO DO PROCESSO:\n"""\n${texto}\n"""`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION_TRIAGEM,
      responseMimeType: "application/json",
      responseSchema: TRIAGEM_RESPONSE_SCHEMA,
      temperature: 0, // determinismo máximo para tarefa de extração factual
    },
  });

  return JSON.parse(response.text ?? "{}") as ProcessoTriagemExtraido;
}

/**
 * Fase 2: OCR de extrato bancário (PDF/imagem -> lançamentos tabulares).
 */
export async function extractExtratoBancario(
  fileBase64: string,
  mimeType: "application/pdf" | "image/png" | "image/jpeg"
): Promise<ExtratoExtraido> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: MODELS.PRO,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: fileBase64 } },
          {
            text: "Converta este extrato bancário em lançamentos estruturados conforme instruções do sistema.",
          },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION_EXTRATO,
      responseMimeType: "application/json",
      responseSchema: EXTRATO_RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  return JSON.parse(response.text ?? "{}") as ExtratoExtraido;
}

/**
 * Fase 4: Geração da minuta do laudo. Texto livre (Markdown), mas 100% dos
 * números vêm do resultado do motor de cálculo determinístico — a IA apenas
 * organiza a redação (ver regras em buildLaudoPrompt).
 */
export async function generateLaudoMinuta(params: {
  processoTriagem: unknown;
  resultadoCalculo: unknown;
  quesitosAprovados: { author: string; question_text: string }[];
}): Promise<string> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: MODELS.PRO,
    contents: [{ role: "user", parts: [{ text: buildLaudoPrompt(params) }] }],
    config: {
      temperature: 0.2, // pequena liberdade estilística, mantendo rigor factual
    },
  });

  return response.text ?? "";
}
