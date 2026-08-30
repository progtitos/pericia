import { GoogleGenerativeAI } from "@google/generative-ai";

function getGeminiModel(modelName = "gemini-3.6-flash") {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("A variável de ambiente GOOGLE_GEMINI_API_KEY ou GEMINI_API_KEY não está definida.");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({ model: modelName });
}

export const SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK = 15;

export interface ProgressoProcessamento {
  progresso: number;
  mensagem: string;
  tempoRestanteSegundos: number;
  estimativa_segundos?: number;
  status: "processing" | "done" | "error";
  blocos_concluidos: number;
  total_blocos: number;
  erro?: string;
}

export function montarProgresso({
  status,
  blocosConcluidos,
  totalBlocos,
  segundosRestantes,
  mensagem,
  erro,
}: {
  status: "processing" | "done" | "error";
  blocosConcluidos: number;
  totalBlocos: number;
  segundosRestantes: number;
  mensagem: string;
  erro?: string;
}): ProgressoProcessamento {
  const percentual =
    totalBlocos > 0 ? Math.min(100, Math.round((blocosConcluidos / totalBlocos) * 100)) : 0;

  return {
    progresso: status === "done" ? 100 : percentual,
    mensagem,
    tempoRestanteSegundos: segundosRestantes,
    estimativa_segundos: segundosRestantes,
    status,
    blocos_concluidos: blocosConcluidos,
    total_blocos: totalBlocos,
    erro,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function chamarGeminiComRetry(model: any, promptParts: any[], maxTentativas = 3) {
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    try {
      return await model.generateContent(promptParts);
    } catch (erro: any) {
      const eTexto = String(erro);
      if (eTexto.includes("429") && tentativa < maxTentativas) {
        const tempoEspera = tentativa * 5000;
        console.warn(`[Gemini 429] Requisitando retry ${tentativa}/${maxTentativas} após ${tempoEspera / 1000}s...`);
        await delay(tempoEspera);
      } else {
        throw erro;
      }
    }
  }
}

export async function processarExtracaoProcessoFreeTier(
  bufferPdf: Buffer,
  options?: {
    anonimizarAntesDoEnvio?: boolean;
    onProgress?: (progresso: ProgressoProcessamento) => Promise<void>;
  }
): Promise<any> {
  const model = getGeminiModel("gemini-3.6-flash");

  if (options?.onProgress) {
    await options.onProgress(
      montarProgresso({
        status: "processing",
        blocosConcluidos: 0,
        totalBlocos: 1,
        segundosRestantes: 20,
        mensagem: "Analisando PDF completo com Gemini 3.6 Flash...",
      })
    );
  }

  const prompt = `
  Analise o processo judicial anexado e extraia as informações estruturadas estritamente em formato JSON válido.
  Campos necessários:
  - numero_processo
  - vara
  - autor
  - reu
  - dib
  - der
  - rmi
  - indice_determinado_pelo_juiz
  - observacoes_para_conferencia_humana
  `;

  // Envia o PDF como arquivo binário nativo para a API
  const base64Pdf = bufferPdf.toString("base64");

  const result = await chamarGeminiComRetry(model, [
    prompt,
    {
      inlineData: {
        data: base64Pdf,
        mimeType: "application/pdf",
      },
    },
  ]);

  const response = await result.response;
  const textResult = response.text();

  let parsedResult: any = {};
  try {
    const jsonLimpo = textResult
      .replaceAll("```json", "")
      .replaceAll("```", "")
      .trim();
    parsedResult = JSON.parse(jsonLimpo);
  } catch (e) {
    console.warn("[Gemini Extract] Falha ao parsear JSON:", e);
    parsedResult = { rawText: textResult };
  }

  parsedResult._chunking_info = {
    totalBlocos: 1,
    blocos: [
      {
        indice: 1,
        rotulo: "Arquivo Completo (Inline PDF)",
        paginaInicial: 1,
        paginaFinal: 775,
        tokensEstimados: 500000,
      },
    ],
  };

  return parsedResult;
}

export async function extractExtratoBancario(
  fileBase64: string,
  mimeType: string = "application/pdf"
): Promise<any> {
  const model = getGeminiModel("gemini-3.6-flash");

  const prompt = `
  Extraia os dados deste extrato bancário em formato JSON.
  Retorne um objeto JSON contendo:
  - banco: string
  - conta: string
  - periodo: string
  - transacoes: lista de objetos { data, descricao, valor, tipo }
  `;

  const result = await chamarGeminiComRetry(model, [
    prompt,
    {
      inlineData: {
        data: fileBase64,
        mimeType,
      },
    },
  ]);

  const response = await result.response;
  const rawText = response.text();

  try {
    const jsonStr = rawText
      .replaceAll("```json", "")
      .replaceAll("```", "")
      .trim();
    return JSON.parse(jsonStr);
  } catch {
    return { banco: "", conta: "", periodo: "", transacoes: [], raw: rawText };
  }
}

export async function generateLaudoMinuta(
  paramsOrDados: any,
  calculos?: any
): Promise<string> {
  const model = getGeminiModel("gemini-3.6-flash");

  let dadosPrompt = "";
  if (calculos !== undefined) {
    dadosPrompt = `Dados do Processo: ${JSON.stringify(paramsOrDados)}\nCálculos: ${JSON.stringify(calculos)}`;
  } else {
    dadosPrompt = `Parâmetros do Laudo: ${JSON.stringify(paramsOrDados)}`;
  }

  const prompt = `
  Elabore uma minuta de laudo pericial contábil/previdenciário com base nas informações fornecidas.
  ${dadosPrompt}
  `;

  const result = await chamarGeminiComRetry(model, [prompt]);
  const response = await result.response;
  return response.text();
}