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

/**
 * Retentativa automática para tratar requisições sobrecarregadas (429/503)
 */
async function generateWithBackoff(
  ai: any,
  payload: any,
  retries = 3,
  delayMs = 2500
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
      console.warn(
        `[Gemini API] Aguardando ${delayMs / 1000}s devido a limite de cota ou instabilidade...`
      );
      await new Promise((res) => setTimeout(res, delayMs));
      return generateWithBackoff(ai, payload, retries - 1, delayMs * 2);
    }
    throw error;
  }
}

/**
 * 1. Extração do Processo para Triagem (Buffer Seguro)
 */
export async function extractProcessoTriagem(
  pdfBuffer: Buffer
): Promise<ProcessoTriagemResult> {
  const ai = getGeminiClient();
  const modelName = MODELS.FLASH || "gemini-3.6-flash";

  try {
    const base64Pdf = pdfBuffer.toString("base64");

    const response = await generateWithBackoff(ai as any, {
      model: modelName,
      contents: [
        {
          inlineData: {
            data: base64Pdf,
            mimeType: "application/pdf",
          },
        },
        `Você é um perito judicial especialista. Analise o processo enviado e extraia um JSON estrito contendo:
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
        }`,
      ],
    });

    const cleanedText = cleanJsonResponse(
      response.text || response.response?.text() || ""
    );
    return JSON.parse(cleanedText) as ProcessoTriagemResult;
  } catch (error: any) {
    console.error("Erro em extractProcessoTriagem:", error);

    throw new Error(
      `Falha no processamento: ${error?.message || error}`
    );
  }
}

/**
 * 2. Extração de Extrato Bancário
 */
export async function extractExtratoBancario(
  fileInput: Buffer | string,
  mimeType: string = "application/pdf"
): Promise<any> {
  const ai = getGeminiClient();
  const modelName = MODELS.FLASH || "gemini-3.6-flash";

  try {
    const base64Data =
      typeof fileInput === "string" ? fileInput : fileInput.toString("base64");

    const response = await generateWithBackoff(ai as any, {
      model: modelName,
      contents: [
        {
          inlineData: {
            data: base64Data,
            mimeType: mimeType,
          },
        },
        `Extraia as movimentações financeiras do extrato bancário em formato JSON estrito:
        {
          "banco": "string",
          "conta": "string",
          "saldo_inicial": 0.0,
          "saldo_final": 0.0,
          "alertas": ["string"],
          "lancamentos": [
            { "data": "YYYY-MM-DD", "descricao": "string", "valor": 0.0, "tipo": "C ou D" }
          ]
        }`,
      ],
    });

    const cleanedText = cleanJsonResponse(response.text || response.response?.text() || "");
    return JSON.parse(cleanedText);
  } catch (error: any) {
    console.error("Erro em extractExtratoBancario:", error);
    throw new Error(`Falha ao extrair extrato: ${error?.message || error}`);
  }
}

/**
 * 3. Geração de Minuta / Laudo Pericial
 */
export async function generateLaudoMinuta(data: any): Promise<any> {
  const ai = getGeminiClient();
  const modelName = MODELS.FLASH || "gemini-3.6-flash";

  try {
    const response = await generateWithBackoff(ai as any, {
      model: modelName,
      contents: [
        `Com base nos dados periciais, elabore a minuta do laudo pericial em JSON estrito:
        ${JSON.stringify(data)}
        
        Retorne:
        {
          "titulo": "string",
          "resumo_executivo": "string",
          "metodologia": "string",
          "conclusao": "string"
        }`,
      ],
    });

    const cleanedText = cleanJsonResponse(response.text || response.response?.text() || "");
    return JSON.parse(cleanedText);
  } catch (error: any) {
    console.error("Erro em generateLaudoMinuta:", error);
    throw new Error(`Falha ao gerar minuta: ${error?.message || error}`);
  }
}