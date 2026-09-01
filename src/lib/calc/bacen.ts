/**
 * Integração com o SGS (Sistema Gerenciador de Séries Temporais) do Banco
 * Central para obter índices oficiais mês a mês. Códigos de série públicos:
 *   - IPCA-E (variação mensal): 10764
 *   - INPC (variação mensal):   188
 *   - SELIC (taxa diária, acumulamos para taxa mensal): 11 (fator diário)
 *   - SELIC (meta/acumulada mensal já consolidada): 4390
 * Referência: https://www3.bcb.gov.br/sgspub
 */

const BASE_URL = process.env.BACEN_SGS_BASE_URL || "https://api.bcb.gov.br/dados/serie/bcdata.sgs";

export const SERIES_CODES = {
  IPCA_E: 10764,
  INPC: 188,
  SELIC_MENSAL: 4390,
} as const;

export interface SerieMensal {
  competencia: string; // "YYYY-MM"
  valor: number; // percentual do mês, ex: 0.53 significa 0,53%
}

/**
 * Busca uma série do BACEN em um intervalo de datas.
 * @param seriesCode código SGS (ver SERIES_CODES)
 * @param dataInicial formato dd/mm/aaaa (exigido pela API do BACEN)
 * @param dataFinal formato dd/mm/aaaa
 */
export async function fetchSerieBacen(
  seriesCode: number,
  dataInicial: string,
  dataFinal: string
): Promise<SerieMensal[]> {
  const url = `${BASE_URL}.${seriesCode}/dados?formato=json&dataInicial=${dataInicial}&dataFinal=${dataFinal}`;

  const res = await fetch(url, { next: { revalidate: 60 * 60 * 24 } }); // cache 24h
  if (!res.ok) {
    throw new Error(
      `Falha ao consultar série ${seriesCode} do BACEN (status ${res.status}). ` +
        `Verifique conectividade ou tente novamente mais tarde.`
    );
  }

  const raw: { data: string; valor: string }[] = await res.json();

  return raw.map((item) => {
    // item.data vem como "dd/mm/aaaa"
    const [dd, mm, yyyy] = item.data.split("/");
    return {
      competencia: `${yyyy}-${mm}`,
      valor: parseFloat(item.valor),
    };
  });
}

/** Monta um mapa competencia("YYYY-MM") -> valor percentual, para lookup O(1) no motor de cálculo. */
export function toCompetenceMap(serie: SerieMensal[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const item of serie) map[item.competencia] = item.valor;
  return map;
}
