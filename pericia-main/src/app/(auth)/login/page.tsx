"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);
    if (authError) {
      setError("Não foi possível entrar. Confira o e-mail e a senha e tente novamente.");
      return;
    }
    router.push("/casos");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-parchment px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="selo-pericial selo-pericial--conferido mx-auto">PA</span>
          <h1 className="mt-4 font-display text-2xl text-ink">PeríciaAI</h1>
          <p className="mt-1 text-sm text-ink-500">Acesso da equipe pericial</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-ink-700">
              E-mail
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded border border-ink-100 bg-white px-3 py-2 text-ink focus:border-brass focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-ink-700">
              Senha
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded border border-ink-100 bg-white px-3 py-2 text-ink focus:border-brass focus:outline-none"
            />
          </div>

          {error && (
            <p className="rounded border border-seal-red/30 bg-seal-red/5 px-3 py-2 text-sm text-seal-red">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded bg-ink py-2.5 font-medium text-parchment hover:bg-ink-700 disabled:opacity-60 transition-colors"
          >
            {loading ? "Entrando…" : "Entrar"}
          </button>
        </form>
      </div>
    </main>
  );
}
