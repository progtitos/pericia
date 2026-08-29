import type { ExtratoExtraido, ReconciliacaoResultado } from "@/lib/types";

/**
 * Mecanismo de Checagem de Saldo Inicial e Final:
 *   Saldo Inicial + Entradas - Saídas = Saldo Final
 *
 * Se o extrato informa um saldo_final e ele diverge do calculado, ou se há
 * lançamentos com baixa confiança de OCR, o sistema emite alerta obrigatório
 * de conferência humana — nunca "corrige sozinho" o valor.
 */

const LIMIAR_CONFIANCA_OCR = 0.6; // abaixo disso, lançamento é considerado suspeito
const TOLERANCIA_CENTAVOS = 0.01; // tolerância de arredondamento

export function reconciliarExtrato(extrato: ExtratoExtraido): ReconciliacaoResultado {
  const saldoInicial = extrato.saldo_inicial ?? 0;

  const totalCreditos = extrato.lancamentos.reduce((acc, l) => acc + (l.credito || 0), 0);
  const totalDebitos = extrato.lancamentos.reduce((acc, l) => acc + (l.debito || 0), 0);

  const saldoFinalCalculado = round2(saldoInicial + totalCreditos - totalDebitos);
  const saldoFinalInformado = extrato.saldo_final;

  const divergencia =
    saldoFinalInformado !== null
      ? round2(saldoFinalCalculado - saldoFinalInformado)
      : 0;

  const linhasSuspeitas = extrato.lancamentos
    .map((l, idx) => ({ idx, confianca: l.confianca_ocr }))
    .filter((x) => x.confianca < LIMIAR_CONFIANCA_OCR)
    .map((x) => x.idx);

  const consistente =
    Math.abs(divergencia) <= TOLERANCIA_CENTAVOS && linhasSuspeitas.length === 0;

  return {
    saldo_inicial: saldoInicial,
    saldo_final_informado: saldoFinalInformado,
    saldo_final_calculado: saldoFinalCalculado,
    divergencia,
    consistente,
    linhas_suspeitas: linhasSuspeitas,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
