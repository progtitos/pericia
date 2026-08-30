import { GoogleGenerativeAI } from "@google/generative-ai";

function getGeminiModel(modelName = "gemini-3.6-flash") {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("A variável de ambiente GOOGLE_GEMINI_API_KEY ou GEMINI_API_KEY não está definida.");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({ model: modelName });
}

export const SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK = 12;

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

async function chamarGeminiComRetry(model: any, prompt: any, maxTentativas = 4) {
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    try {
      return await model.generateContent(prompt);
    } catch (erro: any) {
      const eTexto = String(erro);
      if (eTexto.includes("429") && tentativa < maxTentativas) {
        const tempoEspera = tentativa * 10000;
        console.warn(`[Gemini 429] Cota atingida. Tentativa ${tentativa}/${maxTentativas} aguardando ${tempoEspera / 1000}s...`);
        await delay(tempoEspera);
      } else {
        throw erro;
      }
    }
  }
}

// Blocos maiores de 900k caracteres (aprox. 50-60 páginas por bloco)
function dividirTextoEmBlocos(texto: string, tamanhoMaximoCaracteres = 900000): string[] {
  if (texto.length <= tamanhoMaximoCaracteres) {
    return [texto];
  }

  const blocos: string[] = [];
  let inicio = 0;

  while (inicio < texto.length) {
    let fim = inicio + tamanhoMaximoCaracteres;
    if (fim < texto.length) {
      const ultimaQuebra = texto.lastIndexOf("\n", fim);
      if (ultimaQuebra > inicio + tamanhoMaximoCaracteres * 0.7) {
        fim = ultimaQuebra;
      }
    } else {
      fim = texto.length;
    }

    blocos.push(texto.slice(inicio, fim));
    inicio = fim;
  }

  return blocos;
}

export async function processarExtracaoProcessoFreeTier(
  bufferPdf: Buffer,
  options?: {
    anonimizarAntesDoEnvio?: boolean;
    onProgress?: (progresso: ProgressoProcessamento) => Promise<void>;
  }
): Promise<any> {
  const model = getGeminiModel("gemini-3.6-flash");
  const textoCompleto = bufferPdf.toString("utf-8");

  // Ajustado para 900.000 caracteres por bloco
  const blocos = dividirTextoEmBlocos(textoCompleto, 900000);
  const totalBlocos = blocos.length;

  let resultadoAcumulado: any = {};

  for (let i = 0; i < totalBlocos; i++) {
    const blocoAtual = blocos[i];
    const blocosConcluidos = i;
    const blocosRestantes = totalBlocos - blocosConcluidos;
    const tempoEstimadoSegundos = blocosRestantes * SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK;

    if (options?.onProgress) {
      await options.onProgress(
        montarProgresso({
          status: "processing",
          blocosConcluidos,
          totalBlocos,
          segundosRestantes: tempoEstimadoSegundos,
          mensagem: `Processando bloco ${i + 1} de ${totalBlocos}...`,
        })
      );
    }

    const prompt = `
    Analise o seguinte trecho de um processo judicial e extraia as informações estruturadas em formato JSON.
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

    Texto do bloco:
    ${blocoAtual}
    `;

    const result = await chamarGeminiComRetry(model, prompt);
    const response = await result.response;
    const textResult = response.text();

    try {
      const jsonLimpo = textResult
        .replaceAll("```json", "")
        .replaceAll("```", "")
        .trim();
      const parsed = JSON.parse(jsonLimpo);
      resultadoAcumulado = { ...resultadoAcumulado, ...parsed };
    } catch (e) {
      console.warn(`[Gemini Extract] Falha no parse do bloco ${i + 1}:`, e);
    }

    if (i < totalBlocos - 1) {
      await delay(4000); // Intervalo reduzido para agilizar a fila
    }
  }

  resultadoAcumulado._chunking_info = {
    totalBlocos,
    blocos: blocos.map((b, index) => ({
      indice: index + 1,
      rotulo: `Bloco ${index + 1}`,
      paginaInicial: index * 60 + 1,
      paginaFinal: Math.min((index + 1) * 60, 775),
      tokensEstimados: Math.round(b.length / 4),
    })),
  };

  return resultadoAcumulado;
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

  const result = await chamarGeminiComRetry(model, prompt);
  const response = await result.response;
  return response.text();
}