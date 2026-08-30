import { GoogleAIFileManager } from "@google/generative-ai/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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
  if (!rawText) return "{}";
  
  // Limpa blocos de código Markdown como ```json ... ```
  let cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Garante que pega apenas do primeiro '{' até o último '}'
  const startIdx = cleaned.indexOf("{");
  const endIdx = cleaned.lastIndexOf("}");
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }

  return cleaned;
}

/**
 * Processamento via Files API do Gemini (Para contas do plano PAGO com documentos gigantescos)
 */
export async function extractProcessoTriagem(
  pdfBuffer: Buffer
): Promise<ProcessoTriagemResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("A chave GEMINI_API_KEY não foi configurada nas variáveis de ambiente.");
  }

  const fileManager = new GoogleAIFileManager(apiKey);
  const genAI = new GoogleGenerativeAI(apiKey);

  // 1. Salva o PDF no disco temporário do servidor
  const tempFilePath = path.join(os.tmpdir(), `processo_${Date.now()}.pdf`);
  await fs.promises.writeFile(tempFilePath, pdfBuffer);

  let uploadResult: any = null;

  try {
    // 2. Upload para a Files API do Gemini
    uploadResult = await fileManager.uploadFile(tempFilePath, {
      mimeType: "application/pdf",
      displayName: "Processo Judicial Compl.",
    });

    // 3. Aguarda o processamento interno do arquivo no Google
    let fileState = await fileManager.getFile(uploadResult.file.name);
    let attempts = 0;
    while (fileState.state === "PROCESSING" && attempts < 15) {
      await new Promise((res) => setTimeout(res, 2000));
      fileState = await fileManager.getFile(uploadResult.file.name);
      attempts++;
    }

    if (fileState.state === "FAILED") {
      throw new Error("O Google Gemini não conseguiu processar a estrutura desse PDF.");
    }

    // 4. Utiliza o modelo gemini-1.5-flash (capaz de ler até 1 a 2 milhões de tokens)
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: {
        responseMimeType: "application/json", // Força resposta em JSON puro nativo
      },
    });

    const prompt = `Você é um perito judicial especialista. Analise o processo judicial anexo e extraia os dados estritamente em formato JSON com o seguinte schema:
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
}`;

    const response = await model.generateContent([
      {
        fileData: {
          mimeType: uploadResult.file.mimeType,
          fileUri: uploadResult.file.uri,
        },
      },
      prompt,
    ]);

    const rawText = response.response.text();
    const cleanedText = cleanJsonResponse(rawText);

    try {
      return JSON.parse(cleanedText) as ProcessoTriagemResult;
    } catch (parseErr) {
      console.error("Erro ao converter JSON do Gemini:", rawText);
      throw new Error("O modelo não retornou um formato JSON válido. Tente novamente.");
    }
  } finally {
    // Limpeza de arquivos temporários
    if (fs.existsSync(tempFilePath)) {
      await fs.promises.unlink(tempFilePath).catch(() => {});
    }
    if (uploadResult?.file?.name) {
      await fileManager.deleteFile(uploadResult.file.name).catch(() => {});
    }
  }
}

export async function extractExtratoBancario(
  fileInput: Buffer | string,
  mimeType: string = "application/pdf"
): Promise<any> {
  const apiKey = process.env.GEMINI_API_KEY || "";
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const base64Data =
    typeof fileInput === "string" ? fileInput : fileInput.toString("base64");

  const response = await model.generateContent([
    {
      inlineData: {
        data: base64Data,
        mimeType: mimeType,
      },
    },
    `Extraia as movimentações financeiras do extrato bancário em formato JSON estrito.`,
  ]);

  return JSON.parse(cleanJsonResponse(response.response.text()));
}

export async function generateLaudoMinuta(data: any): Promise<any> {
  const apiKey = process.env.GEMINI_API_KEY || "";
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const response = await model.generateContent([
    `Com base nos dados periciais, elabore a minuta do laudo em JSON: ${JSON.stringify(data)}`,
  ]);

  return JSON.parse(cleanJsonResponse(response.response.text()));
}