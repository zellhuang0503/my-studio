type Dependencies = {
  env: (name: string) => string | undefined;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  verify: (token: string) => Promise<string | null>;
  reserve: (user: string, image: boolean) => Promise<string>;
};
const csv = (value = "") => value.split(",").map(s => s.trim()).filter(Boolean);
const ratios = ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9"];

// Response streams and incoming bodies are capped before JSON parsing.
async function limitedText(stream: ReadableStream<Uint8Array> | null, max: number) {
  if (!stream) return "";
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw new Error("body limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export function makeHandler(deps: Dependencies) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("Origin") || "";
    const allowed = csv(deps.env("ALLOWED_ORIGINS"));
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin",
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
    const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers });
    if (!origin || !allowed.includes(origin)) return reply(403, { error: "這個網站未獲准使用 AI。" });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return reply(405, { error: "只接受 POST。" });
    try {
      const token = /^Bearer (\S+)$/i.exec(req.headers.get("Authorization") || "")?.[1];
      const user = token ? await deps.verify(token) : null;
      if (!user) return reply(401, { error: "登入已過期，請重新登入。" });
      if (!req.headers.get("Content-Type")?.startsWith("application/json")) return reply(415, { error: "請使用 JSON。" });
      let input;
      try { input = JSON.parse(await limitedText(req.body, 200000)); }
      catch { return reply(400, { error: "要求格式錯誤或內容過長。" }); }
      if (!input || typeof input !== "object" || Array.isArray(input)) return reply(400, { error: "要求格式錯誤。" });
      const image = input.action === "image";
      if (!["chat", "image"].includes(input.action) || !["or", "gm"].includes(input.provider) || (image && input.provider !== "or")) {
        return reply(400, { error: "不支援這個 AI 操作。" });
      }
      const listName = image ? "ALLOWED_IMAGE_MODELS" : input.provider === "or" ? "ALLOWED_OR_MODELS" : "ALLOWED_GEMINI_MODELS";
      if (typeof input.model !== "string" || !csv(deps.env(listName)).includes(input.model)) return reply(400, { error: "這個模型未獲管理員核准。" });
      const key = deps.env(input.provider === "or" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY");
      if (!key) return reply(503, { error: "管理員尚未設定這組 AI 服務。", retryable: true });
      let body: Record<string, unknown>;
      if (image) {
        if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 12000 || !ratios.includes(input.ratio)) return reply(400, { error: "圖片描述或比例不正確。" });
        body = { model: input.model, prompt: input.prompt, aspect_ratio: input.ratio, resolution: "1K", n: 1 };
      } else {
        if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 40 || input.messages.some((m: { role?: unknown; content?: unknown }) => !m || !["system", "user", "assistant"].includes(String(m.role)) || typeof m.content !== "string" || m.content.length > 100000)) return reply(400, { error: "對話內容過長或格式錯誤。" });
        const max = Number(input.maxTokens);
        if (!Number.isInteger(max) || max < 1 || max > 8000 || !["low", "medium", "high"].includes(input.effort)) return reply(400, { error: "輸出長度或思考設定不正確。" });
        body = { model: input.model, messages: input.messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })), max_tokens: max };
        if (input.provider === "or") { body.reasoning = { effort: input.effort, exclude: true }; body.usage = { include: true }; }
      }
      // User id is taken from verified Auth, never from input. DB lock makes limits atomic.
      const quota = await deps.reserve(user, image);
      if (quota === "forbidden") return reply(403, { error: "這個帳號尚未取得 AI 使用資格，請聯絡管理員。" });
      if (quota !== "ok") return reply(429, { error: quota === "minute" ? "操作太頻繁，請下一分鐘再試。" : "今天的 AI 使用額度已用完。" });
      const url = input.provider === "gm"
        ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        : image ? "https://openrouter.ai/api/v1/images" : "https://openrouter.ai/api/v1/chat/completions";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), image ? 110000 : 55000);
      try {
        const res = await deps.fetch(url, { method: "POST", redirect: "error", signal: controller.signal,
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        // Never return or log upstream error bodies, headers, or credentials.
        if (!res.ok) { await res.body?.cancel(); return reply(502, { error: "AI 供應商暫時無法完成要求，請稍後再試或聯絡管理員。", retryable: true }); }
        const data = JSON.parse(await limitedText(res.body, image ? 12000000 : 1000000));
        if (data.error) return reply(502, { error: "AI 供應商回傳錯誤。", retryable: true });
        const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
        if (image) {
          const item = data.data?.[0];
          const mime = item?.media_type || "image/png";
          if (!item || !["image/png", "image/jpeg", "image/webp"].includes(mime) || typeof item.b64_json !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json)) return reply(502, { error: "AI 沒有回傳可用的圖片。" });
          return reply(200, { src: `data:${mime};base64,${item.b64_json}`, cost: num(data.usage?.cost) });
        }
        const choice = data.choices?.[0];
        if (typeof choice?.message?.content !== "string") return reply(502, { error: "AI 沒有回傳文字。", retryable: true });
        return reply(200, { text: choice.message.content, cut: choice.finish_reason === "length",
          usage: { cost: num(data.usage?.cost), total_tokens: num(data.usage?.total_tokens), prompt_tokens: num(data.usage?.prompt_tokens), completion_tokens: num(data.usage?.completion_tokens) } });
      } finally { clearTimeout(timer); }
    } catch {
      return reply(503, { error: "AI 後端暫時無法完成要求，請稍後再試或聯絡管理員。" });
    }
  };
}
