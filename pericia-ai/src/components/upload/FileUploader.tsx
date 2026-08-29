"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface FileUploaderProps {
  caseId: string;
  fileType: "processo_pdf" | "extrato_pdf" | "planilha_excel";
  onUploaded: (documentId: string) => void;
  accept?: string;
  label: string;
}

/**
 * Faz upload do arquivo para o bucket privado "case-files" (path convention:
 * {org_id implícito via RLS}/{caseId}/{fileType}/{fileName}) e cria o registro
 * correspondente em case_documents, retornando o documentId para a próxima
 * etapa (chamada da API de extração).
 */
export function FileUploader({ caseId, fileType, onUploaded, accept, label }: FileUploaderProps) {
  const supabase = createClient();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    setFileName(file.name);

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

      onUploaded(document.id);
    } catch (err: any) {
      setError(err?.message || "Falha no upload. Tente novamente.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded border border-dashed border-ink-100 bg-white p-5">
      <label className="block cursor-pointer text-center">
        <span className="block font-display text-sm text-ink-700">{label}</span>
        <span className="mt-1 block text-xs text-ink-500">
          {uploading ? "Enviando…" : fileName ?? "Clique para selecionar o arquivo"}
        </span>
        <input type="file" accept={accept} onChange={handleFileChange} className="hidden" disabled={uploading} />
      </label>
      {error && <p className="mt-2 text-center text-xs text-seal-red">{error}</p>}
    </div>
  );
}
