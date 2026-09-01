/**
 * Configuração de marca White Label para a landing page pública.
 *
 * Em produção, isto seria resolvido por domínio/subdomínio (ex.:
 * `escritorio-x.periciaai.com.br` -> busca `organizations` por slug e
 * popula `logoUrl`/`partnerName`). Para o MVP, mantemos um objeto único
 * que já demonstra a composição visual "Logo do parceiro + Powered by
 * PeríciaAI", pronta para ser plugada em uma resolução dinâmica depois.
 */
export interface WhiteLabelBrand {
  partnerName: string | null; // null = marca própria PeríciaAI, sem parceiro
  logoUrl: string | null;
}

export const DEFAULT_BRAND: WhiteLabelBrand = {
  partnerName: null,
  logoUrl: null,
};

/**
 * Resolve a marca a ser exibida no cabeçalho. Hoje sempre retorna o padrão;
 * o ponto de extensão futuro é trocar isso por uma consulta a
 * `organizations` (slug do host) sem alterar o restante do layout.
 */
export function resolveBrand(): WhiteLabelBrand {
  return DEFAULT_BRAND;
}
