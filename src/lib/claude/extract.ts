// src/lib/claude/extract.ts
import Anthropic from "@anthropic-ai/sdk";
import type { ProcessoTriagemExtraido } from "@/lib/types";

export interface ProgressoProcessamento {
  progresso?: number;
  mensagem?: string;
  tempoRestanteSegundos?: number;
  estimativa_segundos?: number;
  status?: "processing" | "done" | "error";
  total_blocos?: number;
  blocos_concluidos?: number;
  etapa?: string;
  erro?: string;
}

export function getClaudeClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("A chave ANTHROPIC_API_KEY não está configurada.");
  }
  return new Anthropic({ apiKey });
}

export async function processarTextoProcesso(
  texto: string,
  caseId?: string,
  onProgress?: (info: ProgressoProcessamento) => void
): Promise<ProcessoTriagemExtraido> {
  const anthropic = getClaudeClient();

  const response = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 4000,
    temperature: 0,
    system: "Você é um assistente pericial especializado em triagem de processos judiciais.",
    tools: [
      {
        name: "salvar_triagem_processo",
        description: "Extrai os dados estruturados do processo.",
        input_schema: {
          type: "object",
          properties: {
            numero_processo: { type: ["string", "null"] },
            vara: { type: ["string", "null"] },
            autor: { type: ["string", "null"] },
            reu: { type: ["string", "null"] },
            dib: { type: ["string", "null"] },
            der: { type: ["string", "null"] },
            rmi: { type: ["number", "null"] },
            indice_determinado_pelo_juiz: { type: ["string", "null"] },
            data_citacao: { type: ["string", "null"] },
            sistema_amortizacao: { type: ["string", "null"] },
            taxa_juros_contratada_am: { type: ["number", "null"] },
            observacoes_para_conferencia_humana: {
              type: "array",
              items: { type: "string" },
            },
            quesitos: {
              type: "object",
              properties: {
                autor: { type: "array", items: { type: "string" } },
                juiz: { type: "array", items: { type: "string" } },
                reu: { type: "array", items: { type: "string" } },
              },
              required: ["autor", "juiz", "reu"],
            },
          },
          required: ["numero_processo", "autor", "reu", "quesitos"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "salvar_triagem_processo" },
    messages: [{ role: "user", content: texto }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Falha ao extrair dados com o Claude.");
  }

  return toolUse.input as ProcessoTriagemExtraido;
}

export async function extractExtratoBancario(fileBase64OrText: string) {
  return { lancamentos: [] };
}