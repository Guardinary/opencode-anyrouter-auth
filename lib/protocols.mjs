// URL classification only. Stream parsing/diagnostics live in response.mjs;
// obsolete retry/error-envelope helpers are deliberately not exported here.
export function protocolOfURL(value) {
  const path = new URL(value instanceof Request ? value.url : String(value)).pathname;
  if (/\/responses\/?$/.test(path)) return "responses";
  if (/\/chat\/completions\/?$/.test(path)) return "chat";
  if (/\/messages\/?$/.test(path)) return "anthropic";
  if (/\/models\/[^/]+:(?:streamGenerateContent|generateContent|countTokens)\/?$/.test(path)) return "gemini";
  return null;
}
