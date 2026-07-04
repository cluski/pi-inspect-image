import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import {
  buildPiVisionContext,
  extractAssistantText,
  getAvailableImageModelItems,
  filterModelRefs,
  getAvailableImageModelRefs,
  getConfiguredModel,
  inspectImage,
  isInspectImageEnabled,
  normalizeConfig,
  readProjectEnabled,
  resolveImageInput,
  saveProjectConfigEnabled,
  saveProjectConfigModel,
  type CompleteSimpleLike,
  type ResizeImageLike,
} from "../src/inspect.ts";

const model: Model<Api> = {
  id: "vision-model",
  name: "Vision Model",
  api: "anthropic-messages",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

/** Fresh resizeImage mock that leaves the image untouched (null → fallback to original bytes). */
function noResize(): ResizeImageLike {
  return vi.fn(async () => null);
}

/** Fresh resizeImage mock that reports a downscaled JPEG with a dimension note. */
function resizeToSmaller(): ResizeImageLike {
  return vi.fn<ResizeImageLike>(async () => ({
    data: Buffer.from("resized").toString("base64"),
    mimeType: "image/jpeg",
    originalWidth: 2000,
    originalHeight: 1000,
    width: 1000,
    height: 500,
    wasResized: true,
  }));
}


describe("inspect image config", () => {
  it("normalizes the scoped pi model reference", () => {
    expect(normalizeConfig({ model: "openai/gpt-4.1", maxTokens: 100, temperature: 0 })).toEqual({
      model: "openai/gpt-4.1",
      provider: "openai",
      modelId: "gpt-4.1",
    });
  });

  it("keeps legacy provider plus model config readable", () => {
    expect(normalizeConfig({ provider: "openai", model: "gpt-4.1" })).toMatchObject({
      model: "openai/gpt-4.1",
      provider: "openai",
      modelId: "gpt-4.1",
    });
  });

  it("rejects unscoped model references", () => {
    expect(() => normalizeConfig({ model: "gpt-4.1" })).toThrow(/provider\/model-id/);
  });

  it("reads the enabled flag and defaults to true", () => {
    expect(normalizeConfig({ model: "openai/gpt-4.1" }).enabled).toBeUndefined();
    expect(isInspectImageEnabled(normalizeConfig({ model: "openai/gpt-4.1" }))).toBe(true);
    expect(isInspectImageEnabled(normalizeConfig({ model: "openai/gpt-4.1", enabled: true }))).toBe(true);
    expect(isInspectImageEnabled(normalizeConfig({ model: "openai/gpt-4.1", enabled: false }))).toBe(false);
  });

  it("rejects non-boolean enabled values", () => {
    expect(() => normalizeConfig({ model: "openai/gpt-4.1", enabled: "yes" })).toThrow(/enabled/);
  });

  it("reads the autoResizeImages flag and defaults to undefined", () => {
    expect(normalizeConfig({ model: "openai/gpt-4.1" }).autoResizeImages).toBeUndefined();
    expect(normalizeConfig({ model: "openai/gpt-4.1", autoResizeImages: false }).autoResizeImages).toBe(false);
    expect(() => normalizeConfig({ model: "openai/gpt-4.1", autoResizeImages: "yes" })).toThrow(/autoResizeImages/);
  });
});

describe("project enabled persistence", () => {
  it("persists the enabled flag and preserves sibling fields", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi", "inspect-image.json"),
      JSON.stringify({ model: "test-provider/vision-model", maxImageBytes: 1234 }),
    );

    const path = await saveProjectConfigEnabled(cwd, false);
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    expect(saved).toEqual({
      model: "test-provider/vision-model",
      maxImageBytes: 1234,
      enabled: false,
    });
  });

  it("reads enabled=true when the project config is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    expect(await readProjectEnabled(cwd)).toBe(true);
  });

  it("reads the persisted enabled flag", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "inspect-image.json"), JSON.stringify({ enabled: false }));
    expect(await readProjectEnabled(cwd)).toBe(false);

    await writeFile(join(cwd, ".pi", "inspect-image.json"), JSON.stringify({ enabled: true }));
    expect(await readProjectEnabled(cwd)).toBe(true);
  });

  it("treats a config without enabled as default-on", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "inspect-image.json"), JSON.stringify({ model: "openai/gpt-4.1" }));
    expect(await readProjectEnabled(cwd)).toBe(true);
  });
});

describe("pi model selection", () => {
  it("selects the configured pi registry model", () => {
    const ctx = makeContext("/tmp", model);
    expect(getConfiguredModel(ctx, normalizeConfig({ model: "test-provider/vision-model" }))).toBe(model);
  });

  it("requires image input support", () => {
    const textModel = { ...model, input: ["text"] as ("text" | "image")[] };
    const ctx = makeContext("/tmp", textModel);
    expect(() => getConfiguredModel(ctx, normalizeConfig({ model: "test-provider/vision-model" }))).toThrow(
      /image input support/,
    );
  });

  it("lists available image-capable model refs", () => {
    const textModel = { ...model, id: "text-model", input: ["text"] as ("text" | "image")[] };
    const unavailableImageModel = { ...model, id: "unavailable-vision-model" };
    const ctx = makeContext("/tmp", model, [textModel, model, unavailableImageModel], [textModel, model]);

    expect(getAvailableImageModelRefs(ctx)).toEqual(["test-provider/vision-model"]);
    expect(getAvailableImageModelItems(ctx)).toEqual([
      {
        ref: "test-provider/vision-model",
        provider: "test-provider",
        id: "vision-model",
        name: "Vision Model",
      },
    ]);
  });

  it("persists the selected model to project JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "inspect-image.json"), JSON.stringify({ maxImageBytes: 1234 }));

    const configPath = await saveProjectConfigModel(cwd, "test-provider/vision-model");
    const saved = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

    expect(saved).toEqual({
      maxImageBytes: 1234,
      model: "test-provider/vision-model",
    });
  });

  it("filters model refs by case-insensitive tokens", () => {
    const modelRefs = ["openai/gpt-4.1", "anthropic/claude-sonnet-4", "openrouter/qwen-vl"];

    expect(filterModelRefs(modelRefs, "CLAUDE sonnet")).toEqual(["anthropic/claude-sonnet-4"]);
    expect(filterModelRefs(modelRefs, "  ")).toEqual(modelRefs);
    expect(filterModelRefs(modelRefs, "vl")).toEqual(["openrouter/qwen-vl"]);
  });
});

describe("image input", () => {
  it("converts local image files to pi image content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    const imagePath = join(cwd, "sample.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveImageInput(cwd, "sample.png", 1024);
    expect(result.source).toBe("file");
    expect(result.mimeType).toBe("image/png");
    expect(result.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  });

  it("downloads image URLs before calling pi providers", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("png"), { headers: { "content-type": "image/png" } }));

    const result = await resolveImageInput("/tmp", "https://example.test/image.png", 1024, undefined, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/image.png", { signal: undefined });
    expect(result.source).toBe("url");
    expect(result.mimeType).toBe("image/png");
    expect(result.data).toBe(Buffer.from("png").toString("base64"));
  });
});

describe("pi model call", () => {
  it("uses completeSimple with the configured pi model and resolved auth", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi", "inspect-image.json"),
      JSON.stringify({ model: "test-provider/vision-model", maxTokens: 123 }),
    );
    await writeFile(join(cwd, "sample.png"), Buffer.from("image"));

    const completeSimpleImpl = vi.fn<CompleteSimpleLike>(async () => assistantMessage("A test image."));
    const ctx = makeContext(cwd, model);

    const result = await inspectImage(ctx, { image: "sample.png", prompt: "Look closely" }, undefined, completeSimpleImpl);

    expect(result.text).toBe("A test image.");
    expect(completeSimpleImpl).toHaveBeenCalledOnce();

    const [calledModel, context, options] = completeSimpleImpl.mock.calls[0] as [
      Model<Api>,
      Context,
      SimpleStreamOptions,
    ];
    expect(calledModel).toBe(model);
    expect(context.messages[0].content).toMatchObject([
      { type: "text", text: "Look closely" },
      { type: "image", mimeType: "image/png", data: Buffer.from("image").toString("base64") },
    ]);
    expect(options.apiKey).toBe("resolved-key");
    expect(options.headers).toEqual({ "x-test": "1" });
    expect(options.env).toEqual({ TEST_ENV: "yes" });
    expect(options.maxTokens).toBeUndefined();
    expect(options.temperature).toBeUndefined();
  });

  it("does not force optional generation parameters or timeout", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi", "inspect-image.json"),
      JSON.stringify({ model: "test-provider/vision-model", temperature: 0, timeoutMs: 1 }),
    );
    await writeFile(join(cwd, "sample.png"), Buffer.from("image"));

    const completeSimpleImpl = vi.fn<CompleteSimpleLike>(async () => assistantMessage("A test image."));
    const ctx = makeContext(cwd, model);

    await inspectImage(ctx, { image: "sample.png", prompt: "Look closely" }, undefined, completeSimpleImpl, undefined, noResize());

    const options = completeSimpleImpl.mock.calls[0][2] as SimpleStreamOptions;
    expect(options.temperature).toBeUndefined();
    expect(options.maxTokens).toBeUndefined();
    expect(options.signal).toBeUndefined();
  });

  it("passes a timeout signal only when the tool call includes timeoutMs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "inspect-image.json"), JSON.stringify({ model: "test-provider/vision-model" }));
    await writeFile(join(cwd, "sample.png"), Buffer.from("image"));

    const completeSimpleImpl = vi.fn<CompleteSimpleLike>(async () => assistantMessage("A test image."));
    const ctx = makeContext(cwd, model);

    await inspectImage(ctx, { image: "sample.png", prompt: "Look closely", timeoutMs: 5000 }, undefined, completeSimpleImpl, undefined, noResize());

    const options = completeSimpleImpl.mock.calls[0][2] as SimpleStreamOptions;
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("requires the main LLM to pass a prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "inspect-image.json"), JSON.stringify({ model: "test-provider/vision-model" }));
    await writeFile(join(cwd, "sample.png"), Buffer.from("image"));

    const completeSimpleImpl = vi.fn<CompleteSimpleLike>(async () => assistantMessage("A test image."));
    const ctx = makeContext(cwd, model);

    await expect(
      inspectImage(ctx, { image: "sample.png", prompt: "" }, undefined, completeSimpleImpl, undefined, noResize()),
    ).rejects.toThrow(/prompt/);
    expect(completeSimpleImpl).not.toHaveBeenCalled();
  });

  it("resizes the image and appends a dimension note when autoResizeImages is on", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "inspect-image.json"), JSON.stringify({ model: "test-provider/vision-model" }));
    await writeFile(join(cwd, "sample.png"), Buffer.from("image"));

    const completeSimpleImpl = vi.fn<CompleteSimpleLike>(async () => assistantMessage("A test image."));
    const resize = resizeToSmaller();
    const ctx = makeContext(cwd, model);

    await inspectImage(ctx, { image: "sample.png", prompt: "Look closely" }, undefined, completeSimpleImpl, undefined, resize);

    expect(resize).toHaveBeenCalledOnce();
    const context = completeSimpleImpl.mock.calls[0][1] as Context;
    expect(context.messages[0].content).toMatchObject([
      { type: "text", text: "Look closely" },
      { type: "image", mimeType: "image/jpeg", data: Buffer.from("resized").toString("base64") },
      { type: "text", text: /displayed at 1000x500/ },
    ]);
  });

  it("skips resize and uses original bytes when autoResizeImages is false", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-inspect-image-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi", "inspect-image.json"),
      JSON.stringify({ model: "test-provider/vision-model", autoResizeImages: false }),
    );
    await writeFile(join(cwd, "sample.png"), Buffer.from("image"));

    const completeSimpleImpl = vi.fn<CompleteSimpleLike>(async () => assistantMessage("A test image."));
    const resize = noResize();
    const ctx = makeContext(cwd, model);

    await inspectImage(ctx, { image: "sample.png", prompt: "Look closely" }, undefined, completeSimpleImpl, undefined, resize);

    expect(resize).not.toHaveBeenCalled();
    const context = completeSimpleImpl.mock.calls[0][1] as Context;
    expect(context.messages[0].content).toMatchObject([
      { type: "text", text: "Look closely" },
      { type: "image", mimeType: "image/png", data: Buffer.from("image").toString("base64") },
    ]);
  });
});

describe("assistant text extraction", () => {
  it("joins text parts and ignores non-text content", () => {
    expect(extractAssistantText(assistantMessage("one", "two"))).toBe("one\ntwo");
  });

  it("builds pi vision context", () => {
    const context = buildPiVisionContext("data:image/png;base64,aW1hZ2U=", "Inspect");
    expect(context.messages[0].content).toMatchObject([
      { type: "text", text: "Inspect" },
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    ]);
  });
});

function makeContext(
  cwd: string,
  configuredModel: Model<Api>,
  allModels: Model<Api>[] = [configuredModel],
  availableModels: Model<Api>[] = allModels,
): ExtensionContext {
  return {
    cwd,
    modelRegistry: {
      getAll: vi.fn(() => allModels),
      getAvailable: vi.fn(() => availableModels),
      find: vi.fn((provider: string, id: string) =>
        provider === configuredModel.provider && id === configuredModel.id ? configuredModel : undefined,
      ),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "resolved-key",
        headers: { "x-test": "1" },
        env: { TEST_ENV: "yes" },
      })),
    },
  } as unknown as ExtensionContext;
}

function assistantMessage(...texts: string[]): AssistantMessage {
  return {
    role: "assistant",
    content: texts.map((text) => ({ type: "text", text })),
    api: "anthropic-messages",
    provider: "test-provider",
    model: "vision-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
