import { Type, Schema } from "@google/genai";

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
 *
 * IMPORTANTE (leitura obrigatória antes de editar estes prompts):
 * Os prompts de triagem (SYSTEM_INSTRUCTION_TRIAGEM e buildTriagemBlocoPrompt)
 * são "ultra-diretos": eles NUNCA devem pedir para o modelo descrever, analisar
 * ou considerar layout, timbre, carimbo, cabeçalho/rodapé, logotipo, numeração
 * de folha ou bloco de assinatura eletrônica. Essas coisas não carregam dados
 * de cálculo e só existem para inflar o consumo de tokens em processos longos.
 * O trabalho de REMOVER esse ruído do texto já é feito antes, por código
 * determinístico, em chunking.ts (função limparRuidoJudicial) — o prompt só
 * precisa dizer "extraia os dados", não "ignore o carimbo", porque na prática
 * o carimbo já nem chega no texto que o modelo recebe.
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

/**
 * Prompt ultra-direto: só texto puro e dados de cálculo. Deliberadamente
 * SEM qualquer menção a layout/formatação — o modelo não precisa "aprender"
 * a ignorar timbre/carimbo/assinatura porque essas partes já foram removidas
 * do texto antes de chegar aqui (ver limparRuidoJudicial em chunking.ts).
 */
export const SYSTEM_INSTRUCTION_TRIAGEM = `
Você extrai dados de cálculo pericial de texto puro de processos judiciais: partes,
vara, datas (DIB, DER, citação), valores (RMI), índice determinado, sistema de
amortização, quesitos e decisões do juiz.

Regras:
- Extraia apenas o que está literalmente no texto. Campo ausente = null. Nunca estime.
- Datas em ISO 8601 (YYYY-MM-DD) somente se o dia completo estiver no texto.
- Quesitos: transcreva fielmente, sem parafrasear o mérito.
- Registre em "observacoes_para_conferencia_humana" qualquer ambiguidade, trecho
  cortado/ilegível ou dúvida razoável sobre um valor.
- Nunca cite lei, súmula ou tese que não esteja escrita literalmente no texto.
`.trim();

/**
 * Prompt usado no modo de Análise por Camadas (chunking) para processos
 * extensos. A entrada é a CAMADA DE TEXTO já extraída e já limpa de ruído
 * (ver chunking.ts) de um BLOCO do documento — nunca o PDF binário.
 * Mantido curto de propósito: cada token gasto aqui é overhead repetido em
 * TODOS os blocos, então o preâmbulo precisa ser o menor possível.
 */
export function buildTriagemBlocoPrompt(
  textoBloco: string,
  blocoIndex: number,
  totalBlocos: number
): string {
  return `
Bloco ${blocoIndex}/${totalBlocos} de um processo extenso (trecho, não o documento inteiro).
Extraia os dados presentes NESTE trecho. Campo ausente aqui = null (pode estar em outro
bloco; a consolidação é automática, feita por outro processo).

TEXTO:
"""
${textoBloco}
"""
`.trim();
}

// IMPORTANTE: NÃO use "as const" aqui. "as const" torna toda a árvore do
// objeto (incluindo os arrays de "enum") readonly (ex: readonly ["PRICE", "SAC"]),
// mas o tipo `Schema` do SDK @google/genai espera `enum?: string[]` mutável.
// A tipagem explícita `: Schema` já garante que os literais de `type: Type.X`
// sejam entendidos corretamente pelo TypeScript, sem precisar de "as const".
export const TRIAGEM_RESPONSE_SCHEMA: Schema = {
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
};

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

export const EXTRATO_RESPONSE_SCHEMA: Schema = {
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
};

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
