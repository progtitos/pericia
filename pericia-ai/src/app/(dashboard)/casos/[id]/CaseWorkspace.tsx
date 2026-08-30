"use client";

import { useState } from "react";
import { FileUploader } from "@/components/upload/FileUploader";
import { DemonstrativoTable } from "@/components/calc/DemonstrativoTable";
import type {
  ProcessoTriagemExtraido,
  ReconciliacaoResultado,
  ResultadoCalculoPrevidenciario,
  TokenPreviewInfo,
} from "@/lib/types";

const FASES = ["Triagem", "Extratos", "Cálculo", "Laudo"] as const;

interface ToastState {
  message: string;
  tone: "erro" | "info";
}

export function CaseWorkspace({ caseId, caseType }: { caseId: string; caseType: string }) {
  const [faseAtiva, setFaseAtiva] = useState<(typeof FASES)[number]>("Triagem");

  const [triagem, setTriagem] = useState<ProcessoTriagemExtraido | null>(null);
  const [triagemLoading, setTriagemLoading] = useState(false);
  const [triagemErro, setTriagemErro] = useState<string | null>(null);
  const [triagemTokenPreview, setTriagemTokenPreview] = useState<TokenPreviewInfo | null>(null);

  const [reconciliacao, setReconciliacao] = useState<ReconciliacaoResultado | null>(null);
  const [extratoLoading, setExtratoLoading] = useState(false);

  const [resultadoCalculo, setResultadoCalculo] = useState<ResultadoCalculoPrevidenciario | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [calculoLoading, setCalculoLoading] = useState(false);
  const [calculoErro, setCalculoErro] = useState<string | null>(null);

  const [laudoMarkdown, setLaudoMarkdown] = useState<string | null>(null);
  const [laudoLoading, setLaudoLoading] = useState(false);

  const [toast, setToast] = useState<ToastState | null>(null);

  function showToast(message: string, tone: ToastState["tone"] = "erro") {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 7000);
  }

  // Parâmetros mínimos do cálculo previdenciário (viriam pré-preenchidos da triagem).
  const [params, setParams] = useState({
    rmi: "",
    dib: "",
    data_citacao: "",
    data_base_calculo: "",
    indice_ate_112021: "IPCA-E" as "IPCA-E" | "INPC",
  });

  async function handleProcessoUploaded(documentId: string, tokenPreview?: TokenPreviewInfo) {
    setTriagemTokenPreview(tokenPreview ?? null);
    setTriagemLoading(true);
    setTriagemErro(null);
    try {
      const res = await fetch("/api/gemini/extract-processo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, caseId }),
      });
      const json = await res.json();
      if (!res.ok) {
        // Erro de excedimento de tokens: mostra como Toast estilizado em vez
        // de mensagem inline, conforme o tratamento elegante de erro pedido.
        if (json.code === "TOKEN_LIMIT_EXCEEDED") {
          showToast(json.error, "erro");
          return;
        }
        throw new Error(json.error);
      }
      setTriagem(json.data);
      setParams((p) => ({
        ...p,
        rmi: json.data.rmi?.toString() ?? "",
        dib: json.data.dib ?? "",
        data_citacao: json.data.data_citacao ?? "",
      }));
    } catch (err: any) {
      setTriagemErro(err.message);
    } finally {
      setTriagemLoading(false);
    }
  }

  async function handleExtratoUploaded(documentId: string) {
    setExtratoLoading(true);
    try {
      const res = await fetch("/api/gemini/extract-extrato", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, caseId, mimeType: "application/pdf" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setReconciliacao(json.reconciliacao);
    } catch (err: any) {
      setReconciliacao(null);
      showToast(err.message);
    } finally {
      setExtratoLoading(false);
    }
  }

  async function handleRunCalculo() {
    setCalculoLoading(true);
    setCalculoErro(null);
    try {
      const res = await fetch("/api/calculo/demonstrativo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          parametros: {
            rmi: parseFloat(params.rmi),
            dib: params.dib,
            data_citacao: params.data_citacao,
            data_base_calculo: params.data_base_calculo,
            indice_ate_112021: params.indice_ate_112021,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setResultadoCalculo(json.resultado);
      setRunId(json.runId);
    } catch (err: any) {
      setCalculoErro(err.message);
    } finally {
      setCalculoLoading(false);
    }
  }

  async function handleGerarLaudo() {
    if (!runId) return;
    setLaudoLoading(true);
    try {
      const res = await fetch("/api/gemini/gerar-laudo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, runId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setLaudoMarkdown(json.draft.content_markdown);
    } catch (err: any) {
      showToast(err.message);
    } finally {
      setLaudoLoading(false);
    }
  }

  return (
    <div>
      <div className="flex gap-1 border-b border-ink-100">
        {FASES.map((f) => (
          <button
            key={f}
            onClick={() => setFaseAtiva(f)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              faseAtiva === f
                ? "border-brass text-ink"
                : "border-transparent text-ink-500 hover:text-ink"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {faseAtiva === "Triagem" && (
          <div className="space-y-6">
            <FileUploader
              caseId={caseId}
              fileType="processo_pdf"
              label="Enviar PDF do processo (petição, sentença, acórdão)"
              accept="application/pdf"
              showTokenPreview
              onUploaded={handleProcessoUploaded}
            />
            {triagemLoading && (
              <p className="text-sm text-ink-500">
                {triagemTokenPreview?.exigeChunking
                  ? "Processando em modo de Análise por Camadas — isso pode levar alguns minutos para documentos extensos…"
                  : "Analisando processo com IA…"}
              </p>
            )}
            {triagemErro && <p className="text-sm text-seal-red">{triagemErro}</p>}
            {triagem && (
              <div className="rounded border border-ink-100 bg-white p-5">
                <h3 className="font-display text-ink">Dados extraídos</h3>
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <Field label="Processo" value={triagem.numero_processo} />
                  <Field label="Vara" value={triagem.vara} />
                  <Field label="Autor" value={triagem.autor} />
                  <Field label="Réu" value={triagem.reu} />
                  <Field label="DIB" value={triagem.dib} />
                  <Field label="DER" value={triagem.der} />
                  <Field label="RMI" value={triagem.rmi?.toString() ?? null} mono />
                  <Field label="Índice determinado" value={triagem.indice_determinado_pelo_juiz} />
                </dl>

                {triagem._chunking_info && (
                  <div className="mt-4 rounded border border-brass/30 bg-brass/5 p-3">
                    <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-brass-dark">
                      <span className="selo-pericial !border-brass !text-brass !w-6 !h-6 !text-[8px]">
                        {triagem._chunking_info.totalBlocos}
                      </span>
                      Processado em {triagem._chunking_info.totalBlocos} camadas
                    </p>
                    <table className="mt-3 w-full text-xs">
                      <thead>
                        <tr className="text-left text-ink-500">
                          <th className="pb-1 font-medium">Bloco</th>
                          <th className="pb-1 font-medium">Páginas</th>
                          <th className="pb-1 font-medium text-right">Tokens (est.)</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-figures">
                        {triagem._chunking_info.blocos.map((b) => (
                          <tr key={b.indice} className="linha-ledger">
                            <td className="py-1 font-body">{b.rotulo}</td>
                            <td className="py-1">
                              {b.paginaInicial}–{b.paginaFinal}
                            </td>
                            <td className="py-1 text-right">{b.tokensEstimados.toLocaleString("pt-BR")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {triagem.observacoes_para_conferencia_humana?.length > 0 && (
                  <div className="mt-4 rounded border border-seal-red/30 bg-seal-red/5 p-3">
                    <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-seal-red">
                      <span className="selo-pericial selo-pericial--alerta !w-6 !h-6 !text-[8px]">!</span>
                      Conferência humana obrigatória
                    </p>
                    <ul className="mt-2 list-disc pl-5 text-sm text-ink-700">
                      {triagem.observacoes_para_conferencia_humana.map((o, i) => (
                        <li key={i}>{o}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {faseAtiva === "Extratos" && (
          <div className="space-y-6">
            <FileUploader
              caseId={caseId}
              fileType="extrato_pdf"
              label="Enviar extrato bancário (PDF)"
              accept="application/pdf"
              onUploaded={handleExtratoUploaded}
            />
            {extratoLoading && <p className="text-sm text-ink-500">Executando OCR e reconciliação…</p>}
            {reconciliacao && (
              <div
                className={`rounded border p-5 ${
                  reconciliacao.consistente
                    ? "border-seal-green/30 bg-seal-green/5"
                    : "border-seal-red/30 bg-seal-red/5"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`selo-pericial ${
                      reconciliacao.consistente ? "selo-pericial--conferido" : "selo-pericial--alerta"
                    }`}
                  >
                    {reconciliacao.consistente ? "OK" : "!"}
                  </span>
                  <div>
                    <p className="font-display text-ink">
                      {reconciliacao.consistente
                        ? "Saldo conferido"
                        : "Divergência de saldo — conferência obrigatória"}
                    </p>
                    <p className="text-xs text-ink-500">
                      Saldo inicial + entradas − saídas = {" "}
                      <span className="tabular-figures">{reconciliacao.saldo_final_calculado}</span>
                      {reconciliacao.saldo_final_informado !== null && (
                        <>
                          {" "}
                          · informado no extrato: {" "}
                          <span className="tabular-figures">{reconciliacao.saldo_final_informado}</span>
                        </>
                      )}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {faseAtiva === "Cálculo" && (
          <div className="space-y-6">
            {caseType !== "previdenciario" && (
              <p className="text-sm text-ink-500">
                Este demonstrativo cobre o fluxo previdenciário. Para casos bancários, use o
                comparador Price × SAC (motor em lib/calc/price-sac.ts) na tela de contrato.
              </p>
            )}
            <div className="grid grid-cols-2 gap-4 rounded border border-ink-100 bg-white p-5">
              <NumField label="RMI" value={params.rmi} onChange={(v) => setParams({ ...params, rmi: v })} />
              <DateField label="DIB" value={params.dib} onChange={(v) => setParams({ ...params, dib: v })} />
              <DateField
                label="Data da citação"
                value={params.data_citacao}
                onChange={(v) => setParams({ ...params, data_citacao: v })}
              />
              <DateField
                label="Data-base do cálculo (sentença/decisão)"
                value={params.data_base_calculo}
                onChange={(v) => setParams({ ...params, data_base_calculo: v })}
              />
              <label className="col-span-2 block">
                <span className="mb-1 block text-sm font-medium text-ink-700">Índice até 11/2021</span>
                <select
                  value={params.indice_ate_112021}
                  onChange={(e) =>
                    setParams({ ...params, indice_ate_112021: e.target.value as "IPCA-E" | "INPC" })
                  }
                  className="w-full rounded border border-ink-100 px-3 py-2"
                >
                  <option value="IPCA-E">IPCA-E</option>
                  <option value="INPC">INPC</option>
                </select>
              </label>
            </div>

            <button
              onClick={handleRunCalculo}
              disabled={calculoLoading}
              className="rounded bg-ink px-5 py-2.5 font-medium text-parchment hover:bg-ink-700 disabled:opacity-60"
            >
              {calculoLoading ? "Calculando…" : "Executar recálculo (IPCA-E/INPC + SELIC pós-EC113)"}
            </button>
            {calculoErro && <p className="text-sm text-seal-red">{calculoErro}</p>}

            {resultadoCalculo && (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <SummaryCard label="Valor Total Bruto" value={resultadoCalculo.valor_total_bruto} />
                  <SummaryCard
                    label="Honorários (Súmula 111/STJ)"
                    value={resultadoCalculo.honorarios_sucumbenciais}
                  />
                  <SummaryCard
                    label="Valor Líquido Final"
                    value={resultadoCalculo.valor_liquido_final}
                    highlight
                  />
                </div>
                <DemonstrativoTable competencias={resultadoCalculo.competencias} />
              </div>
            )}
          </div>
        )}

        {faseAtiva === "Laudo" && (
          <div className="space-y-6">
            <button
              onClick={handleGerarLaudo}
              disabled={!runId || laudoLoading}
              className="rounded bg-ink px-5 py-2.5 font-medium text-parchment hover:bg-ink-700 disabled:opacity-60"
            >
              {laudoLoading
                ? "Redigindo minuta…"
                : runId
                ? "Gerar minuta do laudo"
                : "Execute o cálculo antes de gerar a minuta"}
            </button>

            {laudoMarkdown && (
              <article className="prose prose-sm max-w-none rounded border border-ink-100 bg-white p-6 font-body whitespace-pre-wrap">
                {laudoMarkdown}
              </article>
            )}
          </div>
        )}
      </div>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}

function Toast({
  message,
  tone,
  onClose,
}: {
  message: string;
  tone: "erro" | "info";
  onClose: () => void;
}) {
  const styles =
    tone === "erro"
      ? "border-seal-red/30 bg-white text-ink"
      : "border-ink-100 bg-white text-ink";
  const iconStyle = tone === "erro" ? "selo-pericial--alerta" : "selo-pericial--conferido";

  return (
    <div className="fixed bottom-6 right-6 z-50 max-w-sm">
      <div className={`flex items-start gap-3 rounded border shadow-lg p-4 ${styles}`}>
        <span className={`selo-pericial ${iconStyle} !w-8 !h-8 !text-[9px] shrink-0`}>
          {tone === "erro" ? "!" : "OK"}
        </span>
        <p className="text-sm">{message}</p>
        <button
          onClick={onClose}
          className="ml-auto shrink-0 text-ink-300 hover:text-ink-700"
          aria-label="Fechar"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className={`text-ink ${mono ? "tabular-figures" : ""}`}>{value ?? "—"}</dd>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700">{label}</span>
      <input
        type="number"
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-ink-100 px-3 py-2 tabular-figures"
      />
    </label>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-ink-100 px-3 py-2"
      />
    </label>
  );
}

function SummaryCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  return (
    <div
      className={`rounded border p-4 ${
        highlight ? "border-brass bg-brass/5" : "border-ink-100 bg-white"
      }`}
    >
      <p className="text-xs uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1 font-display text-xl tabular-figures text-ink">{currency.format(value)}</p>
    </div>
  );
}
