// src/lib/gemini/client.ts
import { GoogleGenAI } from "@google/genai";

/**
 * Modelos estáveis do Google Gemini.
 * Utiliza as versões de produção ativas (gemini-2.5-flash e gemini-2.5-pro).
 */
export const MODELS = {
  FLASH: process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash",
  PRO: process.env.GEMINI_PRO_MODEL || "gemini-2.5-pro",
  FALLBACK: "gemini-1.5-flash",
};

let aiClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "A variável de ambiente GEMINI_API_KEY ou GOOGLE_GEMINI_API_KEY não está configurada no servidor."
    );
  }

  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey });
  }

  return aiClient;
}

/**
 * Executa requisições de geração de conteúdo com fallback automático entre modelos
 * caso o modelo principal sofra com indisponibilidade (503) ou instabilidade temporária.
 */
export async function generateContentWithFallback(params: {
  contents: any;
  config?: any;
  preferredModel?: string;
}) {
  const ai = getGeminiClient();
  
  // Ordem de prioridade de chamada
  const modelQueue = [
    params.preferredModel || MODELS.FLASH,
    MODELS.PRO,
    MODELS.FALLBACK,
  ];

  let lastError: any = null;

  for (const model of modelQueue) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: params.contents,
        config: params.config,
      });
      return response;
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.statusCode;
      console.warn(
        `[Gemini Fallback] Modelo ${model} indisponível (Status: ${status}). Tentando próximo modelo...`
      );
      
      // Se não for erro de cota (429) ou indisponibilidade (503/500), interrompe
      if (status && ![429, 500, 503].includes(status)) {
        throw err;
      }
    }
  }

  throw lastError || new Error("Todos os modelos do Gemini estão indisponíveis no momento.");
}