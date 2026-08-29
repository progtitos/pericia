import { GoogleGenAI } from "@google/genai";

export const MODELS = {
  PRO: "gemini-3.6-flash",
  FLASH: "gemini-3.6-flash",
};

let clientInstance: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (clientInstance) return clientInstance;

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_GEMINI_API_KEY não configurada no ambiente."
    );
  }

  clientInstance = new GoogleGenAI({ apiKey });
  return clientInstance;
}
