/**
 * Placeholder de tipos do banco. Para tipagem completa e autocompletar de
 * colunas, gere o arquivo real com a Supabase CLI depois de rodar o schema:
 *
 *   supabase gen types typescript --project-id SEU_PROJETO > src/lib/supabase/types.ts
 *
 * Até lá, usamos `any` para não travar o build do MVP.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = any;
