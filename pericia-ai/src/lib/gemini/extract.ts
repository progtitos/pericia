import { getGeminiClient, MODELS } from "./client";
import { PROMPTS } from "./prompts";
import { processInChunks } from "./chunking";

/**
 * Interface padronizada dos dados extraídos do processo na Triagem.
 */
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

/**
 * Função utilitária para limpar formatação Markdown ```json ... ``` que o Gemini costuma retornar.
 */
function cleanJsonResponse(rawText: string): string {
  return rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * Extrai dados estruturados do PDF do processo para a fase de Triagem.
 * Processa o documento via Gemini utilizando os modelos mais recentes e chunking se necessário.
 */
export async function extractProcessoTriagem(
  pdfBuffer: Buffer
): Promise<ProcessoTriagemResult> {
  const ai = getGeminiClient();

  // Garante que o modelo utilizado seja o configurado no client (gemini-2.5-flash / gemini-3.1-pro-preview)
  const modelName = MODELS.PRO || "gemini-2.5-flash";
  const model = ai.getGenerativeModel({ model: modelName });

  try {
    // 1. Tenta o processamento com a lógica de chunking/processamento seguro
    const promptText = PROMPTS.TRIAGEM_PROCESSO || `
      Você é um perito judicial especialista. Analise o texto do processo fornecido e extraia um JSON estrito com os dados numéricos e jurídicos essenciais para o recálculo.
      Retorne APENAS um objeto JSON válido sem formatação markdown no seguinte formato:
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
      }
    `;

    const resultText = await processInChunks(pdfBuffer, promptText, modelName);
    const cleanedText = cleanJsonResponse(resultText);

    const parsed = JSON.parse(cleanedText);
    return parsed as ProcessoTriagemResult;
  } catch (error: any) {
    console.error("Erro no extractProcessoTriagem:", error);

    // Se falhar o parse do JSON ou a requisição direta, tenta um fallback usando gemini-2.5-flash diretamente
    try {
      const fallbackModel = ai.getGenerativeModel({ model: "gemini-2.5-flash" });
      const base64Pdf = pdfBuffer.toString("base64");

      const response = await fallbackModel.generateContent([
        {
          inlineData: {
            data: base64Pdf,
            mimeType: "application/pdf",
          },
        },
        "Extraia apenas um objeto JSON estrito com os dados do processo: numero_processo, autor, réu, vara, observacoes_para_conferencia_humana.",
      ]);

      const text = cleanJsonResponse(response.response.text());
      return JSON.parse(text) as ProcessoTriagemResult;
    } catch (fallbackError) {
      throw new Error(
        `Falha ao extrair dados do processo via Gemini: ${error?.message || error}`
      );
    }
  }
}
