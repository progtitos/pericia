"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { extrairTextoDoPdfClient } from "@/lib/pdf-reader";

interface FileUploaderProps {
  caseId: string;
  fileType: "processo_pdf" | "extrato_pdf" | "planilha_excel";
  onUploaded: (file: File, textoExtraido?: string) => void;
  accept?: string;
  label: string;
  /** Quando true, o texto é extraído no navegador antes de chamar onUploaded
   *  (usado para o PDF do processo, que precisa do texto para a triagem). */
  extrairTexto?: boolean;
}

/**
 * Upload simples e direto: salva o arquivo no Storage, opcionalmente extrai
 * o texto do PDF no navegador (com uma barra de progresso limpa) e chama
 * onUploaded assim que estiver pronto — sem contagem de tokens, sem menção a
 * "janela do modelo" ou "chunking", sem modal de confirmação. O usuário só
 * precisa ver "Analisando..." e, em seguida, o resultado.
 */
export function FileUploader({
  caseId,
  fileType,
  onUploaded,
  accept,
  label,
  extrairTexto = false,
}: FileUploaderProps) {
  const supabase = createClient();
  const [progresso, setProgresso] = useState<number | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setFileName(file.name);
    setProgresso(5);
    setMensagem("Enviando arquivo...");

    try {
      const path = `${caseId}/${fileType}/${Date.now()}-${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("case-files")
        .upload(path, file, { upsert: false });
      if (uploadError) throw uploadError;

      await supabase.from("case_documents").insert({
        case_id: caseId,
        file_name: file.name,
        file_path: path,
        file_type: fileType,
      });

      if (!extrairTexto) {
        setProgresso(null);
        onUploaded(file);
        return;
      }

      setProgresso(15);
      setMensagem("Analisando autos do processo...");

      const { textoCompleto } = await extrairTextoDoPdfClient(file, (porcentagem) => {
        // 15%–90%: leitura do PDF. O restante (90%–100%) fica para a IA,
        // exibido pela barra do componente pai (CaseWorkspace).
        setProgresso(15 + Math.round(porcentagem * 0.75));
      });

      setProgresso(null);
      onUploaded(file, textoCompleto);
    } catch (err: any) {
      setError(err?.message || "Falha no upload. Tente novamente.");
      setProgresso(null);
      setFileName(null);
    }
  }

  return (
    <div className="rounded border border-dashed border-ink-100 bg-white p-5">
      <label className="block cursor-pointer text-center">
        <span className="block font-display text-sm text-ink-700">{label}</span>
        <span className="mt-1 block text-xs text-ink-500">
          {mensagem ?? fileName ?? "Clique para selecionar o arquivo"}
        </span>
        <input
          type="file"
          accept={accept}
          onChange={handleFileChange}
          className="hidden"
          disabled={progresso !== null}
        />
      </label>

      {progresso !== null && (
        <div className="mt-4">
          <div className="h-2 w-full overflow-hidden rounded-full bg-ink-50">
            <div
              className="h-full rounded-full bg-brass transition-all duration-300"
              style={{ width: `${Math.min(progresso, 100)}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 text-center text-xs text-seal-red">
          <p>{error}</p>
          <button
            onClick={() => setError(null)}
            className="mt-1 font-medium underline hover:text-seal-red/80"
          >
            Tentar novamente
          </button>
        </div>
      )}
    </div>
  );
}
