// pericia-ai/src/lib/pdf-reader.ts

import * as pdfjsLib from "pdfjs-dist";

// Configura o worker utilizando o unpkg com a versão exata instalada no seu projeto
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export type OnProgressCallback = (
  porcentagem: number,
  paginasLidas: number,
  totalPaginas: number
) => void;

export interface PDFExtractionResult {
  textoCompleto: string;
  totalPaginas: number;
  totalTokensEstimados: number;
}

export async function extractTextFromPDF(
  file: File,
  onProgress?: OnProgressCallback
): Promise<PDFExtractionResult> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPaginas = pdf.numPages;
  let fullText = "";

  for (let i = 1; i <= totalPaginas; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(" ");
    // Marcador de folha ([[FLS. N]]): permite que a geração do laudo (Claude)
    // cite a página exata de onde tirou uma informação (ex.: "conforme
    // decisão de fls. 142"), sem precisar adivinhar. O marcador é ignorado
    // explicitamente no prompt de extração/laudo — nunca tratado como
    // conteúdo do processo.
    fullText += `\n[[FLS. ${i}]]\n` + pageText + "\n";

    if (onProgress) {
      const porcentagem = Math.round((i / totalPaginas) * 100);
      onProgress(porcentagem, i, totalPaginas);
    }
  }

  // Estimativa de tokens (aproximadamente 1 token para cada 4 caracteres)
  const totalTokensEstimados = Math.ceil(fullText.length / 4);

  return {
    textoCompleto: fullText,
    totalPaginas,
    totalTokensEstimados,
  };
}

// Alias exportado para compatibilidade com os componentes do frontend
export const extrairTextoDoPdfClient = extractTextFromPDF;