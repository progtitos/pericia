/**
 * Módulo de anonimização prévia (LGPD, art. 13/§único e boas práticas de
 * minimização de dados) — aplicado ao texto ANTES de enviá-lo à IA (Claude),
 * quando ENABLE_ANONYMIZATION_BEFORE_AI=true.
 *
 * Estratégia: mascarar CPF/CNPJ e contas/agências bancárias com um token
 * reversível ([CPF_1], [CONTA_2]...) mantido em um mapa local, para que o
 * laudo final possa reidentificar os dados sem que eles tenham trafegado
 * para a API externa.
 */

const CPF_REGEX = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CNPJ_REGEX = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const CONTA_AGENCIA_REGEX = /\b(ag[êe]ncia|conta)[:\s]*\d{3,10}-?\d?\b/gi;

export interface AnonymizationResult {
  anonymizedText: string;
  tokenMap: Record<string, string>; // token -> valor original
}

export function anonymizeText(input: string): AnonymizationResult {
  const tokenMap: Record<string, string> = {};
  let counter = 1;

  const replaceWithToken = (prefix: string) => (match: string) => {
    const token = `[${prefix}_${counter++}]`;
    tokenMap[token] = match;
    return token;
  };

  let anonymized = input
    .replace(CPF_REGEX, replaceWithToken("CPF"))
    .replace(CNPJ_REGEX, replaceWithToken("CNPJ"))
    .replace(CONTA_AGENCIA_REGEX, replaceWithToken("CONTA"));

  return { anonymizedText: anonymized, tokenMap };
}

/** Reverte os tokens para os valores originais (usar apenas ao montar o laudo final internamente). */
export function deanonymizeText(text: string, tokenMap: Record<string, string>): string {
  let result = text;
  for (const [token, original] of Object.entries(tokenMap)) {
    result = result.split(token).join(original);
  }
  return result;
}

export function shouldAnonymize(): boolean {
  return process.env.ENABLE_ANONYMIZATION_BEFORE_AI === "true";
}
