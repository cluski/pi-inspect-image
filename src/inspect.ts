import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { formatDimensionNote, resizeImage, type ResizedImage } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TextContent,
} from "@earendil-works/pi-ai/compat";

/** Resize options mirroring pi's ImageResizeOptions (not re-exported by the host). */
export type InspectResizeOptions = {
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  jpegQuality?: number;
};

/** Injectable shape of pi's resizeImage so tests can mock it. */
export type ResizeImageLike = (
  bytes: Uint8Array,
  mimeType: string,
  options?: InspectResizeOptions,
) => Promise<ResizedImage | null>;

export type InspectImageConfig = {
  model: string;
  provider: string;
  modelId: string;
  maxImageBytes?: number;
  /** Whether the inspect_image tool is active. Defaults to true when omitted. */
  enabled?: boolean;
  /**
   * Whether images are auto-resized to inline provider limits before the VLM
   * call (mirrors pi's read tool). Defaults to true when omitted.
   */
  autoResizeImages?: boolean;
};

/**
 * Whether the tool should be active. Omitted/undefined means enabled.
 */
export function isInspectImageEnabled(config: InspectImageConfig): boolean {
  return config.enabled !== false;
}

export type InspectImageParams = {
  image: string;
  prompt: string;
  timeoutMs?: number;
};

export type InspectImageDetails = {
  provider: string;
  model: string;
  api: string;
  source: "file" | "url" | "data-url";
  prompt: string;
};

export type AvailableImageModelItem = {
  ref: string;
  provider: string;
  id: string;
  name: string;
};

type FetchLike = typeof fetch;
export type CompleteSimpleLike = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PROJECT_CONFIG_PATH = join(".pi", "inspect-image.json");

export function getDefaultConfigPaths(cwd: string): string[] {
  const paths = [];
  if (process.env.PI_INSPECT_IMAGE_CONFIG) {
    paths.push(resolve(cwd, process.env.PI_INSPECT_IMAGE_CONFIG));
  }
  paths.push(getProjectConfigPath(cwd));
  paths.push(join(homedir(), ".pi", "agent", "inspect-image.json"));
  return paths;
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, PROJECT_CONFIG_PATH);
}

export async function loadConfig(cwd: string): Promise<InspectImageConfig> {
  const errors: string[] = [];
  for (const path of getDefaultConfigPaths(cwd)) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      return normalizeConfig(parsed, path);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const suffix = errors.length > 0 ? ` Invalid config files: ${errors.join("; ")}` : "";
  throw new Error(
    `Missing inspect-image config. Create .pi/inspect-image.json with a model field like "provider/model-id".${suffix}`,
  );
}

export function normalizeConfig(value: unknown, source = "config"): InspectImageConfig {
  if (!isRecord(value)) {
    throw new Error(`${source} must be a JSON object`);
  }

  const modelRef = normalizeModelRef(value, source);
  const { provider, modelId } = parseModelRef(modelRef, source);
  const config: InspectImageConfig = { model: modelRef, provider, modelId };

  if (value.maxImageBytes !== undefined) {
    config.maxImageBytes = requirePositiveInteger(value.maxImageBytes, "maxImageBytes", source);
  }

  if (value.enabled !== undefined) {
    config.enabled = requireBoolean(value.enabled, "enabled", source);
  }

  if (value.autoResizeImages !== undefined) {
    config.autoResizeImages = requireBoolean(value.autoResizeImages, "autoResizeImages", source);
  }

  return config;
}

export function getAvailableImageModelRefs(ctx: ExtensionContext): string[] {
  return getAvailableImageModelItems(ctx).map((model) => model.ref);
}

export function getAvailableImageModelItems(ctx: ExtensionContext): AvailableImageModelItem[] {
  return ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.input.includes("image"))
    .map((model) => ({
      ref: `${model.provider}/${model.id}`,
      provider: model.provider,
      id: model.id,
      name: model.name,
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

export function filterModelRefs(modelRefs: string[], query: string): string[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return modelRefs;

  return modelRefs.filter((modelRef) => {
    const normalized = modelRef.toLowerCase();
    return tokens.every((token) => normalized.includes(token));
  });
}

export async function saveProjectConfigModel(cwd: string, modelRef: string): Promise<string> {
  const { provider, modelId } = parseModelRef(modelRef, "model");
  const normalizedModelRef = `${provider}/${modelId}`;
  const configPath = getProjectConfigPath(cwd);
  const current = await readJsonObjectIfPresent(configPath);
  const next = {
    ...current,
    model: normalizedModelRef,
  };

  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * Persist the `enabled` flag to the project `.pi/inspect-image.json`.
 *
 * Reads the existing project config (if any) and merges the new `enabled`
 * value, preserving all other fields such as `model` and `maxImageBytes`.
 * Returns the path of the written file.
 */
export async function saveProjectConfigEnabled(cwd: string, enabled: boolean): Promise<string> {
  const configPath = getProjectConfigPath(cwd);
  const current = await readJsonObjectIfPresent(configPath);
  const next = {
    ...current,
    enabled,
  };

  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * Best-effort read of the project-local `enabled` flag.
 *
 * Returns `true` when the project config is missing, unreadable, or does not
 * set `enabled` (default-on). Returns `false` only when the config explicitly
 * disables the tool. Never throws.
 */
export async function readProjectEnabled(cwd: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(getProjectConfigPath(cwd), "utf8")) as unknown;
    if (!isRecord(raw)) return true;
    if (raw.enabled === undefined) return true;
    return raw.enabled !== false;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return true;
    return true;
  }
}

export async function inspectImage(
  ctx: ExtensionContext,
  params: InspectImageParams,
  signal?: AbortSignal,
  completeSimpleImpl: CompleteSimpleLike = completeSimple,
  fetchImpl: FetchLike = fetch,
  resizeImageImpl: ResizeImageLike = resizeImage,
): Promise<{ text: string; details: InspectImageDetails }> {
  let config: InspectImageConfig;
  try {
    config = await loadConfig(ctx.cwd);
  } catch (error) {
    throw enrichInspectConfigError(error, ctx);
  }
  let model: Model<Api>;
  try {
    model = getConfiguredModel(ctx, config);
  } catch (error) {
    throw enrichInspectConfigError(error, ctx);
  }
  const timeoutMs =
    params.timeoutMs === undefined ? undefined : requirePositiveInteger(params.timeoutMs, "timeoutMs", "inspect_image");
  const operationSignal = withOptionalTimeout(signal, timeoutMs);
  const prompt = requireString(params.prompt, "prompt", "inspect_image");
  const image = await resolveImageInput(
    ctx.cwd,
    params.image,
    config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
    operationSignal,
    fetchImpl,
  );

  // Optionally shrink the image to inline provider limits, mirroring pi's read tool.
  let data = image.data;
  let mimeType = image.mimeType;
  const extraTextParts: string[] = [];
  if (config.autoResizeImages !== false) {
    const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
    const resized = await resizeImageImpl(bytes, image.mimeType);
    if (resized) {
      data = resized.data;
      mimeType = resized.mimeType;
      const note = formatDimensionNote(resized);
      if (note) extraTextParts.push(note);
    }
  }

  const reference = `data:${mimeType};base64,${data}`;
  const text = await inspectWithPiModel(
    ctx,
    model,
    reference,
    prompt,
    operationSignal,
    completeSimpleImpl,
    extraTextParts,
  );

  return {
    text,
    details: {
      provider: model.provider,
      model: model.id,
      api: model.api,
      source: image.source,
      prompt,
    },
  };
}

export function getConfiguredModel(ctx: ExtensionContext, config: InspectImageConfig): Model<Api> {
  const model = ctx.modelRegistry.find(config.provider, config.modelId);
  if (!model) {
    throw new Error(`Configured VLM model not found in pi registry: ${config.model}`);
  }
  if (!model.input.includes("image")) {
    throw new Error(`Configured model ${model.provider}/${model.id} is not registered with image input support`);
  }
  return model;
}

/**
 * Build a human/LLM-readable hint listing the currently logged-in
 * image-capable models, used to guide recovery when inspect_image has no
 * usable VLM configured.
 */
export function formatAvailableImageModelsHint(ctx: ExtensionContext): string {
  const refs = getAvailableImageModelRefs(ctx);
  if (refs.length === 0) {
    return "No logged-in image-capable models are available. Log in to a vision model provider or set model in .pi/inspect-image.json.";
  }
  const maxListed = 10;
  const listed = refs.slice(0, maxListed).map((ref) => `  - ${ref}`).join("\n");
  const more = refs.length > maxListed ? `\n  ... and ${refs.length - maxListed} more` : "";
  return `Available image models:\n${listed}${more}\nHint: call the inspect_image_select_model tool to choose one, then retry inspect_image.`;
}

function enrichInspectConfigError(error: unknown, ctx: ExtensionContext): Error {
  const base = error instanceof Error ? error.message : String(error);
  return new Error(`${base}\n${formatAvailableImageModelsHint(ctx)}`);
}

export type SelectInspectImageModelResult = {
  selected: string;
  provider: string;
  modelId: string;
  /** True when no model was requested and the first available model was picked. */
  autoSelected: boolean;
  /** All logged-in image-capable models at selection time. */
  available: AvailableImageModelItem[];
};

/**
 * Select and persist the VLM used by inspect_image.
 *
 * When `options.model` is omitted, the first available image-capable model
 * is auto-picked. When provided, it must match a logged-in image-capable
 * model in `provider/model-id` form. The chosen model is written to the
 * project `.pi/inspect-image.json` so subsequent inspect_image calls use it.
 */
export async function selectInspectImageModel(
  ctx: ExtensionContext,
  options: { model?: string } = {},
): Promise<SelectInspectImageModelResult> {
  const available = getAvailableImageModelItems(ctx);
  if (available.length === 0) {
    throw new Error(
      "No logged-in image-capable models are available to select. Log in to a vision model provider first.",
    );
  }

  const requested = options.model?.trim();
  if (requested) {
    const { provider, modelId } = parseModelRef(requested, "model");
    const normalizedRef = `${provider}/${modelId}`;
    const match = available.find((item) => item.ref === normalizedRef);
    if (!match) {
      throw new Error(
        `Requested model ${normalizedRef} is not logged in or does not support image input. Available: ${available
          .map((item) => item.ref)
          .join(", ")}`,
      );
    }
    await saveProjectConfigModel(ctx.cwd, normalizedRef);
    return {
      selected: normalizedRef,
      provider: match.provider,
      modelId: match.id,
      autoSelected: false,
      available,
    };
  }

  const picked = available[0];
  await saveProjectConfigModel(ctx.cwd, picked.ref);
  return {
    selected: picked.ref,
    provider: picked.provider,
    modelId: picked.id,
    autoSelected: true,
    available,
  };
}

export async function resolveImageInput(
  cwd: string,
  rawImage: string,
  maxImageBytes: number,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<{ data: string; mimeType: string; source: "file" | "url" | "data-url" }> {
  const image = rawImage.startsWith("@") ? rawImage.slice(1) : rawImage;
  if (image.startsWith("data:image/")) {
    const parsed = parseImageReference(image);
    return { data: parsed.data, mimeType: parsed.mimeType, source: "data-url" };
  }
  if (isHttpUrl(image)) {
    const downloaded = await downloadImage(image, maxImageBytes, signal, fetchImpl);
    return { data: downloaded.data, mimeType: downloaded.mimeType, source: "url" };
  }

  const absolutePath = isAbsolute(image) ? image : resolve(cwd, image);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error(`Image path is not a file: ${absolutePath}`);
  }
  if (fileStat.size > maxImageBytes) {
    throw new Error(`Image is ${fileStat.size} bytes, larger than maxImageBytes ${maxImageBytes}`);
  }

  const mimeType = getMimeType(absolutePath);
  const file = await readFile(absolutePath);
  return { data: file.toString("base64"), mimeType, source: "file" };
}

export function buildPiVisionContext(imageReference: string, prompt: string, extraTextParts: string[] = []): Context {
  const parsed = parseImageReference(imageReference);
  const content: (TextContent | ImageContent)[] = [
    { type: "text", text: prompt },
    parsed,
    ...extraTextParts.map((text): TextContent => ({ type: "text", text })),
  ];
  return {
    messages: [
      {
        role: "user",
        content,
        timestamp: Date.now(),
      },
    ],
  };
}

async function inspectWithPiModel(
  ctx: ExtensionContext,
  model: Model<Api>,
  imageReference: string,
  prompt: string,
  signal: AbortSignal | undefined,
  completeSimpleImpl: CompleteSimpleLike,
  extraTextParts: string[] = [],
): Promise<string> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const options: SimpleStreamOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    signal,
  };

  const message = await completeSimpleImpl(model, buildPiVisionContext(imageReference, prompt, extraTextParts), options);

  if (message.stopReason === "error") {
    throw new Error(message.errorMessage ?? "VLM request failed");
  }

  return extractAssistantText(message);
}

export function extractAssistantText(message: AssistantMessage): string {
  const text = message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) throw new Error("VLM response did not include text content");
  return text;
}

export function parseImageReference(reference: string): { type: "image"; data: string; mimeType: string } {
  if (reference.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(reference);
    if (!match) throw new Error("Only base64 data:image URLs are supported for pi model calls");
    return { type: "image", mimeType: match[1], data: match[2] };
  }
  if (isHttpUrl(reference)) {
    return { type: "image", mimeType: "image/url", data: reference };
  }
  throw new Error("Invalid image reference");
}

function getMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function withOptionalTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

async function downloadImage(
  url: string,
  maxImageBytes: number,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<{ data: string; mimeType: string }> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new Error(`Image download failed (${response.status}): ${await response.text()}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxImageBytes) {
    throw new Error(`Image is ${contentLength} bytes, larger than maxImageBytes ${maxImageBytes}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxImageBytes) {
    throw new Error(`Image is ${bytes.byteLength} bytes, larger than maxImageBytes ${maxImageBytes}`);
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`URL did not return an image content-type: ${mimeType}`);
  }

  return { data: bytes.toString("base64"), mimeType };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function requireString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source}.${field} must be a non-empty string`);
  }
  return value;
}

function normalizeModelRef(value: Record<string, unknown>, source: string): string {
  const model = requireString(value.model, "model", source);
  if (model.includes("/")) return model;

  if (value.provider !== undefined) {
    const provider = requireString(value.provider, "provider", source);
    return `${provider}/${model}`;
  }

  throw new Error(`${source}.model must use pi model reference form "provider/model-id"`);
}

export function parseModelRef(modelRef: string, source: string): { provider: string; modelId: string } {
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) {
    throw new Error(`${source}.model must use pi model reference form "provider/model-id"`);
  }

  return {
    provider: modelRef.slice(0, slash),
    modelId: modelRef.slice(slash + 1),
  };
}

function requirePositiveInteger(value: unknown, field: string, source: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${source}.${field} must be a positive integer`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string, source: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${source}.${field} must be a boolean`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObjectIfPresent(path: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(value) ? value : {};
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return {};
    throw error;
  }
}
