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
 * Executa requisição à API com mecanismo de retentativa para evitar erro 429 (Rate Limit / Cota).
 */
async function generateContentWithRetry(
  ai: any,
  payload: any,
  maxRetries = 3
): Promise<any> {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent(payload);
    } catch (err: any) {
      const isRateLimit =
        err?.status === 429 ||
        err?.message?.includes("429") ||
        err?.message?.includes("RESOURCE_EXHAUSTED");

      if (isRateLimit && attempt < maxRetries) {
        console.warn(`[Gemini API] Cota atingida (429). Tentativa ${attempt} de ${maxRetries}. Aguardando ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
      } else {
        throw err;
      }
    }
  }
}

/**
 * 1. Extração do Processo para Triagem
 */
export async function extractProcessoTriagem(
  pdfBuffer: Buffer
): Promise<ProcessoTriagemResult> {
  const ai = getGeminiClient();
  const modelName = MODELS.PRO || "gemini-3.6-flash";

  try {
    const base64Pdf = pdfBuffer.toString("base64");

    const response = await generateContentWithRetry(ai as any, {
      model: modelName,
      contents: [
        {
          inlineData: {
            data: base64Pdf,
            mimeType: "application/pdf",
          },
        },
        `Você é um perito judicial especialista. Analise o texto do processo fornecido (focando prioritariamente na petição inicial, sentença e acórdão) e extraia um JSON estrito com os dados numéricos e jurídicos essenciais para o recálculo.
        Retorne APENAS um objeto JSON válido no formato:
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

    const cleanedText = cleanJsonResponse(response.text || response.response?.text() || "");
    return JSON.parse(cleanedText) as ProcessoTriagemResult;
  } catch (error: any) {
    console.error("Erro no extractProcessoTriagem:", error);

    // Tentativa de emergência simplificada caso o payload original estoure a cota de tokens
    try {
      const base64Pdf = pdfBuffer.toString("base64");
      const fallbackResponse = await generateContentWithRetry(ai as any, {
        model: "gemini-3.6-flash",
        contents: [
          {
            inlineData: {
              data: base64Pdf,
              mimeType: "application/pdf",
            },
          },
          "Resuma apenas em JSON estrito: numero_processo, autor, réu, vara, e observacoes_para_conferencia_humana.",
        ],
      });

      const cleanedText = cleanJsonResponse(
        fallbackResponse.text || fallbackResponse.response?.text() || ""
      );
      return JSON.parse(cleanedText) as ProcessoTriagemResult;
    } catch (fallbackError: any) {
      throw new Error(
        `O limite de tokens/cota foi atingido na API do Google Gemini. Aguarde 1 minuto e tente novamente ou divida o PDF.`
      );
    }
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
      typeof fileInput === "string"
        ? fileInput
        : fileInput.toString("base64");

    const response = await generateContentWithRetry(ai as any, {
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
    console.error("Erro no extractExtratoBancario:", error);
    throw new Error(`Falha ao extrair extrato: ${error?.message || error}`);
  }
}

/**
 * 3. Geração de Minuta / Laudo Pericial
 */
export async function generateLaudoMinuta(data: any): Promise<any> {
  const ai = getGeminiClient();
  const modelName = MODELS.PRO || "gemini-3.6-flash";

  try {
    const response = await generateContentWithRetry(ai as any, {
      model: modelName,
      contents: [
        `Com base nos dados periciais fornecidos abaixo, elabore a minuta do laudo pericial em formato JSON estrito:
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
    console.error("Erro no generateLaudoMinuta:", error);
    throw new Error(`Falha ao gerar minuta: ${error?.message || error}`);
  }
}