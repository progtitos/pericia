import Link from "next/link";
import { ExpressCalculator } from "@/components/express-calc/ExpressCalculator";
import { resolveBrand } from "@/lib/whitelabel/config";

const BENEFICIOS = [
  {
    titulo: "Plataforma White Label Multi-Especialidade",
    desc: "Pronta para peritos contábeis, previdenciários, bancários, trabalhistas e engenheiros — com a sua marca, não a nossa.",
  },
  {
    titulo: "Precisão Determinística Auditável",
    desc: "Extração de texto purificada e recálculos auditáveis linha a linha, competência a competência.",
  },
  {
    titulo: "Processamento Sem Limites",
    desc: "Extração por camadas que lê processos de mais de 1.000 páginas garantindo a exatidão dos dados.",
  },
];

export default function LandingPage() {
  const brand = resolveBrand();

  return (
    <main className="min-h-screen bg-ink-900 text-parchment">
      {/* Cabeçalho com slot de marca White Label */}
      <header className="border-b border-ink-700">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            {brand.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brand.logoUrl} alt={brand.partnerName ?? "Logo"} className="h-8" />
            ) : (
              <span className="selo-pericial selo-pericial--conferido !border-brass-light !text-brass-light !w-8 !h-8 !text-[9px]">
                PA
              </span>
            )}
            <div className="leading-tight">
              <p className="font-display text-sm">{brand.partnerName ?? "PeríciaAI"}</p>
              {brand.partnerName && (
                <p className="text-[10px] uppercase tracking-widest text-ink-300">Powered by PeríciaAI</p>
              )}
            </div>
          </div>

          <Link
            href="/login"
            className="rounded border border-brass/40 px-4 py-1.5 text-sm font-medium text-brass-light hover:bg-brass/10 transition-colors"
          >
            Entrar
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pt-20 pb-12">
        <span className="rounded-full border border-brass/30 px-3 py-1 text-[11px] uppercase tracking-widest text-brass-light">
          Perícia técnica com IA, do jeito que um perito confia
        </span>

        <h1 className="mt-6 max-w-3xl font-display text-5xl leading-[1.1] text-parchment">
          Perícia judicial com o rigor de um livro-razão
          <span className="text-brass-light">, e a velocidade da IA.</span>
        </h1>

        <p className="mt-6 max-w-2xl font-body text-lg text-ink-100">
          Envie o processo, o contrato ou o extrato — receba um demonstrativo auditável e uma
          minuta pronta para revisão, com cada valor rastreável até a sua origem.
        </p>

        <div className="mt-10 flex flex-wrap gap-4">
          <Link
            href="/login"
            className="rounded bg-brass px-6 py-3 font-body font-medium text-ink-900 hover:bg-brass-light transition-colors"
          >
            Entrar na plataforma
          </Link>
          <a
            href="#calculadora-express"
            className="rounded border border-ink-700 px-6 py-3 font-body font-medium text-parchment hover:border-brass transition-colors"
          >
            Testar a Calculadora Express
          </a>
        </div>
      </section>

      {/* Calculadora Express / Minuta com 1 Clique */}
      <section id="calculadora-express" className="mx-auto max-w-5xl px-6 py-12">
        <div className="mb-6">
          <h2 className="font-display text-2xl text-parchment">Minuta Express, com 1 clique</h2>
          <p className="mt-2 max-w-2xl text-sm text-ink-100">
            Escolha a especialidade e veja uma prévia em segundos. A análise completa e auditável
            fica disponível assim que você entra na plataforma.
          </p>
        </div>
        <ExpressCalculator />
      </section>

      {/* Benefícios comercializáveis */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <dl className="grid grid-cols-1 gap-8 border-t border-ink-700 pt-12 sm:grid-cols-3">
          {BENEFICIOS.map((item) => (
            <div key={item.titulo}>
              <dt className="font-display text-brass-light">{item.titulo}</dt>
              <dd className="mt-2 text-sm text-ink-100">{item.desc}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="border-t border-ink-700 py-8 text-center text-xs text-ink-500">
        © {new Date().getFullYear()} PeríciaAI. Plataforma White Label para perícia técnica assistida por IA.
      </footer>
    </main>
  );
}
