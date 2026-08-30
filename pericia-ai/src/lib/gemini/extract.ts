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
        const tempoEspera = tentativa * 12000;
        console.warn(`[Gemini 429] Limite de cota atingido. Retentativa ${tentativa}/${maxTentativas} em ${tempoEspera / 1000}s...`);
        await delay(tempoEspera);
      } else {
        throw erro;
      }
    }
  }
}

function dividirTextoEmBlocos(texto: string, tamanhoMaximoCaracteres = 80000): string[] {
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

  const blocos = dividirTextoEmBlocos(textoCompleto, 80000);
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
      const jsonLimpo = textResult.replace(/```json|