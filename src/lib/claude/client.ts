// src/lib/claude/client.ts
import Anthropic from "@anthropic-ai/sdk";

/**
 * Modelo homologado para o fluxo pericial.
 *
 * ATENÇÃO — histórico: este projeto usava "claude-3-5-sonnet-20241022",
 * mas esse snapshot foi descontinuado pela Anthropic em 13/08/2025 e
 * DESATIVADO em 28/10/2025 (chamadas retornam 404 not_found_error a partir
 * daí). Atualizado para "claude-sonnet-5" (lançado 30/06/2026), o Sonnet
 * ativo no momento desta atualização.
 *
 * Se este modelo também for descontinuado no futuro, o sintoma é sempre o
 * mesmo: 404 "not_found_error" com o nome do modelo na mensagem. Confira o
 * modelo ativo em https://docs.claude.com/en/docs/about-claude/models antes
 * de trocar este valor.
 */
export const MODEL_NAME = "claude-sonnet-5";

/**
 * Máximo de tokens de SAÍDA suportado por este modelo (até 128.000 no
 * Sonnet 5). Não usamos o teto inteiro por padrão — 16.384 já é generoso
 * para uma minuta de laudo e mantém custo/latência sob controle; suba este
 * valor se precisar de laudos ainda mais longos.
 */
export const MAX_OUTPUT_TOKENS = 16_384;

let client: Anthropic | null = null;

export function getClaudeClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error(
      "A variável de ambiente ANTHROPIC_API_KEY não está configurada no servidor."
    );
  }

  if (!client) {
    client = new Anthropic({ apiKey });
  }

  return client;
}
