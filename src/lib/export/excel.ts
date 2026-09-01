// pericia-ai/src/lib/export/excel.ts
//
// Gera a planilha de cálculo (.xlsx) que o perito baixa nas etapas de
// Cálculo & Reconciliação e Laudo. Usa a lib "xlsx" (SheetJS), que já é
// dependência do projeto — nenhuma lib nova precisou ser adicionada.
//
// IMPORTANTE (limite honesto do que esta planilha cobre hoje): a coluna
// "Valor Pago" da Aba 2 só é preenchida quando o caller fornece
// `valoresPagos` (ex.: vindo de um CNIS/histórico de pagamentos que ainda
// não é capturado pela extração automática do processo). Sem essa fonte,
// a planilha mostra o "Valor Devido" (recalculado) e deixa "Valor Pago" e
// "Diferença" em branco, em vez de inventar um número — divergência
// fabricada seria pior do que a ausência do dado.

import * as XLSX from "xlsx";
import type {
  ProcessoTriagemExtraido,
  ResultadoCalculoPrevidenciario,
  ReconciliacaoResultado,
} from "@/lib/types";

export interface GerarPlanilhaParams {
  triagem: ProcessoTriagemExtraido | null;
  resultadoCalculo: ResultadoCalculoPrevidenciario | null;
  reconciliacao?: ReconciliacaoResultado | null;
  /** Opcional: valor efetivamente pago por competência (ex.: extraído de um
   *  CNIS/histórico de pagamentos), chave "YYYY-MM" -> valor em R$. Quando
   *  ausente, as colunas "Valor Pago"/"Diferença" da Aba 2 ficam em branco
   *  em vez de exibir um número inventado. */
  valoresPagos?: Record<string, number>;
}

const moeda = (v: number | null | undefined) =>
  v == null ? "" : Number(v.toFixed(2));

/** Aba 1 — Resumo do caso e dados das partes. */
function montarAbaResumo(triagem: ProcessoTriagemExtraido | null, resultado: ResultadoCalculoPrevidenciario | null) {
  const linhas: (string | number)[][] = [
    ["PeríciaAI — Resumo do Caso"],
    [],
    ["Número do processo", triagem?.numero_processo ?? "—"],
    ["Vara", triagem?.vara ?? "—"],
    ["Autor", triagem?.autor ?? "—"],
    ["Réu", triagem?.reu ?? "—"],
    ["DIB", triagem?.dib ?? "—"],
    ["DER", triagem?.der ?? "—"],
    ["RMI", triagem?.rmi != null ? moeda(triagem.rmi) : "—"],
    ["Índice determinado pelo juízo", triagem?.indice_determinado_pelo_juiz ?? "—"],
    ["Data da citação", triagem?.data_citacao ?? "—"],
    [],
    ["Resultado do Cálculo"],
    ["Valor total bruto", resultado ? moeda(resultado.valor_total_bruto) : "—"],
    ["Honorários sucumbenciais (Súmula 111/STJ)", resultado ? moeda(resultado.honorarios_sucumbenciais) : "—"],
    ["Valor líquido final", resultado ? moeda(resultado.valor_liquido_final) : "—"],
    [],
    ["Base legal aplicada", (resultado?.base_legal ?? []).join("; ") || "—"],
    [],
    ["Gerado em", new Date().toLocaleString("pt-BR")],
  ];

  const ws = XLSX.utils.aoa_to_sheet(linhas);
  ws["!cols"] = [{ wch: 38 }, { wch: 50 }];
  return ws;
}

/** Aba 2 — Memória de cálculo mês a mês. */
function montarAbaMemoriaCalculo(
  resultado: ResultadoCalculoPrevidenciario | null,
  valoresPagos?: Record<string, number>
) {
  const cabecalho = [
    "Competência",
    "Valor Devido (recalculado)",
    "Valor Pago",
    "Diferença",
    "Índice Aplicado",
    "Taxa do Índice (%)",
    "Correção Monetária",
    "Juros",
    "Valor Corrigido Acumulado",
  ];

  const linhas: (string | number)[][] = [cabecalho];

  for (const c of resultado?.competencias ?? []) {
    const valorPago = valoresPagos?.[c.competencia];
    const diferenca = valorPago != null ? c.valor_corrigido - valorPago : "";

    linhas.push([
      c.competencia,
      moeda(c.valor_original),
      valorPago != null ? moeda(valorPago) : "",
      diferenca === "" ? "" : moeda(diferenca as number),
      c.indice_aplicado,
      Number((c.taxa_indice * 100).toFixed(4)),
      moeda(c.correcao_monetaria),
      moeda(c.juros),
      moeda(c.valor_corrigido),
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(linhas);
  ws["!cols"] = cabecalho.map(() => ({ wch: 20 }));
  return ws;
}

/** Aba 3 — Conferência de erros / divergências identificadas. */
function montarAbaDivergencias(
  triagem: ProcessoTriagemExtraido | null,
  reconciliacao?: ReconciliacaoResultado | null
) {
  const linhas: (string | number)[][] = [["Tipo", "Descrição"]];

  if (reconciliacao) {
    linhas.push([
      reconciliacao.consistente ? "Extrato — OK" : "Extrato — DIVERGÊNCIA",
      reconciliacao.consistente
        ? `Saldo conferido: inicial ${moeda(reconciliacao.saldo_inicial)}, final calculado ${moeda(reconciliacao.saldo_final_calculado)}.`
        : `Saldo inicial ${moeda(reconciliacao.saldo_inicial)} + movimentações ≠ saldo final. ` +
          `Calculado: ${moeda(reconciliacao.saldo_final_calculado)}` +
          (reconciliacao.saldo_final_informado != null
            ? `, informado no extrato: ${moeda(reconciliacao.saldo_final_informado)}, divergência de ${moeda(reconciliacao.divergencia)}.`
            : "."),
    ]);
  }

  for (const obs of triagem?.observacoes_para_conferencia_humana ?? []) {
    linhas.push(["Conferência humana obrigatória (triagem)", obs]);
  }

  if (linhas.length === 1) {
    linhas.push(["—", "Nenhuma divergência identificada até o momento."]);
  }

  const ws = XLSX.utils.aoa_to_sheet(linhas);
  ws["!cols"] = [{ wch: 32 }, { wch: 90 }];
  return ws;
}

/**
 * Monta o workbook completo (3 abas) e retorna os bytes prontos para
 * resposta HTTP (Content-Type de .xlsx) ou download direto no navegador.
 */
export function gerarPlanilhaCalculo(params: GerarPlanilhaParams): Uint8Array {
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, montarAbaResumo(params.triagem, params.resultadoCalculo), "Resumo do Caso");
  XLSX.utils.book_append_sheet(
    wb,
    montarAbaMemoriaCalculo(params.resultadoCalculo, params.valoresPagos),
    "Memória de Cálculo"
  );
  XLSX.utils.book_append_sheet(
    wb,
    montarAbaDivergencias(params.triagem, params.reconciliacao),
    "Conferência de Divergências"
  );

  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Uint8Array(buffer);
}
