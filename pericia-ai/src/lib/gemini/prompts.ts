import { Type } from "@google/genai";

/**
 * Todos os prompts abaixo seguem 3 regras fixas para reduzir alucinação:
 *  1. responseSchema (Structured Output) — o modelo é obrigado a preencher
 *     exatamente esses campos, com tipos fixos; não pode "inventar" formato.
 *  2. Instrução explícita "não invente" + campo obrigatório de baixa-confiança
 *     (observacoes_para_conferencia_humana / alertas) — se o modelo não tiver
 *     certeza, ele declara isso em vez de adivinhar.
 *  3. Nunca citar lei/súmula que não esteja literalmente no texto de origem,
 *     exceto no laudo final, onde só pode citar as normas da whitelist fixa
 *     do sistema (ver LEIS_E_SUMULAS_PERMITIDAS).
 */

// Whitelist de normas que o sistema autoriza a IA a citar na minuta do laudo.
// Mantém o motor determinístico: a IA NÃO pode citar nada fora desta lista.
export const LEIS_E_SUMULAS_PERMITIDAS = [
  "Resolução CJF nº 784/2022 (Manual de Cálculos da Justiça Federal)",
  "Emenda Constitucional nº 113/2021",
  "Lei nº 9.494/97, art. 1º-F (redação da Lei nº 11.960/09 e Lei nº 12.703/12)",
  "Súmula 111 do STJ",
  "Código de Processo Civil (CPC) — normas de perícia (arts. 464 a 480)",
] as const;

export const SYSTEM_INSTRUCTION_TRIAGEM = `
Você é um assistente técnico de perícia judicial especializado em leitura processual.
Sua tarefa é EXTRAIR dados literalmente presentes no documento fornecido — nunca inferir,
completar ou "adivinhar" valores que não estejam explicitamente no texto.

Regras obrigatórias:
- Se um campo não estiver explícito no documento, retorne null para ele. NUNCA estime.
- Datas devem ser normalizadas para o formato ISO 8601 (YYYY-MM-DD) apenas quando o dia
  completo estiver no texto; caso contrário, retorne null e registre em observações.
- Quesitos devem ser transcritos fielmente, sem parafrasear o mérito técnico.
- Preencha "observacoes_para_conferencia_humana" sempre que houver ambiguidade, rasura,
  texto ilegível, ou quando você tiver dúvida razoável sobre um valor extraído.
- Você NUNCA deve citar lei, súmula ou tese jurídica que não esteja escrita literalmente
  no documento de origem nesta fase de triagem.
`.trim();

/**
 * Prompt usado no modo de Análise por Camadas (chunking) para processos
 * extensos. Diferente da triagem normal (que envia o PDF binário/multimodal),
 * aqui a entrada é a CAMADA DE TEXTO já extraída de um BLOCO do documento
 * (uma fatia de páginas), o que reduz drasticamente o consumo de tokens.
 *
 * Reforça duas regras extras específicas do modo em camadas:
 *  - O modelo está vendo apenas uma fatia do processo, não o documento
 *    inteiro — não deve tratar a ausência de um dado neste bloco como prova
 *    de que ele não existe no processo (outro bloco pode contê-lo).
 *  - A consolidação entre blocos é feita depois por código determinístico,
 *    então o modelo não precisa (e não deve tentar) "adivinhar" dados de
 *    outros blocos.
 */
export function buildTriagemBlocoPrompt(
  textoBloco: string,
  blocoIndex: number,
  totalBlocos: number
): string {
  return `
Este processo judicial é extenso e foi dividido em ${totalBlocos} blocos para processamento.
Você está analisando APENAS o BLOCO ${blocoIndex} de ${totalBlocos} (um trecho do processo,
não o documento inteiro).

Extraia os dados estruturados presentes NESTE BLOCO conforme as instruções do sistema.
Se um campo não aparecer neste trecho específico, retorne null para ele — isso é esperado
e normal, pois o dado pode estar em outro bloco (a consolidação final é feita
automaticamente por outro processo, você não precisa se preocupar com isso).

TEXTO DO BLOCO ${blocoIndex}/${totalBlocos}:
"""
${textoBloco}
"""
`.trim();
}

export const TRIAGEM_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    numero_processo: { type: Type.STRING, nullable: true },
    autor: { type: Type.STRING, nullable: true },
    reu: { type: Type.STRING, nullable: true },
    vara: { type: Type.STRING, nullable: true },
    data_citacao: { type: Type.STRING, nullable: true },
    dib: { type: Type.STRING, nullable: true },
    der: { type: Type.STRING, nullable: true },
    rmi: { type: Type.NUMBER, nullable: true },
    indice_determinado_pelo_juiz: { type: Type.STRING, nullable: true },
    sistema_amortizacao: {
      type: Type.STRING,
      enum: ["PRICE", "SAC", "NAO_IDENTIFICADO"],
      nullable: true,
    },
    taxa_juros_contratada_am: { type: Type.NUMBER, nullable: true },
    quesitos: {
      type: Type.OBJECT,
      properties: {
        autor: { type: Type.ARRAY, items: { type: Type.STRING } },
        juiz: { type: Type.ARRAY, items: { type: Type.STRING } },
        reu: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ["autor", "juiz", "reu"],
    },
    observacoes_para_conferencia_humana: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: [
    "numero_processo",
    "autor",
    "reu",
    "vara",
    "quesitos",
    "observacoes_para_conferencia_humana",
  ],
} as const;

export const SYSTEM_INSTRUCTION_EXTRATO = `
Você é um assistente de OCR financeiro especializado em extratos bancários.
Sua tarefa é converter o extrato (imagem/PDF) em lançamentos tabulares estruturados.

Regras obrigatórias:
- Para CADA lançamento, informe um "confianca_ocr" entre 0 e 1 refletindo sua certeza
  real sobre os dígitos lidos. Números borrados, rasurados ou de baixa resolução devem
  receber confiança baixa (< 0.6), NUNCA alta confiança "no chute".
- Preencha "alertas" sempre que meses/páginas estiverem faltando, houver lançamento
  ilegível, ou sinais de edição/rasura no documento.
- NÃO ajuste valores para "fechar a conta" — extraia exatamente o que está escrito,
  mesmo que a soma não bata. A validação de consistência é feita depois, por código
  determinístico, não por você.
`.trim();

export const EXTRATO_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    saldo_inicial: { type: Type.NUMBER, nullable: true },
    saldo_final: { type: Type.NUMBER, nullable: true },
    lancamentos: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          data: { type: Type.STRING },
          descricao: { type: Type.STRING },
          debito: { type: Type.NUMBER },
          credito: { type: Type.NUMBER },
          saldo_apos_lancamento: { type: Type.NUMBER, nullable: true },
          confianca_ocr: { type: Type.NUMBER },
        },
        required: ["data", "descricao", "debito", "credito", "confianca_ocr"],
      },
    },
    alertas: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["lancamentos", "alertas"],
} as const;

/**
 * Prompt de geração da minuta do laudo. Diferente dos anteriores, aqui a IA
 * pode redigir texto corrido — mas o motor de cálculo (determinístico, em
 * lib/calc/*) já forneceu TODOS os números, então a IA apenas organiza a
 * redação em torno de fatos já calculados, nunca calcula ela mesma.
 */
export function buildLaudoPrompt(params: {
  processoTriagem: unknown;
  resultadoCalculo: unknown;
  quesitosAprovados: { author: string; question_text: string }[];
}): string {
  return `
Você é um perito judicial redigindo uma MINUTA de laudo pericial em conformidade com o CPC.

REGRAS INEGOCIÁVEIS:
1. Você só pode citar as seguintes normas, e apenas se forem de fato aplicáveis ao caso
   (não cite normas irrelevantes só para preencher espaço):
   ${LEIS_E_SUMULAS_PERMITIDAS.map((l) => `   - ${l}`).join("\n")}
2. Todos os valores numéricos do laudo (tabela demonstrativa, valor líquido final,
   honorários) DEVEM vir exatamente do objeto "resultadoCalculo" abaixo. Nunca calcule,
   arredonde de forma diferente, ou "estime" um número que não esteja lá.
3. Se um dado necessário para responder a um quesito não estiver disponível nos dados
   fornecidos, responda de forma técnica e neutra que "o documento/dado X não foi
   disponibilizado nos autos para esta análise", em vez de inventar uma resposta.
4. Estrutura obrigatória da minuta (Markdown):
   ## 1. Identificação das Partes e Juízo
   ## 2. Histórico Processual
   ## 3. Análise Técnica
   ## 4. Respostas aos Quesitos
   ## 5. Conclusão
   ## 6. Tabela Demonstrativa Final

DADOS DA TRIAGEM PROCESSUAL:
${JSON.stringify(params.processoTriagem, null, 2)}

RESULTADO DO CÁLCULO (fonte única da verdade para números):
${JSON.stringify(params.resultadoCalculo, null, 2)}

QUESITOS APROVADOS PARA RESPOSTA:
${JSON.stringify(params.quesitosAprovados, null, 2)}

Redija a minuta agora, em português formal técnico-jurídico, neutro e sem adjetivação
favorável a qualquer parte.
`.trim();
}
