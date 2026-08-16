import { redactSensitive } from "../src/utils/logger";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const secret = "sk-super-secret-value";
const redacted = JSON.stringify(redactSensitive({
  apiKey: secret,
  headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
  nested: { token: secret, harmless: "visible" },
}));

assert(!redacted.includes(secret), "redaction must remove secret values recursively");
assert(redacted.includes("visible"), "redaction must preserve non-sensitive diagnostic data");
assert(redacted.includes("application/json"), "redaction must preserve safe headers");

const jsonString = JSON.stringify({ presets: [{ channels: { llm: [{ apiKey: secret }] } }] });
assert(!String(redactSensitive(jsonString)).includes(secret), "JSON strings containing credentials must be redacted");

const persistedLogLine = `[2026-01-01][INFO] config {"apiKey":"${secret}","model":"test"}`;
assert(!String(redactSensitive(persistedLogLine)).includes(secret), "legacy log lines must redact embedded credential fields");

const secretUrl = `https://api.example.test/v1?api_key=${secret}&mode=test`;
assert(!String(redactSensitive(secretUrl)).includes(secret), "credentials in URL query parameters must be redacted");

console.log("=== logger redaction tests passed ===");
