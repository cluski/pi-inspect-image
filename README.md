# pi-inspect-image

`pi-inspect-image` is a pi extension that registers an `inspect_image` tool. The tool lets the active agent ask a separate vision model to inspect an image, which is useful when your main model is not a VLM.

The vision model is selected from pi's registered models. This extension does not implement provider protocols itself; it uses pi's model registry for the configured `provider/model-id`, resolves auth through pi, and calls pi-ai's provider dispatch.

## Install

After publishing to npm:

```bash
pi install npm:pi-inspect-image
```

For local testing from this repository:

```bash
pi -e ./src/index.ts
```

## Configure

Create `.pi/inspect-image.json` in your project, or `~/.pi/agent/inspect-image.json` globally:

```json
{
  "model": "openai/gpt-4.1",
  "maxImageBytes": 20971520,
  "enabled": true,
  "autoResizeImages": true
}
```

`model` must use pi's normal `provider/model-id` form and match a model already known to pi, for example from built-in providers or `~/.pi/agent/models.json`. The selected model must be registered with `"image"` input support.

- `maxImageBytes` caps the raw image size loaded into memory (default `20971520`). Images larger than this are rejected before the VLM call.
- `autoResizeImages` (default `true`) shrinks the image to inline provider limits (max 2000x2000, ~4.5MB) using the same Photon-based resizer as pi's `read` tool, and appends a dimension note so the VLM can map coordinates back to the original. Set to `false` to send the original bytes. If resizing is unavailable the original image is sent as-is.

You can also point `PI_INSPECT_IMAGE_CONFIG` at a custom JSON file.

## Model Command

Use the slash command to select and persist the inspect model from the terminal:

```text
/inspect-image-model
```

The command opens a picker with a search input above the model list. Typing filters logged-in pi models that support image input, and the selected model is written to the project `.pi/inspect-image.json`.

You can also pass initial search text:

```text
/inspect-image-model claude sonnet
```

## Toggle Command

Turn the `inspect_image` tool on or off without leaving the session. The state is persisted to the project `.pi/inspect-image.json` under an `enabled` field (default `true`) and reapplied on every session start, so it survives reloads and new sessions.

```text
/inspect-image-toggle
```

With no argument the tool is toggled. Pass `on`/`off` (or `enable`/`disable`) to set it explicitly:

```text
/inspect-image-toggle off
```

The command notifies the resulting state and the path it was saved to (`inspect_image is now off (saved to …/inspect-image.json)`). You can also set the flag by hand:

## Tool

The extension registers:

```text
inspect_image(image, prompt, timeoutMs?)
```

`prompt` is required. The main LLM must pass a task-specific prompt on every call so the VLM inspects the image for the current user request rather than following a static default.

`timeoutMs` is optional and belongs to the tool call, not the config file. By default the extension does not add a timeout; it only follows pi's normal cancellation signal.

`image` accepts:

- a path relative to pi's current workspace
- an absolute path
- a path prefixed with `@`
- an `http` or `https` image URL
- a `data:image/...;base64,...` URL

The tool reads or downloads the image, converts it to pi's `ImageContent`, and calls the configured pi model through `completeSimple`.

## Development

```bash
npm install
npm test
npm run type-check
```
