// pericia-ai/src/lib/pdf-reader.ts

import * as pdfjsLib from "pdfjs-dist";

// Configura o worker utilizando o unpkg com a versão exata instalada no seu projeto
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export type OnProgressCallback = (
  porcentagem: number,
  paginasLidas: number,
  totalPaginas: number
) => void;

export async function extractTextFromPDF(
  file: File,
  onProgress?: OnProgressCallback
): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;
  let fullText = "";

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(" ");
    fullText += pageText + "\n";

    if (onProgress) {
      const porcentagem = Math.round((i / totalPages) * 100);
      onProgress(porcentagem, i, totalPages);
    }
  }

  return fullText;
}

// Alias exportado para compatibilidade com os componentes do frontend
export const extrairTextoDoPdfClient = extractTextFromPDF;