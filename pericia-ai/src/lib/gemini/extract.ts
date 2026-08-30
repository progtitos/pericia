import { GoogleGenerativeAI } from "@google/generative-ai";

function getGeminiModel(modelName = "gemini-3.6-flash") {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("A variável de ambiente GOOGLE_GEMINI_API_KEY ou GEMINI_API_KEY não está definida.");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({ model: modelName });
}

export async function processarTextoProcesso(texto: string): Promise<any> {
  const model = getGeminiModel("gemini-3.6-flash");

  // Corta se o texto for absurdamente gigante para garantir envio limpo
  const textoLimitado = texto.slice(0, 3000000);

  const prompt = `
  Analise o texto do processo judicial abaixo e extraia as informações estruturadas em formato JSON válido.
  
  Campos necessários:
  - numero_processo (string)
  - vara (string)
  - autor (string)
  - reu (string)
  - dib (string)
  - der (string)
  - rmi (string)
  - indice_determinado_pelo_juiz (string)
  - observacoes_para_conferencia_humana (string)

  Texto do Processo:
  ${textoLimitado}
  `;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  const textResult = response.text();

  try {
    const jsonLimpo = textResult
      .replaceAll("```json", "")
      .replaceAll("```", "")
      .trim();
    return JSON.parse(jsonLimpo);
  } catch (e) {
    console.warn("[Gemini Extract] Falha no parse de JSON:", e);
    return { rawText: textResult };
  }
}