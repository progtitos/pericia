import * as pdfjsLib from "pdfjs-dist";

// Worker via CDN para não sobrecarregar o build principal
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

export interface ExtracaoResultado {
  textoCompleto: string;
  totalPaginas: number;
  totalTokensEstimados: number;
}

export async function extrairTextoDoPdfClient(
  file: File,
  onProgress?: (porcentagem: number, paginasLidas: number, totalPaginas: number) => void
): Promise<ExtracaoResultado> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPaginas = pdf.numPages;
  let textoCompleto = "";

  for (let i = 1; i <= totalPaginas; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(" ");

    textoCompleto += `\n--- PÁGINA ${i} ---\n` + pageText;

    if (onProgress) {
      const porcentagem = Math.round((i / totalPaginas) * 100);
      onProgress(porcentagem, i, totalPaginas);
    }
  }

  // Estimativa rápida e precisa de tokens para textos em Português (~3.8 caracteres por token)
  const totalTokensEstimados = Math.ceil(textoCompleto.length / 3.8);

  return {
    textoCompleto,
    totalPaginas,
    totalTokensEstimados,
  };
}