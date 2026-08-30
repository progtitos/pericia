"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { TokenPreviewInfo } from "@/lib/types";

interface FileUploaderProps {
  caseId: string;
  fileType: "processo_pdf" | "extrato_pdf" | "planilha_excel";
  onUploaded: (documentId: string, tokenPreview?: TokenPreviewInfo) => void;
  accept?: string;
  label: string;
  /** Se true, chama /api/gemini/count-tokens após o upload e mostra a
   *  prévia de capacidade antes de liberar o próximo passo. Usar para
   *  documentos que vão para extração via Gemini (processo_pdf). */
  showTokenPreview?: boolean;
}

const STATUS_STYLES: Record<TokenPreviewInfo["status"], { bar: string; text: string; bg: string }> = {
  ok: { bar: "bg-seal-green", text: "text-seal-green", bg: "bg-seal-green/5 border-seal-green/30" },
  atencao: { bar: "bg-brass", text: "text-brass-dark", bg: "bg-brass/5 border-brass/30" },
  critico: { bar: "bg-seal-red", text: "text-seal-red", bg: "bg-seal-red/5 border-seal-red/30" },
};

/**
 * Faz upload do arquivo para o bucket privado "case-files" e cria o registro
 * correspondente em case_documents. Quando showTokenPreview está ativo,
 * também chama a rota leve de contagem de tokens e:
 *   - exibe uma barra de capacidade da janela de contexto do modelo;
 *   - se o arquivo exigir o modo de Análise por Camadas, mostra um modal
 *     explicativo e só libera o próximo passo após confirmação do usuário.
 */
export function FileUploader({
  caseId,
  fileType,
  onUploaded,
  accept,
  label,
  showTokenPreview = false,
}: FileUploaderProps) {
  const supabase = createClient();
  const [uploading, setUploading] = useState(false);
  const [countingTokens, setCountingTokens] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<TokenPreviewInfo | null>(null);
  const [pendingDocumentId, setPendingDocumentId] = useState<string | null>(null);
  const [showChunkingModal, setShowChunkingModal] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    setFileName(file.name);
    setPreview(null);

    try {
      const path = `${caseId}/${fileType}/${Date.now()}-${file.name}`;

      const { error: uploadError } = await supabase.storage
        .from("case-files")
        .upload(path, file, { upsert: false });
      if (uploadError) throw uploadError;

      const { data: document, error: insertError } = await supabase
        .from("case_documents")
        .insert({
          case_id: caseId,
          file_name: file.name,
          file_path: path,
          file_type: fileType,
        })
        .select()
        .single();
      if (insertError || !document) throw insertError;

      if (!showTokenPreview) {
        onUploaded(document.id);
        return;
      }

      // Prévia de consumo de tokens ANTES de liberar a extração completa.
      setUploading(false);
      setCountingTokens(true);

      const res = await fetch("/api/gemini/count-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: document.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);

      const tokenPreview: TokenPreviewInfo = json.preview;
      setPreview(tokenPreview);
      setPendingDocumentId(document.id);

      if (tokenPreview.exigeChunking) {
        // Documento extenso detectado — bloqueia o envio direto e pede
        // confirmação explícita do usuário antes de rodar o modo em camadas.
        setShowChunkingModal(true);
      } else {
        onUploaded(document.id, tokenPreview);
      }
    } catch (err: any) {
      setError(err?.message || "Falha no upload. Tente novamente.");
    } finally {
      setUploading(false);
      setCountingTokens(false);
    }
  }

  function confirmarProcessamentoEmCamadas() {
    if (!pendingDocumentId || !preview) return;
    setShowChunkingModal(false);
    onUploaded(pendingDocumentId, preview);
  }

  const statusStyle = preview ? STATUS_STYLES[preview.status] : null;

  return (
    <div className="rounded border border-dashed border-ink-100 bg-white p-5">
      <label className="block cursor-pointer text-center">
        <span className="block font-display text-sm text-ink-700">{label}</span>
        <span className="mt-1 block text-xs text-ink-500">
          {uploading
            ? "Enviando…"
            : countingTokens
            ? "Estimando consumo de tokens…"
            : fileName ?? "Clique para selecionar o arquivo"}
        </span>
        <input
          type="file"
          accept={accept}
          onChange={handleFileChange}
          className="hidden"
          disabled={uploading || countingTokens}
        />
      </label>

      {error && <p className="mt-2 text-center text-xs text-seal-red">{error}</p>}

      {preview && statusStyle && (
        <div className={`mt-4 rounded border p-3 ${statusStyle.bg}`}>
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-ink-700">
              {preview.totalTokens.toLocaleString("pt-BR")} tokens estimados
              {preview.totalPaginas ? ` · ${preview.totalPaginas} páginas` : ""}
            </span>
            <span className={`font-medium ${statusStyle.text}`}>
              {preview.percentualOcupado.toFixed(1)}% da janela
            </span>
          </div>

          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-ink-50">
            <div
              className={`h-full rounded-full transition-all ${statusStyle.bar}`}
              style={{ width: `${Math.min(preview.percentualOcupado, 100)}%` }}
            />
          </div>

          <p className="mt-2 text-[11px] text-ink-500">
            Limite da janela do modelo: {preview.modelLimit.toLocaleString("pt-BR")} tokens.
            {preview.exigeChunking && " Este documento será processado em camadas (chunking)."}
          </p>
          <p className="mt-1 text-[11px] text-ink-500">
            Extração de texto puro acionada — carimbos, assinaturas e margens não são enviados como
            imagem, o que preserva a exatidão dos números para o recálculo.
          </p>
        </div>
      )}

      {showChunkingModal && preview && (
        <ChunkingModal preview={preview} onConfirm={confirmarProcessamentoEmCamadas} />
      )}
    </div>
  );
}

function ChunkingModal({
  preview,
  onConfirm,
}: {
  preview: TokenPreviewInfo;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/50 px-4">
      <div className="w-full max-w-md rounded border border-ink-100 bg-white p-6 shadow-lg">
        <div className="flex items-center gap-3">
          <span className="selo-pericial selo-pericial--alerta">!</span>
          <h3 className="font-display text-lg text-ink">Documento Extenso Detectado</h3>
        </div>

        <p className="mt-3 text-sm text-ink-700">
          Este arquivo tem aproximadamente{" "}
          <strong className="tabular-figures">{preview.totalTokens.toLocaleString("pt-BR")}</strong>{" "}
          tokens ({preview.percentualOcupado.toFixed(1)}% da janela de contexto do modelo), acima do
          limite seguro para análise em uma única chamada.
        </p>
        <p className="mt-2 text-sm text-ink-700">
          O sistema ativará o <strong>modo de Análise por Camadas (Chunking)</strong>: o processo será
          dividido em blocos (ex.: petição/cálculos, contestação/despachos, sentença/decisão),
          cada bloco será analisado separadamente e os resultados serão consolidados
          automaticamente ao final.
        </p>

        <button
          onClick={onConfirm}
          className="mt-5 w-full rounded bg-ink py-2.5 font-medium text-parchment hover:bg-ink-700 transition-colors"
        >
          Entendi, processar em camadas
        </button>
      </div>
    </div>
  );
}
