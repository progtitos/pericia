// Tipos de domínio compartilhados entre frontend, API routes e motor de cálculo.

export type CaseType =
  | "previdenciario"
  | "bancario_financiamento"
  | "cartao_credito"
  | "sfh";

export type CaseStatus = "triagem" | "calculo" | "redacao" | "concluido";

/** Metadados extraídos da Fase 1 (triagem do processo) pelo Gemini. */
export interface ProcessoTriagemExtraido {
  numero_processo: string | null;
  autor: string | null;
  reu: string | null;
  vara: string | null;
  data_citacao: string | null; // ISO 8601
  dib: string | null; // Data de Início do Benefício
  der: string | null; // Data de Entrada do Requerimento
  rmi: number | null; // Renda Mensal Inicial
  indice_determinado_pelo_juiz: string | null; // ex: "IPCA-E"
  sistema_amortizacao: "PRICE" | "SAC" | "NAO_IDENTIFICADO" | null;
  taxa_juros_contratada_am: number | null;
  quesitos: {
    autor: string[];
    juiz: string[];
    reu: string[];
  };
  observacoes_para_conferencia_humana: string[]; // pontos de baixa confiança do OCR/LLM
  /** Presente apenas quando o processo excedeu o limite seguro e foi processado
   *  em camadas (chunking). Ausente/undefined em extrações de documento único. */
  _chunking_info?: ChunkingInfo;
}

/** Status de capacidade da janela de contexto, usado na prévia de upload. */
export type TokenWindowStatus = "ok" | "atencao" | "critico";

/** Estimativa de consumo de tokens de um arquivo antes do envio à IA. */
export interface TokenPreviewInfo {
  totalTokens: number;
  modelLimit: number;
  percentualOcupado: number; // 0 a 100
  status: TokenWindowStatus;
  exigeChunking: boolean; // true quando ultrapassa o limite seguro configurado
  totalPaginas?: number;
  /** true quando totalTokens vem de estimativa por caracteres (documento
   *  grande demais para chamar a API real de contagem com segurança), false
   *  quando vem de contagem real via API do Gemini. */
  estimado?: boolean;
}

/** Um bloco/camada de um documento dividido por estratégia de chunking. */
export interface ChunkingBlockInfo {
  indice: number; // 1-based
  rotulo: string; // ex: "Petição Inicial / Cálculos", "Sentença / Decisão"
  paginaInicial: number;
  paginaFinal: number;
  tokensEstimados: number;
}

/** Metadados de como um documento extenso foi dividido e processado. */
export interface ChunkingInfo {
  chunked: true;
  totalBlocos: number;
  blocos: ChunkingBlockInfo[];
}

/** Uma linha normalizada de extrato bancário extraída via OCR multimodal. */
export interface LinhaExtratoExtraida {
  data: string; // ISO 8601
  descricao: string;
  debito: number;
  credito: number;
  saldo_apos_lancamento: number | null;
  confianca_ocr: number; // 0 a 1
}

export interface ExtratoExtraido {
  saldo_inicial: number | null;
  saldo_final: number | null;
  lancamentos: LinhaExtratoExtraida[];
  alertas: string[];
}

export interface ReconciliacaoResultado {
  saldo_inicial: number;
  saldo_final_informado: number | null;
  saldo_final_calculado: number;
  divergencia: number;
  consistente: boolean;
  linhas_suspeitas: number[]; // índices em lancamentos com confianca_ocr baixa
}

export interface ParametrosCalculoPrevidenciario {
  rmi: number;
  dib: string;
  data_citacao: string;
  data_base_calculo: string; // normalmente data da sentença/decisão
  indice_ate_112021: "IPCA-E" | "INPC";
}

export interface CompetenciaCalculada {
  competencia: string; // "YYYY-MM"
  valor_original: number;
  indice_aplicado: "IPCA-E" | "INPC" | "SELIC" | "POUPANCA";
  taxa_indice: number;
  correcao_monetaria: number;
  juros: number;
  valor_corrigido: number;
}

export interface ResultadoCalculoPrevidenciario {
  competencias: CompetenciaCalculada[];
  valor_total_bruto: number;
  honorarios_sucumbenciais: number; // aplicando Súmula 111/STJ
  valor_liquido_final: number;
  base_legal: string[];
}
