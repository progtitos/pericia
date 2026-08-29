import { getGeminiClient, MODELS } from "@/lib/gemini/client";
import {
  SYSTEM_INSTRUCTION_TRIAGEM,
  TRIAGEM_RESPONSE_SCHEMA,
  SYSTEM_INSTRUCTION_EXTRATO,
  EXTRATO_RESPONSE_SCHEMA,
  buildLaudoPrompt,
} from "@/lib/gemini/prompts";
import type { ProcessoTriagemExtraido, ExtratoExtraido } from "@/lib/types";

/**
 * Fase 1: Triagem processual multimodal (PDF -> JSON estruturado).
 * @param pdfBase64 conteúdo do PDF em base64 (sem o prefixo data:...)
 */
export async function extractProcessoTriagem(
  pdfBase64: string
): Promise<ProcessoTriagemExtraido> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: MODELS.PRO,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
          {
            text: "Extraia os dados estruturados deste processo judicial conforme instruções do sistema.",
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
