import { fetchSerieBacen, toCompetenceMap, SERIES_CODES } from "@/lib/calc/bacen";
import type {
  ParametrosCalculoPrevidenciario,
  CompetenciaCalculada,
  ResultadoCalculoPrevidenciario,
} from "@/lib/types";

/**
 * Motor determinístico de recálculo previdenciário / liquidação contra a
 * Fazenda Pública. NENHUM número aqui vem de IA — este módulo é a única
 * fonte da verdade numérica do sistema (a IA apenas lê estes resultados
 * para redigir a minuta do laudo).
 *
 * Regras implementadas:
 *  - Até 11/2021: correção monetária por IPCA-E (ou INPC, conforme
 *    determinado pelo juízo) + juros de mora da poupança (regra da Lei
 *    11.960/09 / 12.703/12: 0,5% a.m. ou remuneração da poupança).
 *  - A partir de 12/2021 (EC 113/2021): incide unicamente a taxa SELIC
 *    acumulada, já englobando correção monetária e juros em índice único.
 *  - Honorários advocatícios: aplicação da Súmula 111/STJ — incidem apenas
 *    sobre as parcelas vencidas até a data da decisão que reconheceu o
 *    direito (data_base_calculo), nunca sobre as parcelas vincendas.
 */

const CUTOVER_COMPETENCE = "2021-11"; // último mês sob a regra antiga
const TAXA_POUPANCA_MENSAL_FALLBACK = 0.005; // 0,5% a.m., piso legal quando SELIC > 8,5% a.a.

function monthRange(start: string, end: string): string[] {
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  const out: string[] = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export async function calcularPrevidenciario(
  params: ParametrosCalculoPrevidenciario,
  honorariosPercentual: number = 0.1 // 10% é referência comum; ajustável pelo perito/juízo
): Promise<ResultadoCalculoPrevidenciario> {
  const FORMATO_ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (!FORMATO_ISO.test(params.dib)) {
    throw new Error(`DIB inválida ou em formato inesperado ("${params.dib}"). Use o formato AAAA-MM-DD.`);
  }
  if (!FORMATO_ISO.test(params.data_base_calculo)) {
    throw new Error(
      `Data-base do cálculo inválida ou em formato inesperado ("${params.data_base_calculo}"). Use o formato AAAA-MM-DD.`
    );
  }
  if (params.dib > params.data_base_calculo) {
    throw new Error("A DIB não pode ser posterior à data-base do cálculo — confira as datas informadas.");
  }

  const competencias = monthRange(params.dib, params.data_base_calculo);

  // Busca as séries necessárias de uma vez (evita N chamadas à API do BACEN).
  const dataInicial = `01/${params.dib.split("-")[1]}/${params.dib.split("-")[0]}`;
  const dataFinal = `28/${params.data_base_calculo.split("-")[1]}/${params.data_base_calculo.split("-")[0]}`;

  const [ipcaESerie, inpcSerie, selicSerie] = await Promise.all([
    fetchSerieBacen(SERIES_CODES.IPCA_E, dataInicial, dataFinal),
    fetchSerieBacen(SERIES_CODES.INPC, dataInicial, dataFinal),
    fetchSerieBacen(SERIES_CODES.SELIC_MENSAL, dataInicial, dataFinal),
  ]);

  const ipcaEMap = toCompetenceMap(ipcaESerie);
  const inpcMap = toCompetenceMap(inpcSerie);
  const selicMap = toCompetenceMap(selicSerie);

  const resultado: CompetenciaCalculada[] = [];
  let valorAcumulado = params.rmi;

  for (const competencia of competencias) {
    const isPosEC113 = competencia > CUTOVER_COMPETENCE;
    let indiceAplicado: CompetenciaCalculada["indice_aplicado"];
    let taxaIndice: number;
    let correcaoMonetaria = 0;
    let juros = 0;

    if (isPosEC113) {
      // EC 113/2021: índice único SELIC, sem juros de mora separados.
      indiceAplicado = "SELIC";
      taxaIndice = (selicMap[competencia] ?? 0) / 100;
      correcaoMonetaria = valorAcumulado * taxaIndice;
      juros = 0; // já embutido na SELIC
    } else {
      indiceAplicado = params.indice_ate_112021;
      const serieMap = params.indice_ate_112021 === "IPCA-E" ? ipcaEMap : inpcMap;
      taxaIndice = (serieMap[competencia] ?? 0) / 100;
      correcaoMonetaria = valorAcumulado * taxaIndice;

      // Juros de mora só correm a partir da citação. Se a data da citação
      // não foi informada (string vazia/ausente), tratamos como "sem termo
      // inicial de juros definido" em vez de deixar `.slice()` estourar em
      // runtime — evita um 500 silencioso quando o campo fica em branco.
      const dataCitacaoValida =
        typeof params.data_citacao === "string" && /^\d{4}-\d{2}/.test(params.data_citacao);
      if (dataCitacaoValida && competencia >= params.data_citacao.slice(0, 7)) {
        juros = valorAcumulado * TAXA_POUPANCA_MENSAL_FALLBACK;
      }
    }

    const valorCorrigido = valorAcumulado + correcaoMonetaria + juros;

    resultado.push({
      competencia,
      valor_original: params.rmi,
      indice_aplicado: indiceAplicado,
      taxa_indice: taxaIndice,
      correcao_monetaria: round2(correcaoMonetaria),
      juros: round2(juros),
      valor_corrigido: round2(valorCorrigido),
    });

    valorAcumulado = valorCorrigido;
  }

  const valorTotalBruto = round2(
    resultado.reduce((acc, c) => acc + c.valor_corrigido, 0)
  );

  // Súmula 111/STJ: honorários incidem só sobre parcelas vencidas até a data-base.
  const parcelasVencidas = resultado.filter(
    (c) => c.competencia <= params.data_base_calculo.slice(0, 7)
  );
  const baseHonorarios = parcelasVencidas.reduce((acc, c) => acc + c.valor_corrigido, 0);
  const honorarios = round2(baseHonorarios * honorariosPercentual);

  return {
    competencias: resultado,
    valor_total_bruto: valorTotalBruto,
    honorarios_sucumbenciais: honorarios,
    valor_liquido_final: round2(valorTotalBruto - honorarios),
    base_legal: [
      "Resolução CJF nº 784/2022 (Manual de Cálculos da Justiça Federal)",
      "Emenda Constitucional nº 113/2021",
      "Lei nº 9.494/97, art. 1º-F (redação da Lei nº 11.960/09 e Lei nº 12.703/12)",
      "Súmula 111 do STJ",
    ],
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
