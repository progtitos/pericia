// 2. Função de extração de extrato bancário (aceita base64 e mimeType)
export async function extractExtratoBancario(
  fileBase64: string,
  mimeType: string = "application/pdf"
): Promise<any> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `
  Extraia os dados deste extrato bancário em formato JSON.
  Retorne um objeto JSON contendo:
  - banco: string
  - conta: string
  - periodo: string
  - transacoes: lista de objetos { data, descricao, valor, tipo }
  `;

  const result = await model.generateContent([
    prompt,
    {
      inlineData: {
        data: fileBase64,
        mimeType,
      },
    },
  ]);

  const response = await result.response;
  const rawText = response.text();

  try {
    const jsonStr = rawText.replace(/```json|```/g, "").trim();
    return JSON.parse(jsonStr);
  } catch {
    return { banco: "", conta: "", periodo: "", transacoes: [], raw: rawText };
  }
}