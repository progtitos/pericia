import type { CompetenciaCalculada } from "@/lib/types";

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const percent = (n: number) => `${(n * 100).toFixed(4)}%`;

export function DemonstrativoTable({ competencias }: { competencias: CompetenciaCalculada[] }) {
  return (
    <div className="overflow-x-auto rounded border border-ink-100">
      <table className="w-full text-sm">
        <thead>
          <tr className="linha-ledger bg-parchment-dim text-left text-xs uppercase tracking-wide text-ink-500">
            <th className="px-3 py-2 font-medium">Competência</th>
            <th className="px-3 py-2 font-medium">Índice</th>
            <th className="px-3 py-2 font-medium text-right">Taxa</th>
            <th className="px-3 py-2 font-medium text-right">Correção</th>
            <th className="px-3 py-2 font-medium text-right">Juros</th>
            <th className="px-3 py-2 font-medium text-right">Valor Corrigido</th>
          </tr>
        </thead>
        <tbody className="tabular-figures">
          {competencias.map((c) => (
            <tr key={c.competencia} className="linha-ledger hover:bg-parchment-dim/60">
              <td className="px-3 py-1.5">{c.competencia}</td>
              <td className="px-3 py-1.5 text-ink-500">{c.indice_aplicado}</td>
              <td className="px-3 py-1.5 text-right">{percent(c.taxa_indice)}</td>
              <td className="px-3 py-1.5 text-right">{currency.format(c.correcao_monetaria)}</td>
              <td className="px-3 py-1.5 text-right">{currency.format(c.juros)}</td>
              <td className="px-3 py-1.5 text-right font-medium">{currency.format(c.valor_corrigido)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
