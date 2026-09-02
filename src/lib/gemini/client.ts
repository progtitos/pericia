// src/lib/gemini/client.ts
import { GoogleGenAI } from "@google/genai";

/**
 * HISTÓRICO DE MODELO (isso já mudou 2x em poucos dias — Google troca a
 * geração padrão do free tier com bastante frequência):
 *
 *   1. gemini-2.5-flash — usado na primeira versão desta migração.
 *   2. DESATIVADO para chaves de API novas em algum momento entre a criação
 *      desta migração e o primeiro teste em produção. Erro observado:
 *      404 "This model models/gemini-2.5-flash is no longer available to
 *      new users. Please update your code to use models/gemini-3.6-flash".
 *   3. Atualizado para gemini-3.6-flash (lançado 21/07/2026), que é
 *      literalmente o substituto que a própria API do Google indicou no
 *      erro acima — não uma suposição.
 *
 * SE ISSO QUEBRAR DE NOVO NO FUTURO: o sintoma é sempre um 404 com o nome
 * do modelo na mensagem, geralmente já indicando o substituto certo. Troque
 * o valor abaixo e confira os limites atuais de free tier em
 * https://aistudio.google.com/apikey → seu projeto → Quotas.
 */
export const MODEL_EXTRACAO = "gemini-3.6-flash";
export const MODEL_LAUDO = "gemini-3.6-flash";

// IMPORTANTE: estes números eram os confirmados para gemini-2.5-flash. Para
// gemini-3.6-flash, os limites de free tier ainda NÃO foram verificados de
// forma independente por mim — mantidos aqui como estimativa conservadora
// de segurança. Confira os valores reais em aistudio.google.com (seu
// projeto → Quotas) e ajuste se necessário; é só mexer nestes 3 números,
// nada mais no código depende de valores fixos além destes.
export const FREE_TIER_RPM = 10;
export const FREE_TIER_RPD = 250;
export const FREE_TIER_TPM = 250_000;

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
