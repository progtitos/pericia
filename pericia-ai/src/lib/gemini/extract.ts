import PDFParser from "pdf2json";
import { getGeminiClient, MODELS } from "./client";

export interface ProcessoTriagemResult {
  numero_processo?: string;
  autor?: string;
  réu?: string;
  vara?: string;
  tribunal?: string;
  especialidade?: string;
  objeto_principal?: string;
  pedidos_e_deferimentos?: string[];
  datas_chave?: {
    distribuição?: string;
    citação?: string;
    sentença?: string;
    trânsito_em_julgado?: string;
  };
  valores_mencionados?: Array<{
    tipo?: string;
    valor?: number;
    data_base?: string;
  }>;
  observacoes_para_conferencia_humana?: string;
  _chunking_info?: any;
}

function cleanJsonResponse(rawText: string): string {
  return rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/** Extrai texto puro do Buffer PDF de forma assíncrona no Node.js */
function extractTextFromPdfBuffer(pdfBuffer: Buffer): Promise<string> {
  return new Promise((resolve) => {
    const pdfParser = new PDFParser(null, true);

    pdfParser.on("pdfParser_dataError", (errData: any) => {
      console.warn("Aviso na leitura de texto do PDF:", errData.parserError);
      resolve("");
    });

    pdfParser.on("pdfParser_dataReady", () => {
      const rawText = pdfParser.getRawTextContent();
      resolve(rawText || "");
    });

    pdfParser.parseBuffer(pdfBuffer);
  });
}

/** Retentativa automática para instabilidades temporárias */
async function generateWithBackoff(
  ai: any,
  payload: any,
  retries = 3,
  delayMs = 3000
): Promise<any> {
  try {
    return await ai.models.generateContent(payload);
  } catch (error: any) {
    const isRetryableError =
      error?.status === 429 ||
      error?.status === 503 ||
      error?.message?.includes("429") ||
      error?.message?.includes("503") ||
      error?.message?.includes("RESOURCE_EXHAUSTED") ||
      error?.message?.includes("UNAVAILABLE");

    if (isRetryableError && retries > 0) {
      await new Promise((res) => setTimeout(res, delayMs));
      return generateWithBackoff(ai, payload, retries - 1, delayMs * 2);
    }
    throw error;
  }
}

export async function extractProcessoTriagem(
  pdfBuffer: Buffer
): Promise<ProcessoTriagemResult> {
  const ai = getGeminiClient();
  const modelName = MODELS.FLASH || "gemini-3.6-flash";

  let textContent = await extractTextFromPdfBuffer(pdfBuffer);

  // Se o texto for gigantesco (> 150.000 caracteres), corta o miolo (procurações, guias)
  // e envia apenas as pontas essenciais para encaixar na cota gratuita de TPM
  if (textContent.length > 150000) {
    const headText = textContent.slice(0, 100000); // Primeiras ~20-30 pgs
    const tailText = textContent.slice(-50000);   // Últimas ~10-15 pgs
    textContent = `${headText}\n\n[...TRECHO INTERMEDIÁRIO DE ANEXOS/CERTIDÕES OMISSOS PARA ADEQUAÇÃO DE COTA...]\n\n${tailText}`;
  }

  try {
    // Se extraiu texto relevante, envia apenas a string (muito mais leve que o PDF Base64)
    const contentsPayload = textContent.trim().length > 200
      ? [
          `Analise o texto do processo judicial abaixo e responda estritamente em JSON.\n\nTEXTO:\n${textContent}`,
          `Estrutura JSON esperada:
          {
            "numero_processo": "string",
            "autor": "string",
            "réu": "string",
            "vara": "string",
            "tribunal": "string",
            "especialidade": "string",
            "objeto_principal": "string",
            "pedidos_e_deferimentos": ["string"],
            "datas_chave": {
              "distribuição": "YYYY-MM-DD",
              "citação": "YYYY-MM-DD",
              "sentença": "YYYY-MM-DD",
              "trânsito_em_julgado": "YYYY-MM-DD"
            },
            "valores_mencionados": [
              { "tipo": "string", "valor": 0.0, "data_base": "YYYY-MM-DD" }
            ],
            "observacoes_para_conferencia_humana": "string"
          }`
        ]
      : [
          {
            inlineData: {
              data: pdfBuffer.toString("base64"),
              mimeType: "application/pdf",
            },
          },
          `Analise o processo e extraia os dados em JSON estrito.`
        ];

    const response = await generateWithBackoff(ai as any, {
      model: modelName,
      contents: contentsPayload,
    });

    const cleanedText = cleanJsonResponse(
      response.text || response.response?.text() || ""
    );
    return JSON.parse(cleanedText) as ProcessoTriagemResult;
  } catch (error: any) {
    console.error("Erro na triagem:", error);
    throw error;
  }
}

export async function extractExtratoBancario(
  fileInput: Buffer | string,
  mimeType: string = "application/pdf"
): Promise<any> {
  const ai = getGeminiClient();
  const modelName = MODELS.FLASH || "gemini-3.6-flash";

  const base64Data = typeof fileInput === "string" ? fileInput : fileInput.toString("base64");

  const response = await generateWithBackoff(ai as any, {
    model: modelName,
    contents: [
      { inlineData: { data: base64Data, mimeType } },
      `Extraia as movimentações financeiras do extrato em JSON.`
    ],
  });

  return JSON.parse(cleanJsonResponse(response.text || response.response?.text() || ""));
}

export async function generateLaudoMinuta(data: any): Promise<any> {
  const ai = getGeminiClient();
  const modelName = MODELS.FLASH || "gemini-3.6-flash";

  const response = await generateWithBackoff(ai as any, {
    model: modelName,
    contents: [`Elabore a minuta do laudo pericial em JSON: ${JSON.stringify(data)}`],
  });

  return JSON.parse(cleanJsonResponse(response.text || response.response?.text() || ""));
}