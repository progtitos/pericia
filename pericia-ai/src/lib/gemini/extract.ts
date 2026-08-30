import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("A variável de ambiente GEMINI_API_KEY não está definida.");
}

const genAI = new GoogleGenerativeAI(apiKey);

// 1. Constantes exportadas exigidas por outras rotas
export const SEGUNDOS_ESTIMADOS_POR_BLOCO_FALLBACK = 4;

export interface ProgressoProcessamento {
  progresso: number;
  mensagem: string;
  tempoRestanteSegundos: number;
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
    status,
    blocos_concluidos: blocosConcluidos,
    total_blocos: totalBlocos,
    erro,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function dividirTextoEmBlocos(texto: string, tamanhoMaximoCaracteres = 180000): string[] {
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
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const textoCompleto = bufferPdf.toString("utf-8"); 

  const blocos = dividirTextoEmBlocos(textoCompleto, 180000);
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

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const textResult = response.text();

    try {
      const jsonLimpo = textResult.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(jsonLimpo);
      resultadoAcumulado = { ...resultadoAcumulado, ...parsed };
    } catch (e) {
      console.warn(`[Gemini Extract] Falha ao fazer parse do JSON no bloco ${i + 1}:`, e);
    }

    if (i < totalBlocos - 1) {
      await delay(3000);
    }
  }

  resultadoAcumulado._chunking_info = {
    totalBlocos,
    blocos: blocos.map((b, index) => ({
      indice: index + 1,
      rotulo: `Bloco ${index + 1}`,
      paginaInicial: index * 150 + 1,
      paginaFinal: Math.min((index + 1) * 150, 775),
      tokensEstimados: Math.round(b.length / 4),
    })),
  };

  return resultadoAcumulado;
}

// 2. Função de extração de extrato bancário
export async function extractExtratoBancario(bufferPdf: Buffer): Promise<any> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const texto = bufferPdf.toString("utf-8");

  const prompt = `
  Extraia as transações deste extrato bancário em formato JSON (lista de objetos com data, descricao, valor e tipo).
  Texto:
  ${texto}
  `;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  const rawText = response.text();

  try {
    const jsonStr = rawText.replace(/```json|```/g, "").trim();
    return JSON.parse(jsonStr);
  } catch {
    return { transacoes: [], raw: rawText };
  }
}

// 3. Função para geração da minuta do laudo
export async function generateLaudoMinuta(dadosProcesso: any, calculos: any): Promise<string> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `
  Elabore uma minuta de laudo pericial contábil/previdenciário com base nos dados do processo e nos cálculos fornecidos.
  Dados do Processo: ${JSON.stringify(dadosProcesso)}
  Cálculos: ${JSON.stringify(calculos)}
  `;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  return response.text();
}