import { GoogleGenAI } from "@google/genai";

/**
 * Mapeamento atualizado dos modelos ativos da API do Google Gemini.
 * Utiliza gemini-2.5-flash e gemini-2.5-pro como padrões estáveis.
 */
export const MODELS = {
  FLASH: process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash",
  PRO: process.env.GEMINI_PRO_MODEL || "gemini-2.5-pro",
};

let aiClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("A variável de ambiente GEMINI_API_KEY não está configurada.");
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}