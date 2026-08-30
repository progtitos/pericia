import { getGeminiClient, MODELS } from "@/lib/gemini/client";
import {
  SYSTEM_INSTRUCTION_TRIAGEM,
  TRIAGEM_RESPONSE_SCHEMA,
  SYSTEM_INSTRUCTION_EXTRATO,
  EXTRATO_RESPONSE_SCHEMA,
  buildLaudoPrompt,
} from "@/lib/gemini/prompts";
import {
  extractPdfPagesText,
  buildTokenPreview,
  processarProcessoEmCamadas,
  isTokenLimitError,
} from "@/lib/gemini/chunking";
import type { ProcessoTriagemExtraido, ExtratoExtraido } from "@/lib/types";

/**
 * Fase 1: Triagem processual (PDF -> JSON estruturado).
 *
 * Fluxo (ver src/lib/gemini/chunking.ts para os detalhes de cada etapa):
 *   1. Extrai a camada de TEXTO do PDF e já remove ruído judicial repetido
 *      por página (timbre, assinatura eletrônica, numeração de folha).
 *   2. Decide se precisa de chunking usando estimativa por caracteres
 *      primeiro (barata); só confirma com contagem real de tokens quando
 *      isso já é seguro fazer — nunca conta tokens do documento inteiro às
 *      cegas, o que evita estourar antes mesmo de chegar ao chunking.
 *   3. Se couber dentro do limite seguro, envia o texto inteiro em uma
 *      única chamada. Caso contrário, processa em blocos de 200k-300k
 *      tokens (map-reduce determinístico).
 *   4. Rede de segurança final: se mesmo assim a API recusar por
 *      excedimento de contexto, cai automaticamente para o modo em camadas.
 *
 * @param pdfBuffer conteúdo binário do PDF
 * @param onProgress callback opcional para reportar progresso do chunking à UI
 */
export async function extractProcessoTriagem(
  pdfBuffer: Buffer,
  onProgress?: (blocoAtual: number, totalBlocos: number, rotulo: string) => void
): Promise<ProcessoTriagemExtraido> {
  const pages = await extractPdfPagesText(pdfBuffer);
  const { preview, fullText } = await buildTokenPreview(pages);

  if (preview.exigeChunking) {
    return processarProcessoEmCamadas(pages, onProgress);
  }

  try {
    return await extractProcessoTriagemFromText(fullText);
  } catch (err) {
    // Rede de segurança: mesmo com a prévia indicando estar dentro do limite,
    // overhead de schema/system prompt ou variações do modelo podem ainda
    // assim estourar o contexto. Nesse caso, tentamos automaticamente pelo
    // modo em camadas antes de propagar o erro ao usuário.
    if (isTokenLimitError(err)) {
      return processarProcessoEmCamadas(pages, onProgress);
    }
    throw err;
  }
}

/** Extração estruturada a partir de texto puro já extraído e limpo do PDF. */
async function extractProcessoTriagemFromText(
  texto: string
): Promise<ProcessoTriagemExtraido> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: MODELS.PRO,
    contents: [
      {
        role: "user",
        parts: [{ text: `Extraia os dados deste processo judicial conforme instruções do sistema.\n\nTEXTO:\n"""\n${texto}\n"""` }],
      },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION_TRIAGEM,
      responseMimeType: "application/json",
      responseSchema: TRIAGEM_RESPONSE_SCHEMA,
      temperature: 0, // determinismo máximo para tarefa de extração factual
    },
  });

  return JSON.parse(response.text ?? "{}") as ProcessoTriagemExtraido;
}

/**
 * Fase 2: OCR de extrato bancário (PDF/imagem -> lançamentos tabulares).
 * Continua multimodal (envia a imagem/PDF binário) porque a confiança do
 * OCR de números rasurados/borrados depende do sinal visual — diferente da
 * triagem processual, aqui o "texto puro" não é suficiente para o objetivo
 * (checar rasura exige ver o traço, não só ler o dígito).
 */
export async function extractExtratoBancario(
  fileBase64: string,
  mimeType: "application/pdf" | "image/png" | "image/jpeg"
): Promise<ExtratoExtraido> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: MODELS.PRO,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: fileBase64 } },
          {
            text: "Converta este extrato bancário em lançamentos estruturados conforme instruções do sistema.",
          },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION_EXTRATO,
      responseMimeType: "application/json",
      responseSchema: EXTRATO_RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  return JSON.parse(response.text ?? "{}") as ExtratoExtraido;
}

/**
 * Fase 4: Geração da minuta do laudo. Texto livre (Markdown), mas 100% dos
 * números vêm do resultado do motor de cálculo determinístico — a IA apenas
 * organiza a redação (ver regras em buildLaudoPrompt).
 */
export async function generateLaudoMinuta(params: {
  processoTriagem: unknown;
  resultadoCalculo: unknown;
  quesitosAprovados: { author: string; question_text: string }[];
}): Promise<string> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: MODELS.PRO,
    contents: [{ role: "user", parts: [{ text: buildLaudoPrompt(params) }] }],
    config: {
      temperature: 0.2, // pequena liberdade estilística, mantendo rigor factual
    },
  });

  return response.text ?? "";
}
