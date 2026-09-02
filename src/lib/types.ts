// Tipos de domínio compartilhados entre frontend, API routes e motor de cálculo.

export type CaseType =
  | "previdenciario"
  | "bancario_financiamento"
  | "cartao_credito"
  | "sfh";

export type CaseStatus = "triagem" | "calculo" | "redacao" | "concluido";

/** Metadados extraídos da Fase 1 (triagem do processo) pela IA (Claude). */
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
  observacoes_para_conferencia_humana: string[]; // pontos de baixa confiança da extração
  _chunking_info?: {
    chunked?: boolean;
    totalBlocos?: number;
    blocos?: ChunkingBlockInfo[];
  };
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

/** Tipagens auxiliares para chunking e contagem de tokens */
export interface ChunkingBlockInfo {
  id?: string;
  index?: number;
  indice?: number;
  rotulo?: string;
  paginaInicial?: number;
  paginaFinal?: number;
  texto?: string;
  tokens?: number;
  tokensEstimados?: number;
  status?: string;
}

export type TokenWindowStatus = "ok" | "atencao" | "critico";

export interface TokenPreviewInfo {
  totalTokens?: number;
  totalBlocos?: number;
  estimativaSegundos?: number;
  modelLimit?: number;
  percentualOcupado?: number;
  status?: TokenWindowStatus;
  exigeChunking?: boolean;
  totalPaginas?: number;
  estimado?: boolean;
}