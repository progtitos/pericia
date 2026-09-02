// src/lib/gemini/client.ts
import { GoogleGenAI } from "@google/genai";

/**
 * MUDANÇA DE PROVEDOR: Claude (Anthropic) → Gemini (Google AI Studio, FREE TIER).
 *
 * Motivo: sem orçamento para API paga. O free tier do Google AI Studio não
 * exige cartão de crédito e é genuinamente $0 — mas vem com limites reais
 * que o código precisa respeitar (ver extract.ts para como isso é tratado).
 *
 * LIMITES DO FREE TIER (verificados em 2026, conferir sempre em
 * https://ai.google.dev/gemini-api/docs/rate-limits — a Google já reduziu
 * esses números uma vez, em dezembro/2025, sem aviso prévio no código):
 *
 *   gemini-2.5-flash:      10 RPM · 250.000 TPM · 250 RPD
 *   gemini-2.5-flash-lite: 15 RPM · 250.000 TPM · 1.000 RPD
 *
 * Ambos têm janela de contexto de 1.000.000 de tokens — cabe o processo
 * inteiro numa única chamada na grande maioria dos casos.
 *
 * IMPORTANTE (privacidade): no free tier, o Google pode usar os prompts e
 * respostas para melhorar seus produtos. Isso é diferente do tier pago.
 * Se o caso envolver dados sensíveis e isso for uma preocupação, considere
 * ativar billing (ainda que com uso mínimo) só para desligar esse uso dos
 * dados — nesse caso a cobrança deixa de ser $0, mas fica muito barata
 * (Gemini 2.5 Flash pago: ~$0,30/M tokens de entrada).
 */
export const MODEL_EXTRACAO = "gemini-2.5-flash";
export const MODEL_LAUDO = "gemini-2.5-flash";

// Limites reais do free tier — usados para ritmar as chamadas em
// extract.ts (nunca dispare mais rápido que isto, ou toma 429).
export const FREE_TIER_RPM = 10; // requisições por minuto (gemini-2.5-flash)
export const FREE_TIER_RPD = 250; // requisições por dia (gemini-2.5-flash)
export const FREE_TIER_TPM = 250_000; // tokens por minuto

let client: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "A variável de ambiente GEMINI_API_KEY não está configurada no servidor. " +
        "Gere uma chave gratuita em https://aistudio.google.com/apikey (não exige cartão)."
    );
  }

  if (!client) {
    client = new GoogleGenAI({ apiKey });
  }

  return client;
}
