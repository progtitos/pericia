/**
 * Comparador determinístico entre Tabela Price e SAC, usado na perícia
 * bancária/contratual para confrontar o sistema de amortização efetivamente
 * cobrado pelo banco contra o previsto em contrato.
 */

export interface ParcelaAmortizacao {
  numero: number;
  saldo_devedor_inicial: number;
  juros: number;
  amortizacao: number;
  parcela: number;
  saldo_devedor_final: number;
}

/** Tabela Price: parcela (PMT) constante ao longo de todo o contrato. */
export function calcularTabelaPrice(
  valorFinanciado: number,
  taxaMensal: number,
  numeroParcelas: number
): ParcelaAmortizacao[] {
  const pmt =
    (valorFinanciado * taxaMensal) /
    (1 - Math.pow(1 + taxaMensal, -numeroParcelas));

  const parcelas: ParcelaAmortizacao[] = [];
  let saldo = valorFinanciado;

  for (let i = 1; i <= numeroParcelas; i++) {
    const juros = saldo * taxaMensal;
    const amortizacao = pmt - juros;
    const saldoFinal = saldo - amortizacao;

    parcelas.push({
      numero: i,
      saldo_devedor_inicial: round2(saldo),
      juros: round2(juros),
      amortizacao: round2(amortizacao),
      parcela: round2(pmt),
      saldo_devedor_final: round2(Math.max(saldoFinal, 0)),
    });

    saldo = saldoFinal;
  }

  return parcelas;
}

/** SAC: amortização constante, parcela decrescente. */
export function calcularTabelaSAC(
  valorFinanciado: number,
  taxaMensal: number,
  numeroParcelas: number
): ParcelaAmortizacao[] {
  const amortizacaoConstante = valorFinanciado / numeroParcelas;
  const parcelas: ParcelaAmortizacao[] = [];
  let saldo = valorFinanciado;

  for (let i = 1; i <= numeroParcelas; i++) {
    const juros = saldo * taxaMensal;
    const parcela = amortizacaoConstante + juros;
    const saldoFinal = saldo - amortizacaoConstante;

    parcelas.push({
      numero: i,
      saldo_devedor_inicial: round2(saldo),
      juros: round2(juros),
      amortizacao: round2(amortizacaoConstante),
      parcela: round2(parcela),
      saldo_devedor_final: round2(Math.max(saldoFinal, 0)),
    });

    saldo = saldoFinal;
  }

  return parcelas;
}

/**
 * Compara a taxa de juros efetivamente cobrada (deduzida do contrato) contra
 * a Taxa Média de Mercado do BACEN para a mesma modalidade — usado para
 * apontar indícios de abusividade/anatocismo.
 */
export function compararComTaxaMedia(
  taxaContratadaMensal: number,
  taxaMediaMercadoMensal: number
): { divergenciaPercentual: number; indicioAbusividade: boolean } {
  const divergenciaPercentual = round2(
    ((taxaContratadaMensal - taxaMediaMercadoMensal) / taxaMediaMercadoMensal) * 100
  );
  // Critério de referência: divergência > 50% acima da média é indício a investigar
  // (não é conclusão jurídica automática — cabe ao perito confirmar).
  return {
    divergenciaPercentual,
    indicioAbusividade: divergenciaPercentual > 50,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
