"use client";

import { useMemo, useRef, useState } from "react";
import { FileUploader } from "@/components/upload/FileUploader";
import { DemonstrativoTable } from "@/components/calc/DemonstrativoTable";
import { createClient } from "@/lib/supabase/client";
import type {
  ProcessoTriagemExtraido,
  ReconciliacaoResultado,
  ResultadoCalculoPrevidenciario,
} from "@/lib/types";

interface ToastState {
  message: string;
  tone: "sucesso" | "erro" | "info";
}

// Seções do fluxo contínuo (substituem as antigas abas isoladas). Usadas
// apenas para a navegação-âncora do topo — todo o conteúdo fica sempre
// montado e visível, nada é escondido por troca de aba.
const SECOES = [
  { id: "sec-triagem", label: "Triagem" },
  { id: "sec-calculo", label: "Cálculo & Reconciliação" },
  { id: "sec-laudo", label: "Laudo" },
] as const;

// Mensagem amigável e genérica para falhas de servidor/sobrecarga — usada
// independentemente do texto técnico que a API retornar, para nunca expor
// erro cru de SDK/infra na tela do perito.
const MENSAGEM_SERVIDOR_OCUPADO = "Servidor ocupado. Tente novamente em alguns segundos.";

function paraInputDate(valor: string | null | undefined): string {
  if (!valor) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
  const match = valor.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return "";
}

function derivarIndice(indiceTexto: string | null): "IPCA-E" | "INPC" {
  return indiceTexto?.toUpperCase().includes("INPC") ? "INPC" : "IPCA-E";
}

/** Extrai uma mensagem amigável de uma resposta de API que falhou — usa o
 *  texto genérico pedido para 429/500 (sobrecarga transitória) e preserva
 *  mensagens específicas do backend para os demais casos (ex.: validação). */
async function extrairMensagemErro(res: Response): Promise<string> {
  let corpo: any = null;
  try {
    corpo = await res.json();
  } catch {
    /* resposta sem corpo JSON — segue com a mensagem genérica por status */
  }

  if (res.status === 429 || res.status === 500) {
    return MENSAGEM_SERVIDOR_OCUPADO;
  }
  return corpo?.error || MENSAGEM_SERVIDOR_OCUPADO;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function CaseWorkspace({ caseId, caseType }: { caseId: string; caseType: string }) {
  const supabase = createClient();
  const refs = {
    "sec-triagem": useRef<HTMLDivElement>(null),
    "sec-calculo": useRef<HTMLDivElement>(null),
    "sec-laudo": useRef<HTMLDivElement>(null),
  };

  function scrollPara(id: keyof typeof refs) {
    refs[id].current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------------------------------------------------------------------
  // "triagem" é a fonte única de verdade dos dados extraídos do processo.
  // Os campos do Cálculo (RMI, DIB, Citação) são DERIVADOS dela (useMemo),
  // nunca duplicados — impossível ficar dessincronizado.
  // ---------------------------------------------------------------------
  const [triagem, setTriagem] = useState<ProcessoTriagemExtraido | null>(null);
  const [triagemLoading, setTriagemLoading] = useState(false);
  const [triagemErro, setTriagemErro] = useState<string | null>(null);
  const [progresso, setProgresso] = useState(0);

  // Guardamos o último arquivo + texto extraído para permitir "Tentar
  // novamente" sem obrigar o perito a selecionar o PDF de novo.
  const [ultimoFile, setUltimoFile] = useState<File | null>(null);
  const [ultimoTexto, setUltimoTexto] = useState<string | null>(null);
  // Texto completo do processo (com marcadores [[FLS. N]]) — persistido
  // junto da triagem para permitir citação de folha exata no laudo.
  const [textoPaginado, setTextoPaginado] = useState<string | null>(null);

  const [dataBaseCalculo, setDataBaseCalculo] = useState("");
  const [indiceOverride, setIndiceOverride] = useState<"IPCA-E" | "INPC" | null>(null);

  const [reconciliacao, setReconciliacao] = useState<ReconciliacaoResultado | null>(null);
  const [extratoLoading, setExtratoLoading] = useState(false);

  const [resultadoCalculo, setResultadoCalculo] = useState<ResultadoCalculoPrevidenciario | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [calculoLoading, setCalculoLoading] = useState(false);
  const [calculoErro, setCalculoErro] = useState<string | null>(null);

  const [laudoMarkdown, setLaudoMarkdown] = useState<string | null>(null);
  const [laudoLoading, setLaudoLoading] = useState(false);

  const [baixandoPlanilha, setBaixandoPlanilha] = useState(false);

  const [toast, setToast] = useState<ToastState | null>(null);

  function showToast(message: string, tone: ToastState["tone"] = "erro") {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 6000);
  }

  const paramsCalculo = useMemo(
    () => ({
      rmi: triagem?.rmi != null ? String(triagem.rmi) : "",
      dib: paraInputDate(triagem?.dib),
      data_citacao: paraInputDate(triagem?.data_citacao),
      data_base_calculo: dataBaseCalculo,
      indice_ate_112021: indiceOverride ?? derivarIndice(triagem?.indice_determinado_pelo_juiz ?? null),
    }),
    [triagem, dataBaseCalculo, indiceOverride]
  );

  function atualizarCampoTriagem<K extends keyof ProcessoTriagemExtraido>(
    campo: K,
    valor: ProcessoTriagemExtraido[K]
  ) {
    setTriagem((prev) => (prev ? { ...prev, [campo]: valor } : prev));
  }

  /** Persiste a triagem (+ texto paginado, quando houver) em
   *  forensic_cases.metadata — é de lá que /api/claude/gerar-laudo lê o
   *  contexto (inclusive para citar fls.) na hora de escrever a minuta. */
  async function persistirMetadadosDoCaso(dados: ProcessoTriagemExtraido, textoCompleto?: string | null) {
    try {
      const metadata = textoCompleto ? { ...dados, _texto_paginado: textoCompleto } : dados;
      await supabase.from("forensic_cases").update({ metadata, status: "calculo" }).eq("id", caseId);
    } catch {
      // Falha silenciosa aqui não deve travar o fluxo do perito na tela.
    }
  }

  async function executarTriagem(file: File, texto: string) {
    setTriagemLoading(true);
    setTriagemErro(null);
    setProgresso(90);

    try {
      const res = await fetch("/api/claude/extract-processo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto, caseId }),
      });

      if (!res.ok) {
        const mensagem = await extrairMensagemErro(res);
        throw new Error(mensagem);
      }

      const json = await res.json();
      if (!json.resultado) throw new Error(MENSAGEM_SERVIDOR_OCUPADO);

      setProgresso(100);

      const dadosNormalizados: ProcessoTriagemExtraido = {
        ...json.resultado,
        dib: paraInputDate(json.resultado.dib) || json.resultado.dib,
        der: paraInputDate(json.resultado.der) || json.resultado.der,
        data_citacao: paraInputDate(json.resultado.data_citacao) || json.resultado.data_citacao,
      };

      setTriagem(dadosNormalizados);
      setTextoPaginado(texto);
      showToast("Dados extraídos do PDF com sucesso!", "sucesso");

      await persistirMetadadosDoCaso(dadosNormalizados, texto);
      scrollPara("sec-calculo");
    } catch (err: any) {
      const mensagem = err?.message || MENSAGEM_SERVIDOR_OCUPADO;
      setTriagemErro(mensagem);
      showToast(mensagem, "erro");
    } finally {
      setTriagemLoading(false);
      setProgresso(0);
    }
  }

  function handleProcessoUploaded(file: File, textoExtraido?: string) {
    setUltimoFile(file);
    setUltimoTexto(textoExtraido ?? null);
    if (textoExtraido) executarTriagem(file, textoExtraido);
  }

  function handleTentarNovamente() {
    if (ultimoFile && ultimoTexto) executarTriagem(ultimoFile, ultimoTexto);
  }

  function handleTrocarArquivo() {
    setTriagem(null);
    setTriagemErro(null);
    setUltimoFile(null);
    setUltimoTexto(null);
  }

  async function handleExtratoUploaded(file: File, textoExtraido?: string) {
    if (!textoExtraido) return;
    setExtratoLoading(true);
    try {
      const res = await fetch("/api/claude/extract-extrato", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto: textoExtraido, caseId }),
      });
      if (!res.ok) throw new Error(await extrairMensagemErro(res));
      const json = await res.json();
      setReconciliacao(json.reconciliacao);
    } catch (err: any) {
      setReconciliacao(null);
      showToast(err.message || MENSAGEM_SERVIDOR_OCUPADO, "erro");
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
            rmi: parseFloat(paramsCalculo.rmi),
            dib: paramsCalculo.dib,
            data_citacao: paramsCalculo.data_citacao,
            data_base_calculo: paramsCalculo.data_base_calculo,
            indice_ate_112021: paramsCalculo.indice_ate_112021,
          },
        }),
      });
      if (!res.ok) throw new Error(await extrairMensagemErro(res));
      const json = await res.json();
      setResultadoCalculo(json.resultado);
      setRunId(json.runId);
      scrollPara("sec-laudo");
    } catch (err: any) {
      setCalculoErro(err.message || MENSAGEM_SERVIDOR_OCUPADO);
    } finally {
      setCalculoLoading(false);
    }
  }

  async function handleGerarLaudo() {
    if (!runId) return;
    setLaudoLoading(true);
    try {
      if (triagem) await persistirMetadadosDoCaso(triagem, textoPaginado);

      const res = await fetch("/api/claude/gerar-laudo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, runId }),
      });
      if (!res.ok) throw new Error(await extrairMensagemErro(res));
      const json = await res.json();
      setLaudoMarkdown(json.draft.content_markdown);
    } catch (err: any) {
      showToast(err.message || MENSAGEM_SERVIDOR_OCUPADO, "erro");
    } finally {
      setLaudoLoading(false);
    }
  }

  async function handleBaixarPlanilha() {
    setBaixandoPlanilha(true);
    try {
      const res = await fetch("/api/export/planilha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triagem, resultadoCalculo, reconciliacao }),
      });
      if (!res.ok) throw new Error(await extrairMensagemErro(res));
      const blob = await res.blob();
      const nomeProcesso = triagem?.numero_processo?.replace(/[^\w.-]/g, "_") || "processo";
      downloadBlob(blob, `calculo-pericial-${nomeProcesso}.xlsx`);
    } catch (err: any) {
      showToast(err.message || MENSAGEM_SERVIDOR_OCUPADO, "erro");
    } finally {
      setBaixandoPlanilha(false);
    }
  }

  const statusSecoes = {
    "sec-triagem": triagem ? "ok" : triagemLoading ? "andamento" : "pendente",
    "sec-calculo": resultadoCalculo ? "ok" : "pendente",
    "sec-laudo": laudoMarkdown ? "ok" : "pendente",
  } as const;

  return (
    <div className="pb-24">
      <nav className="sticky top-0 z-10 -mx-10 mb-8 flex gap-1 border-b border-ink-100 bg-parchment/95 px-10 py-2 backdrop-blur">
        {SECOES.map((s) => (
          <button
            key={s.id}
            onClick={() => scrollPara(s.id)}
            className="flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-parchment-dim transition-colors"
          >
            <StatusDot status={statusSecoes[s.id]} />
            {s.label}
          </button>
        ))}
      </nav>

      <div className="space-y-14">
        {/* ---------------- BLOCO 1 — Upload & Triagem ---------------- */}
        <section ref={refs["sec-triagem"]} id="sec-triagem" className="scroll-mt-20">
          <SectionHeader
            numero={1}
            titulo="Upload & Triagem do Processo"
            descricao="Envie o PDF do processo. A leitura acontece no seu navegador; a IA analisa e você valida os dados antes de seguir."
          />

          <div className="mt-5 space-y-6">
            {/* Área de upload/progresso some assim que a triagem é concluída
                com sucesso — só o painel de dados extraídos permanece. */}
            {!triagem && (
              <>
                <FileUploader
                  caseId={caseId}
                  fileType="processo_pdf"
                  label="Enviar PDF do processo (petição, sentença, acórdão)"
                  accept="application/pdf"
                  extrairTexto
                  onUploaded={handleProcessoUploaded}
                />

                {triagemLoading && (
                  <div className="w-full space-y-2 rounded-lg border border-ink-100 bg-parchment-dim/60 p-4">
                    <div className="flex justify-between text-sm font-medium text-ink-700">
                      <span>Analisando autos do processo...</span>
                      <span>{progresso}%</span>
                    </div>
                    <div className="h-3 w-full overflow-hidden rounded-full bg-ink-50">
                      <div
                        className="h-full bg-brass transition-all duration-300"
                        style={{ width: `${progresso}%` }}
                      />
                    </div>
                  </div>
                )}

                {triagemErro && !triagemLoading && (
                  <div className="flex items-center justify-between rounded border border-seal-red/30 bg-seal-red/5 p-3">
                    <p className="text-sm text-seal-red">{triagemErro}</p>
                    {ultimoFile && ultimoTexto && (
                      <button
                        onClick={handleTentarNovamente}
                        className="ml-4 shrink-0 rounded bg-ink px-3 py-1.5 text-xs font-medium text-parchment hover:bg-ink-700"
                      >
                        Reenviar
                      </button>
                    )}
                  </div>
                )}
              </>
            )}

            {triagem && (
              <div className="rounded border border-ink-100 bg-white p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-ink">Dados Extraídos</h3>
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] uppercase tracking-wide text-ink-500">
                      Editável — confira antes de calcular
                    </span>
                    <button
                      onClick={handleTrocarArquivo}
                      className="text-[11px] font-medium text-brass-dark underline hover:text-brass"
                    >
                      Analisar outro PDF
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <EditableField
                    label="Número do processo"
                    value={triagem.numero_processo ?? ""}
                    onChange={(v) => atualizarCampoTriagem("numero_processo", v || null)}
                  />
                  <EditableField
                    label="Vara"
                    value={triagem.vara ?? ""}
                    onChange={(v) => atualizarCampoTriagem("vara", v || null)}
                  />
                  <EditableField
                    label="Autor"
                    value={triagem.autor ?? ""}
                    onChange={(v) => atualizarCampoTriagem("autor", v || null)}
                  />
                  <EditableField
                    label="Réu"
                    value={triagem.reu ?? ""}
                    onChange={(v) => atualizarCampoTriagem("reu", v || null)}
                  />
                  <EditableField
                    label="DIB"
                    type="date"
                    value={paraInputDate(triagem.dib)}
                    onChange={(v) => atualizarCampoTriagem("dib", v || null)}
                  />
                  <EditableField
                    label="DER"
                    type="date"
                    value={paraInputDate(triagem.der)}
                    onChange={(v) => atualizarCampoTriagem("der", v || null)}
                  />
                  <EditableField
                    label="Data da citação"
                    type="date"
                    value={paraInputDate(triagem.data_citacao)}
                    onChange={(v) => atualizarCampoTriagem("data_citacao", v || null)}
                  />
                  <EditableField
                    label="RMI"
                    type="number"
                    value={triagem.rmi != null ? String(triagem.rmi) : ""}
                    onChange={(v) => atualizarCampoTriagem("rmi", v ? parseFloat(v) : null)}
                    mono
                  />
                  <EditableField
                    label="Índice determinado"
                    value={triagem.indice_determinado_pelo_juiz ?? ""}
                    onChange={(v) => atualizarCampoTriagem("indice_determinado_pelo_juiz", v || null)}
                  />
                </div>

                {(triagem.quesitos.autor.length > 0 ||
                  triagem.quesitos.juiz.length > 0 ||
                  triagem.quesitos.reu.length > 0) && (
                  <div className="mt-5 border-t border-ink-100 pt-4">
                    <p className="text-xs uppercase tracking-wide text-ink-500">
                      Quesitos identificados no documento
                    </p>
                    <div className="mt-2 grid grid-cols-3 gap-3 text-xs text-ink-700">
                      <QuesitosResumo titulo="Autor" itens={triagem.quesitos.autor} />
                      <QuesitosResumo titulo="Juízo" itens={triagem.quesitos.juiz} />
                      <QuesitosResumo titulo="Réu" itens={triagem.quesitos.reu} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ------- BLOCO 2 — Parâmetros de Cálculo & Reconciliação ------- */}
        <section ref={refs["sec-calculo"]} id="sec-calculo" className="scroll-mt-20">
          <SectionHeader
            numero={2}
            titulo="Parâmetros de Cálculo & Reconciliação"
            descricao={
              triagem
                ? "Os campos abaixo já vieram preenchidos com o que foi validado na Triagem — ajuste se precisar."
                : "Preencha manualmente ou envie o PDF na etapa anterior para preencher automaticamente."
            }
          />

          <div className="mt-5 space-y-6">
            <div className="rounded border border-ink-100 bg-white p-5">
              <h4 className="font-display text-sm text-ink">Conciliação de Extrato Bancário (opcional)</h4>
              <div className="mt-3">
                <FileUploader
                  caseId={caseId}
                  fileType="extrato_pdf"
                  label="Enviar extrato bancário (PDF)"
                  accept="application/pdf"
                  extrairTexto
                  onUploaded={handleExtratoUploaded}
                />
              </div>
              {extratoLoading && <p className="mt-3 text-sm text-ink-500">Executando reconciliação...</p>}
              {reconciliacao && (
                <div
                  className={`mt-3 rounded border p-4 ${
                    reconciliacao.consistente
                      ? "border-seal-green/30 bg-seal-green/5"
                      : "border-seal-red/30 bg-seal-red/5"
                  }`}
                >
                  <p className="font-display text-sm text-ink">
                    {reconciliacao.consistente ? "Saldo conferido" : "Divergência de saldo"}
                  </p>
                </div>
              )}
            </div>

            <div className="rounded border border-ink-100 bg-white p-5">
              <h4 className="font-display text-sm text-ink">Parâmetros do Recálculo Previdenciário</h4>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <EditableField
                  label="RMI"
                  type="number"
                  value={paramsCalculo.rmi}
                  onChange={(v) => atualizarCampoTriagem("rmi", v ? parseFloat(v) : null)}
                  mono
                />
                <EditableField
                  label="DIB"
                  type="date"
                  value={paramsCalculo.dib}
                  onChange={(v) => atualizarCampoTriagem("dib", v || null)}
                />
                <EditableField
                  label="Data da citação"
                  type="date"
                  value={paramsCalculo.data_citacao}
                  onChange={(v) => atualizarCampoTriagem("data_citacao", v || null)}
                />
                <EditableField
                  label="Data-base do cálculo (sentença/decisão)"
                  type="date"
                  value={paramsCalculo.data_base_calculo}
                  onChange={setDataBaseCalculo}
                />
                <label className="col-span-2 block">
                  <span className="mb-1 block text-sm font-medium text-ink-700">Índice até 11/2021</span>
                  <select
                    value={paramsCalculo.indice_ate_112021}
                    onChange={(e) => setIndiceOverride(e.target.value as "IPCA-E" | "INPC")}
                    className="w-full rounded border border-ink-100 px-3 py-2"
                  >
                    <option value="IPCA-E">IPCA-E</option>
                    <option value="INPC">INPC</option>
                  </select>
                </label>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  onClick={handleRunCalculo}
                  disabled={calculoLoading}
                  className="rounded bg-ink px-5 py-2.5 font-medium text-parchment hover:bg-ink-700 disabled:opacity-60"
                >
                  {calculoLoading ? "Calculando..." : "Executar recálculo"}
                </button>

                {resultadoCalculo && (
                  <button
                    onClick={handleBaixarPlanilha}
                    disabled={baixandoPlanilha}
                    className="rounded border border-brass px-5 py-2.5 font-medium text-brass-dark hover:bg-brass/10 disabled:opacity-60"
                  >
                    {baixandoPlanilha ? "Gerando..." : "⬇ Baixar Planilha de Cálculos (.xlsx)"}
                  </button>
                )}
              </div>
              {calculoErro && <p className="mt-2 text-sm text-seal-red">{calculoErro}</p>}

              {resultadoCalculo && (
                <div className="mt-5">
                  <DemonstrativoTable competencias={resultadoCalculo.competencias} />
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ---------------- BLOCO 3 — Minuta do Laudo ---------------- */}
        <section ref={refs["sec-laudo"]} id="sec-laudo" className="scroll-mt-20">
          <SectionHeader
            numero={3}
            titulo="Minuta do Laudo Pericial"
            descricao="Gera a minuta unindo os dados da triagem, o resultado do recálculo e os quesitos aprovados — com citação de folha (fls.) quando fundamentada nos autos."
          />

          <div className="mt-5 space-y-6">
            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleGerarLaudo}
                disabled={!runId || laudoLoading}
                className="rounded bg-ink px-5 py-2.5 font-medium text-parchment hover:bg-ink-700 disabled:opacity-60"
              >
                {laudoLoading
                  ? "Redigindo..."
                  : runId
                  ? "Gerar minuta do laudo"
                  : "Execute o recálculo no Bloco 2 antes de gerar a minuta"}
              </button>

              {resultadoCalculo && (
                <button
                  onClick={handleBaixarPlanilha}
                  disabled={baixandoPlanilha}
                  className="rounded border border-brass px-5 py-2.5 font-medium text-brass-dark hover:bg-brass/10 disabled:opacity-60"
                >
                  {baixandoPlanilha ? "Gerando..." : "⬇ Baixar Planilha de Cálculos (.xlsx)"}
                </button>
              )}
            </div>

            {laudoMarkdown && (
              <article className="prose max-w-none whitespace-pre-wrap rounded border border-ink-100 bg-white p-6">
                {laudoMarkdown}
              </article>
            )}
          </div>
        </section>
      </div>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}

function SectionHeader({ numero, titulo, descricao }: { numero: number; titulo: string; descricao: string }) {
  return (
    <div className="flex gap-3 border-b border-ink-100 pb-3">
      <span className="selo-pericial selo-pericial--conferido !h-8 !w-8 shrink-0 !text-[11px]">{numero}</span>
      <div>
        <h2 className="font-display text-lg text-ink">{titulo}</h2>
        <p className="text-sm text-ink-500">{descricao}</p>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: "ok" | "andamento" | "pendente" }) {
  const cor =
    status === "ok" ? "bg-seal-green" : status === "andamento" ? "bg-brass animate-pulse" : "bg-ink-100";
  return <span className={`h-2 w-2 rounded-full ${cor}`} />;
}

function QuesitosResumo({ titulo, itens }: { titulo: string; itens: string[] }) {
  if (itens.length === 0) return <div className="text-ink-300">{titulo}: nenhum</div>;
  return (
    <div>
      <p className="font-medium text-ink-500">
        {titulo} ({itens.length})
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {itens.slice(0, 3).map((q, i) => (
          <li key={i} className="truncate">
            {q}
          </li>
        ))}
        {itens.length > 3 && <li className="text-ink-300">+ {itens.length - 3} outro(s)</li>}
      </ul>
    </div>
  );
}

function Toast({ message, tone, onClose }: { message: string; tone: ToastState["tone"]; onClose: () => void }) {
  const estilos =
    tone === "sucesso"
      ? "border-seal-green/40 bg-white"
      : tone === "erro"
      ? "border-seal-red/40 bg-white"
      : "border-ink-100 bg-white";
  const corTexto = tone === "sucesso" ? "text-seal-green" : tone === "erro" ? "text-seal-red" : "text-ink";

  return (
    <div className={`fixed bottom-6 right-6 z-50 flex max-w-sm items-center justify-between gap-4 rounded border p-4 shadow-lg ${estilos}`}>
      <span className={`text-sm font-medium ${corTexto}`}>{message}</span>
      <button onClick={onClose} className="shrink-0 font-bold text-ink-300 hover:text-ink-700">
        ×
      </button>
    </div>
  );
}

function EditableField({
  label,
  value,
  onChange,
  type = "text",
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "date" | "number";
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-500">{label}</span>
      <input
        type={type}
        value={value}
        step={type === "number" ? "0.01" : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded border border-ink-100 px-3 py-2 text-sm text-ink focus:border-brass focus:outline-none ${
          mono ? "tabular-figures" : ""
        }`}
      />
    </label>
  );
}
