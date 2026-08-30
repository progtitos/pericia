import { GoogleGenAI } from "@google/genai";

export const MODELS = {
  FLASH: process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash",
  PRO: process.env.GEMINI_PRO_MODEL || "gemini-2.5-flash",
};

let aiClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  // Busca tanto por GEMINI_API_KEY quanto por GOOGLE_GEMINI_API_KEY
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