import { GoogleGenAI } from "@google/genai";

/**
 * Mapeamento atualizado dos modelos ativos da API do Google Gemini.
 * Utiliza as versões estáveis vigentes (gemini-3.6-flash e gemini-3.1-pro-preview).
 */
export const MODELS = {
  FLASH: process.env.GEMINI_FLASH_MODEL || "gemini-3.6-flash",
  PRO: process.env.GEMINI_PRO_MODEL || "gemini-3.6-flash",
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