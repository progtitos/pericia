"use client";

import { useState } from "react";
import Link from "next/link";

type Especialidade = "previdenciario" | "bancario" | "trabalhista" | "grafotecnico" | "imobiliario";

const TABS: { id: Especialidade; label: string }[] = [
  { id: "previdenciario", label: "Previdenciária" },
  { id: "bancario", label: "Bancária & Financeira" },
  { id: "trabalhista", label: "Trabalhista" },
  { id: "grafotecnico", label: "Grafotécnica & Documental" },
  { id: "imobiliario", label: "Imobiliária (PTAM)" },
];

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Calculadora Express / "Minuta com 1 Clique" — ferramenta de geração de
 * lead na home pública. IMPORTANTE: os resultados aqui são ESTIMATIVAS
 * simplificadas calculadas no cliente (fórmulas determinísticas básicas,
 * sem consultar séries do BACEN nem o motor completo de recálculo).
 *
 * O laudo pericial auditável de verdade — com IPCA-E/SELIC competência a
 * competência, reconciliação de extrato, etc. — só é gerado dentro da
 * plataforma autenticada (src/lib/calc/*). Isso é dito explicitamente ao
 * usuário em cada resultado, para não prometer precisão que esta prévia
 * não tem.
 */
export function ExpressCalculator() {
  const [tab, setTab] = useState<Especialidade>("previdenciario");

  return (
    <div className="rounded border border-ink-700 bg-ink-800/60 p-1">
      <div className="flex flex-wrap gap-1 border-b border-ink-700 p-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t.id
                ? "bg-brass text-ink-900"
                : "text-ink-100 hover:bg-ink-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-6">
        {tab === "previdenciario" && <PrevidenciarioExpress />}
        {tab === "bancario" && <BancarioExpress />}
        {tab === "trabalhista" && <TrabalhistaExpress />}
        {tab === "grafotecnico" && <GrafotecnicoExpress />}
        {tab === "imobiliario" && <ImobiliarioExpress />}
      </div>
    </div>
  );
}

function Disclaimer() {
  return (
    <p className="mt-4 text-[11px] leading-relaxed text-ink-300">
      Prévia simplificada, calculada apenas com os dados acima — não substitui a perícia
      completa e auditável (competência a competência, com séries oficiais do BACEN e
      conferência de documentos) disponível na plataforma.
    </p>
  );
}

function ResultCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 rounded border border-brass/30 bg-brass/5 p-4">
      {children}
      <Link
        href="/login"
        className="mt-3 inline-block text-xs font-medium text-brass-light hover:underline"
      >
        Gerar a análise completa e auditável →
      </Link>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-100">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-parchment placeholder:text-ink-500 focus:border-brass focus:outline-none";

function PrevidenciarioExpress() {
  const [dib, setDib] = useState("");
  const [rmi, setRmi] = useState("");
  const [atrasados, setAtrasados] = useState("");
  const [resultado, setResultado] = useState<number | null>(null);

  function gerar() {
    const rmiNum = parseFloat(rmi) || 0;
    const atrasadosNum = parseFloat(atrasados) || 0;
    // Estimativa simplificada: soma o valor de atrasados já declarado a uma
    // margem de correção aproximada (não usa SELIC/IPCA-E real — isso só
    // acontece no motor completo, competência a competência).
    setResultado(atrasadosNum > 0 ? atrasadosNum * 1.08 : rmiNum * 12 * 1.08);
  }

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="DIB (Data de Início do Benefício)">
          <input type="date" value={dib} onChange={(e) => setDib(e.target.value)} className={inputClass} />
        </Field>
        <Field label="RMI Declarada (R$)">
          <input
            type="number"
            value={rmi}
            onChange={(e) => setRmi(e.target.value)}
            className={inputClass}
            placeholder="1.850,00"
          />
        </Field>
        <Field label="Valor de Atrasados (R$)">
          <input
            type="number"
            value={atrasados}
            onChange={(e) => setAtrasados(e.target.value)}
            className={inputClass}
            placeholder="opcional"
          />
        </Field>
      </div>

      <button
        onClick={gerar}
        className="mt-4 rounded bg-brass px-5 py-2 text-sm font-medium text-ink-900 hover:bg-brass-light transition-colors"
      >
        Gerar Minuta de Recálculo
      </button>

      {resultado !== null && (
        <ResultCard>
          <p className="text-xs uppercase tracking-wide text-ink-300">Estimativa de valor corrigido</p>
          <p className="mt-1 font-display text-xl text-parchment">{currency.format(resultado)}</p>
        </ResultCard>
      )}
      <Disclaimer />
    </div>
  );
}

function BancarioExpress() {
  const [tipoContrato, setTipoContrato] = useState("Financiamento de Veículo");
  const [valorEmprestimo, setValorEmprestimo] = useState("");
  const [taxaPraticada, setTaxaPraticada] = useState("");
  const [resultado, setResultado] = useState<{ excesso: number; taxaAnualEquiv: number } | null>(null);

  function gerar() {
    const valor = parseFloat(valorEmprestimo) || 0;
    const taxaMensal = (parseFloat(taxaPraticada) || 0) / 100;
    // Taxa média de mercado de referência simplificada para a prévia
    // (na plataforma completa, isso vem da série do BACEN em tempo real).
    const TAXA_MEDIA_REFERENCIA_MENSAL = 0.018;
    const excessoMensal = Math.max(0, taxaMensal - TAXA_MEDIA_REFERENCIA_MENSAL) * valor;
    const taxaAnualEquiv = (Math.pow(1 + taxaMensal, 12) - 1) * 100;
    setResultado({ excesso: excessoMensal, taxaAnualEquiv });
  }

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Tipo de Contrato">
          <select
            value={tipoContrato}
            onChange={(e) => setTipoContrato(e.target.value)}
            className={inputClass}
          >
            <option>Financiamento de Veículo</option>
            <option>SFH / Imóvel</option>
            <option>Cartão de Crédito</option>
            <option>Capital de Giro</option>
          </select>
        </Field>
        <Field label="Valor do Empréstimo (R$)">
          <input
            type="number"
            value={valorEmprestimo}
            onChange={(e) => setValorEmprestimo(e.target.value)}
            className={inputClass}
            placeholder="25.000,00"
          />
        </Field>
        <Field label="Taxa Praticada (% a.m.)">
          <input
            type="number"
            step="0.01"
            value={taxaPraticada}
            onChange={(e) => setTaxaPraticada(e.target.value)}
            className={inputClass}
            placeholder="3,20"
          />
        </Field>
      </div>

      <button
        onClick={gerar}
        className="mt-4 rounded bg-brass px-5 py-2 text-sm font-medium text-ink-900 hover:bg-brass-light transition-colors"
      >
        Gerar Minuta de Expurgos/Revisional
      </button>

      {resultado && (
        <ResultCard>
          <p className="text-xs uppercase tracking-wide text-ink-300">
            Indício de excesso mensal sobre a taxa média de referência
          </p>
          <p className="mt-1 font-display text-xl text-parchment">{currency.format(resultado.excesso)}</p>
          <p className="mt-1 text-xs text-ink-300">
            Taxa contratada equivale a {resultado.taxaAnualEquiv.toFixed(1)}% a.a.
          </p>
        </ResultCard>
      )}
      <Disclaimer />
    </div>
  );
}

function TrabalhistaExpress() {
  const [salario, setSalario] = useState("");
  const [periodoMeses, setPeriodoMeses] = useState("");
  const [horasExtrasMes, setHorasExtrasMes] = useState("");
  const [resultado, setResultado] = useState<{ base: number; extras: number; total: number } | null>(null);

  function gerar() {
    const salarioNum = parseFloat(salario) || 0;
    const meses = parseFloat(periodoMeses) || 0;
    const horasExtras = parseFloat(horasExtrasMes) || 0;

    const valorHora = salarioNum / 220; // jornada padrão de referência (220h/mês)
    const valorHoraExtra = valorHora * 1.5; // adicional de 50% de referência
    const totalExtras = valorHoraExtra * horasExtras * meses;
    const totalBase = salarioNum * meses;

    setResultado({ base: totalBase, extras: totalExtras, total: totalBase + totalExtras });
  }

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Salário Base (R$)">
          <input
            type="number"
            value={salario}
            onChange={(e) => setSalario(e.target.value)}
            className={inputClass}
            placeholder="2.500,00"
          />
        </Field>
        <Field label="Período (meses)">
          <input
            type="number"
            value={periodoMeses}
            onChange={(e) => setPeriodoMeses(e.target.value)}
            className={inputClass}
            placeholder="18"
          />
        </Field>
        <Field label="Média de Horas Extras/Mês">
          <input
            type="number"
            value={horasExtrasMes}
            onChange={(e) => setHorasExtrasMes(e.target.value)}
            className={inputClass}
            placeholder="12"
          />
        </Field>
      </div>

      <button
        onClick={gerar}
        className="mt-4 rounded bg-brass px-5 py-2 text-sm font-medium text-ink-900 hover:bg-brass-light transition-colors"
      >
        Gerar Minuta de Liquidação
      </button>

      {resultado && (
        <ResultCard>
          <p className="text-xs uppercase tracking-wide text-ink-300">Estimativa de liquidação</p>
          <p className="mt-1 font-display text-xl text-parchment">{currency.format(resultado.total)}</p>
          <p className="mt-1 text-xs text-ink-300">
            Base: {currency.format(resultado.base)} · Horas extras (adicional 50%): {currency.format(resultado.extras)}
          </p>
        </ResultCard>
      )}
      <Disclaimer />
    </div>
  );
}

function GrafotecnicoExpress() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [referencia, setReferencia] = useState("");
  const [solicitado, setSolicitado] = useState(false);

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Documento contestado">
          <label className="flex cursor-pointer items-center justify-center rounded border border-dashed border-ink-700 bg-ink-900 px-3 py-4 text-xs text-ink-300 hover:border-brass">
            {fileName ?? "Clique para selecionar (PDF/imagem)"}
            <input
              type="file"
              accept="application/pdf,image/*"
              className="hidden"
              onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
            />
          </label>
        </Field>
        <Field label="Assinatura/documento de referência">
          <input
            value={referencia}
            onChange={(e) => setReferencia(e.target.value)}
            className={inputClass}
            placeholder="ex.: RG, CNH, contrato anterior reconhecido"
          />
        </Field>
      </div>

      <button
        onClick={() => setSolicitado(true)}
        className="mt-4 rounded bg-brass px-5 py-2 text-sm font-medium text-ink-900 hover:bg-brass-light transition-colors"
      >
        Emitir Parecer de Autenticidade
      </button>

      {solicitado && (
        <ResultCard>
          <p className="text-sm text-parchment">
            A análise grafotécnica exige perícia humana com o documento original em mãos — não é um
            cálculo automático. Crie sua conta para enviar o documento com segurança e acompanhar o
            parecer dentro da plataforma.
          </p>
        </ResultCard>
      )}
    </div>
  );
}

function ImobiliarioExpress() {
  const [area, setArea] = useState("");
  const [tipoImovel, setTipoImovel] = useState("Residencial urbano");
  const [valorM2, setValorM2] = useState("");
  const [resultado, setResultado] = useState<number | null>(null);

  function gerar() {
    const areaNum = parseFloat(area) || 0;
    const valorM2Num = parseFloat(valorM2) || 0;
    setResultado(areaNum * valorM2Num);
  }

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Área (m²)">
          <input
            type="number"
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className={inputClass}
            placeholder="120"
          />
        </Field>
        <Field label="Tipo de Imóvel">
          <select value={tipoImovel} onChange={(e) => setTipoImovel(e.target.value)} className={inputClass}>
            <option>Residencial urbano</option>
            <option>Comercial</option>
            <option>Rural</option>
            <option>Terreno</option>
          </select>
        </Field>
        <Field label="Valor/m² Estimado (R$)">
          <input
            type="number"
            value={valorM2}
            onChange={(e) => setValorM2(e.target.value)}
            className={inputClass}
            placeholder="4.200,00"
          />
        </Field>
      </div>

      <button
        onClick={gerar}
        className="mt-4 rounded bg-brass px-5 py-2 text-sm font-medium text-ink-900 hover:bg-brass-light transition-colors"
      >
        Gerar Parecer Técnico (NBR 14653)
      </button>

      {resultado !== null && (
        <ResultCard>
          <p className="text-xs uppercase tracking-wide text-ink-300">Valor estimado do imóvel</p>
          <p className="mt-1 font-display text-xl text-parchment">{currency.format(resultado)}</p>
          <p className="mt-1 text-xs text-ink-300">
            Avaliação preliminar por comparação direta de mercado — o parecer técnico completo segue a
            metodologia da NBR 14653 com vistoria e homogeneização de dados.
          </p>
        </ResultCard>
      )}
      <Disclaimer />
    </div>
  );
}
