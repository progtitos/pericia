import { GoogleGenAI } from "@google/genai";

let _client: GoogleGenAI | null = null;

/** Singleton do client Gemini. Chave nunca deve ser exposta ao browser. */
export function getGeminiClient(): GoogleGenAI {
  if (!_client) {
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GOOGLE_GEMINI_API_KEY não configurada. Defina em .env.local (ver .env.example)."
      );
    }
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

export const MODELS = {
  // Modelos recomendados e ativos pela API do Gemini
  PRO: process.env.GEMINI_MODEL_PRO || "gemini-3.1-pro-preview",
  FLASH: process.env.GEMINI_MODEL_FLASH || "gemini-2.5-flash",
} as const;