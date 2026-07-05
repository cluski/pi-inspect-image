import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  getAvailableImageModelItems,
  getProjectConfigPath,
  inspectImage,
  readProjectEnabled,
  saveProjectConfigEnabled,
  saveProjectConfigModel,
  selectInspectImageModel,
  type InspectImageDetails,
} from "./inspect.ts";
import { createInspectImageModelPicker } from "./model-picker.ts";
import {
  applyToolState,
  INSPECT_IMAGE_TOOL_NAME,
  parseToggleArgument,
} from "./tool-toggle.ts";

const inspectImageSchema = Type.Object({
  image: Type.String({
    description:
      "Image path relative to the current workspace, absolute image path, http(s) image URL, or data:image URL. A leading @ is ignored for paths.",
  }),
  prompt: Type.String({
    description:
      "Required instruction from the main LLM describing what the VLM should inspect, extract, or focus on in the image.",
  }),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Optional timeout in milliseconds for this inspection call. Omit it by default; set it only when the task needs a bounded wait.",
    }),
  ),
});

export type InspectImageInput = Static<typeof inspectImageSchema>;

const inspectImageSelectModelSchema = Type.Object({
  model: Type.Optional(
    Type.String({
      description:
        'Optional pi model reference like "provider/model-id" to select explicitly. Omit to auto-pick the first available logged-in image-capable model.',
    }),
  ),
});

export type InspectImageSelectModelInput = Static<typeof inspectImageSelectModelSchema>;

export type InspectImageSelectModelDetails = {
  selected: string;
  provider: string;
  modelId: string;
  autoSelected: boolean;
};

export default function inspectImageExtension(pi: ExtensionAPI): void {
  // Apply the persisted enabled flag at the start of every session so the
  // toggle survives reloads and new sessions.
  pi.on("session_start", async (_event, ctx) => {
    const enabled = await readProjectEnabled(ctx.cwd);
    if (!enabled) {
      pi.setActiveTools(applyToolState(pi.getActiveTools(), INSPECT_IMAGE_TOOL_NAME, false));
    }
  });

  pi.registerCommand("inspect-image-toggle", {
    description: "Turn the inspect_image tool on or off (toggle when no argument is given)",
    getArgumentCompletions: (prefix) => {
      const options = ["on", "off"];
      const lower = prefix.toLowerCase();
      const matches = options.filter((option) => option.startsWith(lower));
      return (matches.length > 0 ? matches : options).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const directive = parseToggleArgument(args);
      const enabled = directive === undefined ? !(await readProjectEnabled(ctx.cwd)) : directive;
      const configPath = await saveProjectConfigEnabled(ctx.cwd, enabled);
      pi.setActiveTools(applyToolState(pi.getActiveTools(), INSPECT_IMAGE_TOOL_NAME, enabled));
      ctx.ui.notify(
        `${enabled ? "inspect_image is now on" : "inspect_image is now off"} (saved to ${configPath})`,
        "info",
      );
    },
  });

  pi.registerCommand("inspect-image-model", {
    description: "Select and persist the VLM model used by inspect_image",
    handler: async (args, ctx) => {
      const requested = args.trim();
      const models = getAvailableImageModelItems(ctx);
      if (models.length === 0) {
        ctx.ui.notify("No logged-in image-capable models found.", "warning");
        return;
      }

      const modelRefs = models.map((model) => model.ref);
      const selected = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
        createInspectImageModelPicker(tui, theme, keybindings, models, done, requested),
      );
      if (!selected) return;

      if (!modelRefs.includes(selected)) {
        ctx.ui.notify(`Model is not logged in or does not support image input: ${selected}`, "error");
        return;
      }

      const configPath = await saveProjectConfigModel(ctx.cwd, selected);
      ctx.ui.notify(`inspect_image model set to ${selected} in ${configPath}`, "info");
    },
  });

  pi.registerTool<typeof inspectImageSchema, InspectImageDetails>({
    name: "inspect_image",
    label: "Inspect Image",
    description:
      "Inspect an image with the VLM configured in .pi/inspect-image.json. Use this when the active model cannot see images or when visual details are needed. If no VLM is configured or the configured one is unavailable, call inspect_image_select_model first.",
    promptSnippet: "Inspect an image through the configured VLM using an explicit prompt from the main LLM.",
    promptGuidelines: [
      "Use inspect_image when image understanding is needed and the active model may not have vision capability.",
      "Use inspect_image with a concrete image path or URL and an explicit prompt that tells the VLM what to inspect.",
      "Do not call inspect_image with a generic or empty prompt; tailor the prompt to the user's current question.",
      "If inspect_image reports a missing or unavailable VLM, call inspect_image_select_model (optionally with a model ref) and retry.",
    ],
    parameters: inspectImageSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await inspectImage(ctx, params, signal);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });

  pi.registerTool<typeof inspectImageSelectModelSchema, InspectImageSelectModelDetails>({
    name: "inspect_image_select_model",
    label: "Inspect Image: Select Model",
    description:
      "Select and persist the VLM used by inspect_image, picking from logged-in image-capable models. Call this when inspect_image fails because no VLM is configured or the configured VLM is unavailable. Omit model to auto-pick the first available image-capable model.",
    promptSnippet: "Pick a VLM for inspect_image from the available image-capable models.",
    promptGuidelines: [
      "Call inspect_image_select_model when inspect_image reports a missing or unavailable VLM, then retry inspect_image.",
      "Omit the model argument to auto-pick the first available image-capable model, or pass a specific provider/model-id.",
    ],
    parameters: inspectImageSelectModelSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await selectInspectImageModel(ctx, { model: params.model });
      const how = result.autoSelected ? "auto-picked" : "set";
      return {
        content: [
          {
            type: "text",
            text: `inspect_image model ${how} to ${result.selected} and saved to ${getProjectConfigPath(ctx.cwd)}.\nAvailable image models: ${result.available.map((m) => m.ref).join(", ")}`,
          },
        ],
        details: {
          selected: result.selected,
          provider: result.provider,
          modelId: result.modelId,
          autoSelected: result.autoSelected,
        },
      };
    },
  });
}
