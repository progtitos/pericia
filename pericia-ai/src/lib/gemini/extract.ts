import { getGeminiClient, MODELS } from "./client";

/**
 * Interfaces dos dados extraídos do processo, extrato e laudo.
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
 * Função utilitária para limpar blocos de código Markdown retornados pela API.
 */
function cleanJsonResponse(rawText: string): string {
  return rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * 1. Extração do Processo para Triagem
 */
export async function extractProcessoTriagem(
  pdfBuffer: Buffer
): Promise<ProcessoTriagemResult> {
  const ai = getGeminiClient();
  const modelName = MODELS.PRO || "gemini-2.5-flash";
  const model = ai.getGenerativeModel({ model: modelName });

  try {
    const base64Pdf = pdfBuffer.toString("base64");
    const response = await model.generateContent([
      {
        inlineData: {
          data: base64Pdf,
          mimeType: "application/pdf",
        },
      },
      `Você é um perito judicial especialista. Analise o texto do processo fornecido e extraia um JSON estrito com os dados numéricos e jurídicos essenciais para o recálculo.
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
    ]);

    const cleanedText = cleanJsonResponse(response.response.text());
    return JSON.parse(cleanedText) as ProcessoTriagemResult;
  } catch (error: any) {
    console.error("Erro no extractProcessoTriagem:", error);
    throw new Error(`Falha ao extrair dados do processo: ${error?.message || error}`);
  }
}

/**
 * 2. Extração de Extrato Bancário (aceita Buffer ou Base64 + MimeType opcional)
 */
export async function extractExtratoBancario(
  fileInput: Buffer | string,
  mimeType: string = "application/pdf"
): Promise<any> {
  const ai = getGeminiClient();
  const modelName = MODELS.FLASH || "gemini-2.5-flash";
  const model = ai.getGenerativeModel({ model: modelName });

  try {
    const base64Data =
      typeof fileInput === "string"
        ? fileInput
        : fileInput.toString("base64");

    const response = await model.generateContent([
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
        "lancamentos": [
          { "data": "YYYY-MM-DD", "descricao": "string", "valor": 0.0, "tipo": "C ou D" }
        ]
      }`,
    ]);

    const cleanedText = cleanJsonResponse(response.response.text());
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
  const modelName = MODELS.PRO || "gemini-2.5-flash";
  const model = ai.getGenerativeModel({ model: modelName });

  try {
    const response = await model.generateContent([
      `Com base nos dados periciais fornecidos abaixo, elabore a minuta do laudo pericial em formato JSON estrito:
      ${JSON.stringify(data)}
      
      Retorne:
      {
        "titulo": "string",
        "resumo_executivo": "string",
        "metodologia": "string",
        "conclusao": "string"
      }`,
    ]);

    const cleanedText = cleanJsonResponse(response.response.text());
    return JSON.parse(cleanedText);
  } catch (error: any) {
    console.error("Erro no generateLaudoMinuta:", error);
    throw new Error(`Falha ao gerar minuta: ${error?.message || error}`);
  }
}