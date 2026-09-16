import { generateImage, ReferenceImageError } from "../src/api/openaiCompatible";
import { referenceRouteRejection } from "../src/api/providers";
import type { ApiConfig, ImageReference } from "../src/core/types";
import { tauri } from "../src/utils/tauri";

/** 真实回执（2026-09-13 日志）：中转站只开放纯文本 /v1/images/generations，带参考图的请求撞上 256 KiB 上限 */
const RELAY_413_BODY = JSON.stringify({
  error: {
    message:
      "JSON body exceeds 256 KiB; no image operation was dispatched. This limit is unchanged. " +
      "If the request contains an image/base64 attachment, it requires edits, which this route does not support; " +
      "do not discard that image to retry generation. Supported: POST /v1/images/generations; model=gpt-image-2.5; " +
      "No image inputs, edits, fixed quality/size, or streaming. One stable Idempotency-Key header is required.",
  },
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function relayConfig(): ApiConfig {
  return {
    id: "relay",
    name: "relay",
    baseUrl: "https://fushengyunsuan.cn/v1",
    apiKey: "test",
    model: "gpt-image-2.5",
    extra: {
      protocol: "openai-image",
      // 「测试连接」曾把这条线路判成支持图生图，于是图生图请求依然带着参考图 → 413
      imageCapabilities: {
        maxReferenceImages: 3,
        supportsSeed: false,
        supportsImageEdit: true,
        referenceEncoding: "raw-base64",
      },
    },
  };
}

function bigReference(): ImageReference {
  return { role: "identity", dataB64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" + "A".repeat(2000), mime: "image/png" };
}

function testRealReceiptIsRecognized(): void {
  const hint = referenceRouteRejection(RELAY_413_BODY);
  assert(typeof hint === "string", "real relay 413 receipt must be recognized");
  assert(hint!.includes("测试连接"), "hint must tell the user how to repair the route capability");
  assert(
    referenceRouteRejection(JSON.stringify({ error: { message: "invalid api key" } })) === undefined,
    "unrelated errors must not be mistaken for a route that rejects image inputs",
  );
  assert(
    referenceRouteRejection("prompt length must be less than 1500") === undefined,
    "prompt length limits must not be mistaken for route rejection",
  );
}

async function testImageRequestIsNotRetriedAndSurfacesTypedError(): Promise<void> {
  let requestCount = 0;
  let sentImage = false;
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    requestCount++;
    const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    sentImage = typeof body.image === "string" && body.image.length > 1000;
    return {
      status: 413,
      bodyBase64: Buffer.from(RELAY_413_BODY).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  let error: unknown;
  try {
    await generateImage(relayConfig(), "a character portrait", { references: [bigReference()] });
  } catch (e) {
    error = e;
  } finally {
    tauri.http = originalHttp;
  }
  assert(sentImage, "the reference image must actually be sent, otherwise the failure cannot reproduce");
  assert(requestCount === 1, "a route that rejects image inputs must not be retried (requests=" + requestCount + ")");
  assert(
    error instanceof ReferenceImageError && error.code === "REFERENCE_UNSUPPORTED",
    "route rejection must surface as a typed REFERENCE_UNSUPPORTED error",
  );
  assert(
    !/exceed/i.test((error as Error).message),
    "the typed message must not contain 'exceed', or the retry classifier reads it as rate limiting",
  );
}

async function main(): Promise<void> {
  testRealReceiptIsRecognized();
  await testImageRequestIsNotRetriedAndSurfacesTypedError();
  console.log("=== image reference route tests passed ===");
}

main().catch((error) => {
  console.error("image reference route tests failed:", error);
  process.exit(1);
});
