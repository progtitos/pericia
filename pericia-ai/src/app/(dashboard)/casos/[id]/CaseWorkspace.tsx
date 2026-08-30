"use client";

import { useState } from "react";
import { FileUploader } from "@/components/upload/FileUploader";
import { DemonstrativoTable } from "@/components/calc/DemonstrativoTable";
import { extrairTextoDoPdfClient } from "@/lib/pdf-reader";
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

interface StatusProcessamento {
  progresso: number;
  mensagem: string;
  tempoRestanteSegundos: number;
  status: "processing" | "done" | "error";
}

export function CaseWorkspace({ caseId, caseType }: { caseId: string; caseType: string }) {
  const [faseAtiva, setFaseAtiva] = useState<(typeof FASES)[number]>("Triagem");

  const [triagem, setTriagem] = useState<ProcessoTriagemExtraido | null>(null);
  const [triagemLoading, setTriagemLoading] = useState(false);
  const [triagemErro, setTriagemErro] = useState<string | null>(null);
  const [triagemTokenPreview, setTriagemTokenPreview] = useState<TokenPreviewInfo | null>(null);
  
  const [progressoStatus, setProgressoStatus] = useState<StatusProcessamento | null>(null);

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

  const [params, setParams] = useState({
    rmi: "",
    dib: "",
    data_citacao: "",
    data_base_calculo: "",
    indice_ate_112021: "IPCA-E" as "IPCA-E" | "INPC",
  });

  // Manipulador atualizado para receber o texto já extraído pelo FileUploader
  async function handleProcessoUploaded(
    file: File,
    textoExtraido?: string,
    tokenPreview?: TokenPreviewInfo
  ) {
    setTriagemTokenPreview(tokenPreview ?? null);
    setTriagemLoading(true);
    setTriagemErro(null);

    try {
      let textoParaEnvio = textoExtraido;

      // Caso o texto não venha pronto do uploader, extrai no navegador aqui
      if (!textoParaEnvio) {
        setProgressoStatus({
          progresso: 10,
          mensagem: "Lendo páginas do PDF no navegador...",
          tempoRestanteSegundos: 0,
          status: "processing",
        });

        const resExtracao = await extrairTextoDoPdfClient(
          file,
          (porcentagem, paginasLidas, totalPaginas) => {
            setProgressoStatus({
              progresso: Math.round(porcentagem * 0.8),
              mensagem: `Lendo PDF (${paginasLidas}/${totalPaginas} págs)...`,
              tempoRestanteSegundos: Math.ceil((totalPaginas - paginasLidas) * 0.02),
              status: "processing",
            });
          }
        );
        textoParaEnvio = resExtracao.textoCompleto;
      }

      setProgressoStatus({
        progresso: 90,
        mensagem: "Enviando texto extraído para a Inteligência Artificial Gemini...",
        tempoRestanteSegundos: 3,
        status: "processing",
      });

      // Envia a string contendo o texto extraído do PDF
      const res = await fetch("/api/gemini/extract-processo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto: textoParaEnvio, caseId }),
      });

      const json = await res.json();

      if (!res.ok) {
        if (json.code === "TOKEN_LIMIT_EXCEEDED") {
          showToast(json.error, "erro");
          setTriagemLoading(false);
          setProgressoStatus(null);
          return;
        }
        throw new Error(json.error || "Falha na análise do processo.");
      }

      if (json.resultado) {
        setTriagem(json.resultado);
        setProgressoStatus({
          progresso: 100,
          mensagem: "Processamento concluído com sucesso!",
          tempoRestanteSegundos: 0,
          status: "done",
        });
      }
    } catch (err: any) {
      console.error("Erro no processamento:", err);
      setTriagemErro(err.message || "Erro durante o processamento do PDF.");
      showToast(err.message || "Erro no processamento do documento.", "erro");
      setProgressoStatus(null);
    } finally {
      setTriagemLoading(false);
    }
  }

  async function handleExtratoUploaded(file: File) {
    setExtratoLoading(true);
    try {
      const { textoCompleto } = await extrairTextoDoPdfClient(file);
      const res = await fetch("/api/gemini/extract-extrato", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto: textoCompleto, caseId }),
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

            {triagemLoading && progressoStatus && (
              <div className="w-full p-4 border rounded-lg bg-slate-50 border-ink-100 space-y-2">
                <div className="flex justify-between text-sm font-medium text-ink-700">
                  <span>{progressoStatus.mensagem}</span>
                  <span>{progressoStatus.progresso}%</span>
                </div>

                <div className="w-full bg-slate-200 rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-brass h-full transition-all duration-300"
                    style={{ width: `${progressoStatus.progresso}%` }}
                  />
                </div>
              </div>
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
            {extratoLoading && <p className="text-sm text-ink-500">Executando reconciliação...</p>}
            {reconciliacao && (
              <div
                className={`rounded border p-5 ${
                  reconciliacao.consistente
                    ? "border-seal-green/30 bg-seal-green/5"
                    : "border-seal-red/30 bg-seal-red/5"
                }`}
              >
                <p className="font-display text-ink">
                  {reconciliacao.consistente ? "Saldo conferido" : "Divergência de saldo"}
                </p>
              </div>
            )}
          </div>
        )}

        {faseAtiva === "Cálculo" && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 rounded border border-ink-100 bg-white p-5">
              <NumField label="RMI" value={params.rmi} onChange={(v) => setParams({ ...params, rmi: v })} />
              <DateField label="DIB" value={params.dib} onChange={(v) => setParams({ ...params, dib: v })} />
              <DateField
                label="Data da citação"
                value={params.data_citacao}
                onChange={(v) => setParams({ ...params, data_citacao: v })}
              />
              <DateField
                label="Data-base do cálculo"
                value={params.data_base_calculo}
                onChange={(v) => setParams({ ...params, data_base_calculo: v })}
              />
            </div>

            <button
              onClick={handleRunCalculo}
              disabled={calculoLoading}
              className="rounded bg-ink px-5 py-2.5 font-medium text-parchment hover:bg-ink-700 disabled:opacity-60"
            >
              {calculoLoading ? "Calculando..." : "Executar recálculo"}
            </button>

            {resultadoCalculo && (
              <DemonstrativoTable competencias={resultadoCalculo.competencias} />
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
              {laudoLoading ? "Redigindo..." : "Gerar minuta do laudo"}
            </button>

            {laudoMarkdown && (
              <article className="prose max-w-none rounded border border-ink-100 bg-white p-6 whitespace-pre-wrap">
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

function Toast({ message, tone, onClose }: { message: string; tone: "erro" | "info"; onClose: () => void }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 max-w-sm rounded border bg-white p-4 shadow-lg flex justify-between gap-4">
      <p className="text-sm">{message}</p>
      <button onClick={onClose} className="font-bold">×</button>
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
        className="w-full rounded border border-ink-100 px-3 py-2"
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