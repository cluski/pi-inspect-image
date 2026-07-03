import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  getAvailableImageModelItems,
  inspectImage,
  saveProjectConfigModel,
  type InspectImageDetails,
} from "./inspect.ts";
import { createInspectImageModelPicker } from "./model-picker.ts";

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

export default function inspectImageExtension(pi: ExtensionAPI): void {
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
      "Inspect an image with the VLM configured in .pi/inspect-image.json. Use this when the active model cannot see images or when visual details are needed.",
    promptSnippet: "Inspect an image through the configured VLM using an explicit prompt from the main LLM.",
    promptGuidelines: [
      "Use inspect_image when image understanding is needed and the active model may not have vision capability.",
      "Use inspect_image with a concrete image path or URL and an explicit prompt that tells the VLM what to inspect.",
      "Do not call inspect_image with a generic or empty prompt; tailor the prompt to the user's current question.",
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
}
