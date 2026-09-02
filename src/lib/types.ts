export interface TokenPreviewInfo {
  totalTokens?: number;
  totalBlocos?: number;
  estimativaSegundos?: number;
  modelLimit?: number;
  percentualOcupado?: number;
  status?: TokenWindowStatus;
  exigeChunking?: boolean;
}