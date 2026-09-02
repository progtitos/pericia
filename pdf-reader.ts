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

// ---------------------------------------------------------------------------
// Limpeza de ruído judicial — importante para CUSTO, não só performance.
//
// PDFs judiciais brasileiros repetem, em TODA página: timbre do tribunal,
// bloco de assinatura eletrônica, código de verificação, numeração de folha.
// Nenhum desses elementos carrega dado de cálculo, mas cada um consome
// tokens pagos na API do Claude, em toda página, em todo upload. Isso já
// tinha sido implementado uma vez (na arquitetura de servidor anterior, via
// pdf-parse) mas não foi portado quando a extração de texto migrou para o
// navegador (pdfjs-dist) — o ruído estava sendo enviado sem necessidade,
// inflando o custo real de cada documento processado.
// ---------------------------------------------------------------------------

const PADROES_RUIDO_JUDICIAL: RegExp[] = [
  // Blocos de assinatura eletrônica (aparecem em praticamente toda página de
  // PDF gerado por sistema de processo eletrônico brasileiro).
  /assinado (eletronicamente|digitalmente) por[^\n]*/gi,
  /documento assinado digitalmente conforme (a )?mp n?º?\s*2\.200-2\/2001[^\n]*/gi,
  /este documento (pode ser|foi) (assinado|verificado)[^\n]*/gi,
  /para conferir a autenticidade deste documento[^\n]*/gi,
  /código de verificação[:\s][^\n]*/gi,
  /assinatura eletrônica[:\s][^\n]*/gi,

  // Numeração de folha e paginação repetida (o marcador [[FLS. N]] que NÓS
  // inserimos abaixo já cobre a localização de página de forma confiável —
  // a numeração original do PDF é redundante e pode até divergir dele).
  /\bfls?\.?\s*\d+\b/gi,
  /p[aá]gina\s+\d+\s+de\s+\d+/gi,

  // Timbres/cabeçalhos institucionais repetidos em cada página.
  /poder judici[aá]rio[^\n]*/gi,
  /tribunal de justiça d[eo][^\n]*/gi,
  /justiça federal[^\n]*(seção|subseção)[^\n]*/gi,

  // Sequências longas de caracteres alfanuméricos típicas de hash/token de
  // autenticação de documento (não carregam dado de cálculo).
  /\b[0-9a-f]{24,}\b/gi,
];

/**
 * Remove ruído repetitivo do texto de uma página — timbre, numeração de
 * folha, blocos de assinatura eletrônica — SEM tocar em nenhum valor
 * numérico, data ou nome que possa ser dado de cálculo. Feito por regex
 * determinístico, nunca pela IA, então não há risco de remover por engano
 * algo relevante para o mérito.
 */
export function limparRuidoJudicial(textoPagina: string): string {
  let limpo = textoPagina;
  for (const padrao of PADROES_RUIDO_JUDICIAL) {
    limpo = limpo.replace(padrao, " ");
  }
  return limpo.replace(/[ \t]{2,}/g, " ").trim();
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
    const pageTextBruto = textContent.items
      .map((item: any) => item.str)
      .join(" ");
    const pageTextLimpo = limparRuidoJudicial(pageTextBruto);

    // Marcador de folha ([[FLS. N]]): permite que a geração do laudo (Claude)
    // cite a página exata de onde tirou uma informação (ex.: "conforme
    // decisão de fls. 142"), sem precisar adivinhar. O marcador é ignorado
    // explicitamente no prompt de extração/laudo — nunca tratado como
    // conteúdo do processo.
    fullText += `\n[[FLS. ${i}]]\n` + pageTextLimpo + "\n";

    if (onProgress) {
      const porcentagem = Math.round((i / totalPaginas) * 100);
      onProgress(porcentagem, i, totalPaginas);
    }
  }

  // Estimativa de tokens (aproximadamente 1 token para cada 4 caracteres,
  // com margem para o tokenizer do Claude tender a produzir mais tokens
  // que essa estimativa simples por caracteres).
  const totalTokensEstimados = Math.ceil(fullText.length / 4);

  return {
    textoCompleto: fullText,
    totalPaginas,
    totalTokensEstimados,
  };
}

// Alias exportado para compatibilidade com os componentes do frontend
export const extrairTextoDoPdfClient = extractTextFromPDF;
