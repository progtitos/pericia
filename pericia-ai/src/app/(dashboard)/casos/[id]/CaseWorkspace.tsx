"use client";

import { useMemo, useRef, useState } from "react";
import { FileUploader } from "@/components/upload/FileUploader";
import { DemonstrativoTable } from "@/components/calc/DemonstrativoTable";
import { extrairTextoDoPdfClient } from "@/lib/pdf-reader";
import { createClient } from "@/lib/supabase/client";
import type {
  ProcessoTriagemExtraido,
  ReconciliacaoResultado,
  ResultadoCalculoPrevidenciario,
  TokenPreviewInfo,
} from "@/lib/types";

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

// Seções do fluxo contínuo (substituem as antigas abas isoladas). Usadas
// apenas para a navegação-âncora do topo — todo o conteúdo fica sempre
// montado e visível, nada é escondido por troca de aba.
const SECOES = [
  { id: "sec-triagem", label: "Triagem" },
  { id: "sec-calculo", label: "Cálculo & Reconciliação" },
  { id: "sec-laudo", label: "Laudo" },
] as const;

/**
 * Converte uma data para o formato aceito por <input type="date"> (ISO
 * YYYY-MM-DD). Aceita tanto ISO quanto o formato brasileiro DD/MM/AAAA que o
 * prompt de triagem pede ao Gemini — sem essa conversão, o valor extraído
 * nunca aparece nos campos de data (o navegador simplesmente ignora um
 * value que não esteja em ISO), o que é a causa raiz de "os dados da
 * triagem não preenchem o Cálculo".
 */
function paraInputDate(valor: string | null | undefined): string {
  if (!valor) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
  const match = valor.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return "";
}

/** Deriva o índice a usar até 11/2021 a partir do texto livre extraído pelo
 *  Gemini (ex.: "IPCA-E (Manual de Cálculos)"), com IPCA-E como padrão. */
function derivarIndice(indiceTexto: string | null): "IPCA-E" | "INPC" {
  return indiceTexto?.toUpperCase().includes("INPC") ? "INPC" : "IPCA-E";
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
  // Estado — "triagem" é a fonte única de verdade dos dados extraídos do
  // processo. Os campos usados no Cálculo (RMI, DIB, data da citação) são
  // DERIVADOS diretamente dela (useMemo), nunca duplicados em outro estado.
  // Editar um campo — seja no painel "Dados Extraídos" da Triagem, seja no
  // formulário de Cálculo — atualiza o MESMO objeto, então os dois blocos
  // nunca podem ficar dessincronizados entre si.
  // ---------------------------------------------------------------------
  const [triagem, setTriagem] = useState<ProcessoTriagemExtraido | null>(null);
  const [triagemLoading, setTriagemLoading] = useState(false);
  const [triagemErro, setTriagemErro] = useState<string | null>(null);
  const [triagemTokenPreview, setTriagemTokenPreview] = useState<TokenPreviewInfo | null>(null);
  const [progressoStatus, setProgressoStatus] = useState<StatusProcessamento | null>(null);

  // Único campo do formulário de Cálculo que NÃO existe na triagem (data da
  // sentença/decisão que fixa a data-base do cálculo) — por isso continua
  // como estado próprio, editável independentemente do restante.
  const [dataBaseCalculo, setDataBaseCalculo] = useState("");
  // Permite ao perito substituir o índice detectado pela IA por outro,
  // caso a triagem tenha lido errado ou o juízo tenha determinado diferente.
  const [indiceOverride, setIndiceOverride] = useState<"IPCA-E" | "INPC" | null>(null);

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

  // Parâmetros de cálculo derivados da triagem + do campo próprio de
  // data-base. Recalculado a cada render — não há como ficar "desatualizado"
  // porque não existe uma cópia separada para dessincronizar.
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

  /** Atualiza um campo da triagem (painel "Dados Extraídos" OU formulário de
   *  Cálculo — ambos chamam esta mesma função, garantindo sincronia). */
  function atualizarCampoTriagem<K extends keyof ProcessoTriagemExtraido>(
    campo: K,
    valor: ProcessoTriagemExtraido[K]
  ) {
    setTriagem((prev) => (prev ? { ...prev, [campo]: valor } : prev));
  }

  /**
   * Persiste a triagem (já validada/corrigida pelo perito) em
   * forensic_cases.metadata — é de lá que a rota /api/gemini/gerar-laudo lê
   * o contexto processual para escrever a minuta. Sem isso, a Fase 4 nunca
   * "vê" os dados da Fase 1, mesmo com a tela sincronizada visualmente.
   */
  async function persistirMetadadosDoCaso(dados: ProcessoTriagemExtraido) {
    try {
      await supabase
        .from("forensic_cases")
        .update({ metadata: dados, status: "calculo" })
        .eq("id", caseId);
    } catch {
      // Falha silenciosa aqui não deve travar o fluxo do perito na tela —
      // o pior caso é o laudo sair sem parte do contexto da triagem, e o
      // perito já vê e revisa a minuta antes de finalizar.
    }
  }

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
        // Normaliza as datas para ISO uma única vez, aqui, no momento em que
        // o resultado chega — a partir daqui todo o resto do componente
        // (painel de triagem, formulário de cálculo) trabalha só com ISO.
        const dadosNormalizados: ProcessoTriagemExtraido = {
          ...json.resultado,
          dib: paraInputDate(json.resultado.dib) || json.resultado.dib,
          der: paraInputDate(json.resultado.der) || json.resultado.der,
          data_citacao: paraInputDate(json.resultado.data_citacao) || json.resultado.data_citacao,
        };

        setTriagem(dadosNormalizados);
        setProgressoStatus({
          progresso: 100,
          mensagem: "Processamento concluído com sucesso!",
          tempoRestanteSegundos: 0,
          status: "done",
        });

        // Sincroniza imediatamente: assim que a triagem termina, o bloco de
        // Cálculo já nasce preenchido (RMI/DIB/Citação vêm do useMemo acima,
        // que reage a este setTriagem) e o contexto do laudo já é persistido.
        await persistirMetadadosDoCaso(dadosNormalizados);

        scrollPara("sec-calculo");
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
            rmi: parseFloat(paramsCalculo.rmi),
            dib: paramsCalculo.dib,
            data_citacao: paramsCalculo.data_citacao,
            data_base_calculo: paramsCalculo.data_base_calculo,
            indice_ate_112021: paramsCalculo.indice_ate_112021,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setResultadoCalculo(json.resultado);
      setRunId(json.runId);
      scrollPara("sec-laudo");
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
      // Última chance de capturar qualquer correção feita pelo perito nos
      // campos da triagem antes de gerar a minuta — garante que o laudo
      // reflete exatamente o que está na tela, não uma versão desatualizada.
      if (triagem) await persistirMetadadosDoCaso(triagem);

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

  const statusSecoes = {
    "sec-triagem": triagem ? "ok" : triagemLoading ? "andamento" : "pendente",
    "sec-calculo": resultadoCalculo ? "ok" : "pendente",
    "sec-laudo": laudoMarkdown ? "ok" : "pendente",
  } as const;

  return (
    <div className="pb-24">
      {/* Navegação-âncora — substitui as antigas abas isoladas. O conteúdo
          de todas as seções permanece sempre montado; isto só rola a tela. */}
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
            descricao="Envie o PDF do processo. A leitura do texto acontece no seu navegador; a IA analisa e você valida os dados antes de seguir."
          />

          <div className="mt-5 space-y-6">
            <FileUploader
              caseId={caseId}
              fileType="processo_pdf"
              label="Enviar PDF do processo (petição, sentença, acórdão)"
              accept="application/pdf"
              showTokenPreview
              onUploaded={handleProcessoUploaded}
            />

            {triagemLoading && progressoStatus && (
              <div className="w-full space-y-2 rounded-lg border border-ink-100 bg-parchment-dim/60 p-4">
                <div className="flex justify-between text-sm font-medium text-ink-700">
                  <span>{progressoStatus.mensagem}</span>
                  <span>{progressoStatus.progresso}%</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-ink-50">
                  <div
                    className="h-full bg-brass transition-all duration-300"
                    style={{ width: `${progressoStatus.progresso}%` }}
                  />
                </div>
              </div>
            )}

            {triagemErro && <p className="text-sm text-seal-red">{triagemErro}</p>}

            {triagem && (
              <div className="rounded border border-ink-100 bg-white p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-ink">Dados Extraídos</h3>
                  <span className="text-[11px] uppercase tracking-wide text-ink-500">
                    Editável — confira antes de calcular
                  </span>
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

                {triagem.observacoes_para_conferencia_humana?.length > 0 && (
                  <div className="mt-4 rounded border border-seal-red/30 bg-seal-red/5 p-3">
                    <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-seal-red">
                      <span className="selo-pericial selo-pericial--alerta !h-6 !w-6 !text-[8px]">!</span>
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
            {/* Reconciliação de extrato — opcional, complementa o cálculo */}
            <div className="rounded border border-ink-100 bg-white p-5">
              <h4 className="font-display text-sm text-ink">Conciliação de Extrato Bancário (opcional)</h4>
              <div className="mt-3">
                <FileUploader
                  caseId={caseId}
                  fileType="extrato_pdf"
                  label="Enviar extrato bancário (PDF)"
                  accept="application/pdf"
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

            {/* Parâmetros de cálculo — derivados da triagem, editáveis aqui também */}
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

              <button
                onClick={handleRunCalculo}
                disabled={calculoLoading}
                className="mt-5 rounded bg-ink px-5 py-2.5 font-medium text-parchment hover:bg-ink-700 disabled:opacity-60"
              >
                {calculoLoading ? "Calculando..." : "Executar recálculo"}
              </button>
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
            descricao="Gera a minuta unindo os dados da triagem, o resultado do recálculo e os quesitos aprovados."
          />

          <div className="mt-5 space-y-6">
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

function Toast({ message, tone, onClose }: { message: string; tone: "erro" | "info"; onClose: () => void }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex max-w-sm justify-between gap-4 rounded border bg-white p-4 shadow-lg">
      <p className="text-sm">{message}</p>
      <button onClick={onClose} className="font-bold">
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
