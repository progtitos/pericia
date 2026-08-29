import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-ink-900 text-parchment">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <div className="flex items-center gap-3 text-brass-light">
          <span className="selo-pericial selo-pericial--conferido !border-brass-light !text-brass-light">
            PA
          </span>
          <span className="font-display text-sm tracking-[0.3em] uppercase">
            PeríciaAI / ExpertSystem
          </span>
        </div>

        <h1 className="mt-10 max-w-3xl font-display text-5xl leading-[1.1] text-parchment">
          Perícia judicial com o rigor de um livro-razão
          <span className="text-brass-light">, e a velocidade da IA.</span>
        </h1>

        <p className="mt-6 max-w-2xl font-body text-lg text-ink-100">
          Triagem processual, OCR de extratos com conferência de saldo obrigatória,
          recálculo previdenciário conforme a EC 113/2021 e minutas de laudo
          fundamentadas — tudo auditável, competência a competência.
        </p>

        <div className="mt-10 flex gap-4">
          <Link
            href="/login"
            className="rounded bg-brass px-6 py-3 font-body font-medium text-ink-900 hover:bg-brass-light transition-colors"
          >
            Entrar na plataforma
          </Link>
        </div>

        <dl className="mt-24 grid grid-cols-1 gap-8 border-t border-ink-700 pt-12 sm:grid-cols-3">
          {[
            {
              label: "Triagem",
              desc: "Extração estruturada de DIB, DER, RMI, quesitos e índices — com null explícito quando o dado não está no processo.",
            },
            {
              label: "Conferência de Extratos",
              desc: "Saldo inicial + entradas − saídas = saldo final, verificado por código determinístico, não por IA.",
            },
            {
              label: "Recálculo",
              desc: "IPCA-E/INPC até 11/2021, SELIC acumulada a partir da EC 113/2021, honorários pela Súmula 111/STJ.",
            },
          ].map((item) => (
            <div key={item.label}>
              <dt className="font-display text-brass-light">{item.label}</dt>
              <dd className="mt-2 text-sm text-ink-100">{item.desc}</dd>
            </div>
          ))}
        </dl>
      </div>
    </main>
  );
}
