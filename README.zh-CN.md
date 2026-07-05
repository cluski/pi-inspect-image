# pi-inspect-image

`pi-inspect-image` 是一个 pi extension，会注册 `inspect_image` 工具。它用于让当前 agent 调用一个额外的视觉模型来检查图片，适合主力模型不是 VLM、但当前任务需要看图的场景。

视觉模型必须来自 pi 已注册的模型。这个 extension 不自己实现 provider 协议；它会通过 pi 的 model registry 查找配置中的 `provider/model-id`，用 pi 解析认证信息，然后通过 pi-ai 的 provider dispatch 发起模型调用。

## 安装

发布到 npm 后：

```bash
pi install npm:pi-inspect-image
```

本仓库本地调试：

```bash
pi -e ./src/index.ts
```

## 配置

在项目内创建 `.pi/inspect-image.json`，或创建全局配置 `~/.pi/agent/inspect-image.json`：

```json
{
  "model": "openai/gpt-4.1",
  "maxImageBytes": 20971520,
  "enabled": true,
  "autoResizeImages": true
}
```

`model` 使用 pi 惯例的 `provider/model-id` 格式，并且必须是 pi 已知的模型，例如内置模型或 `~/.pi/agent/models.json` 中注册的模型。该模型需要声明支持 `"image"` 输入。

- `maxImageBytes` 限制加载进内存的原始图片大小（默认 `20971520`），超过会在调用 VLM 前直接拒绝。
- `autoResizeImages`（默认 `true`）会在调用 VLM 前把图片缩放到符合 provider 内联限制的尺寸（最大 2000x2000、约 4.5MB），使用与 pi `read` 工具相同的 Photon 缩放器，并附带一条尺寸说明，方便 VLM 把坐标映射回原图。设为 `false` 则发送原始字节。当缩放不可用时，会原样发送原图。

也可以通过环境变量 `PI_INSPECT_IMAGE_CONFIG` 指向一个自定义 JSON 配置文件。

配置文件只负责选择 inspect 使用的 VLM 以及图片大小限制。`prompt` 不在配置里写，必须由主力 LLM 每次调用工具时传入。`timeoutMs` 也不在配置里写，如果需要超时限制，由主力 LLM 作为工具参数传入。

## 模型选择命令

可以用 slash command 在 terminal 中选择并持久化 inspect 使用的模型：

```text
/inspect-image-model
```

这个命令会打开一个选择界面：上面是搜索输入框，下面是模型列表。输入内容会实时筛选 pi 中已经登录/可用且支持 image input 的模型，选择结果会写入项目的 `.pi/inspect-image.json`。

也可以在命令后面传初始搜索文本：

```text
/inspect-image-model claude sonnet
```

## 开关命令

在会话中随时打开或关闭 `inspect_image` 工具。开关状态会持久化到项目 `.pi/inspect-image.json` 的 `enabled` 字段（默认 `true`），并在每次会话启动时重新应用，因此重启或新建会话后依然生效。

```text
/inspect-image-toggle
```

不带参数时会自动切换开关状态。也可以显式传入 `on`/`off`（或 `enable`/`disable`）：

```text
/inspect-image-toggle off
```

执行后会通知当前状态以及保存路径（如 `inspect_image is now off (saved to …/inspect-image.json)`）。你也可以直接手动修改该字段：

## 工具

extension 注册的工具：

```text
inspect_image(image, prompt, timeoutMs?)
```

`prompt` 是必填参数。主力 LLM 必须根据当前用户问题传入具体指令，告诉 VLM 需要检查、提取或关注图片里的什么内容。

`timeoutMs` 是可选参数，单位毫秒。默认不设置额外超时，只跟随 pi 当前 turn 的正常取消信号。

`image` 支持：

- 相对 pi 当前工作目录的路径
- 绝对路径
- 以 `@` 开头的路径
- `http` 或 `https` 图片 URL
- `data:image/...;base64,...` URL

工具会读取或下载图片，转换成 pi 的 `ImageContent`，然后通过 `completeSimple` 调用配置的 pi 模型。

### 自动选择 VLM

```text
inspect_image_select_model(model?)
```

当 `inspect_image` 因为没有配置 VLM、或配置的 VLM 已不再登录可用而失败时，LLM 可以调用 `inspect_image_select_model` 来恢复。不传参数时会自动挑选第一个已登录且支持 image 的模型；传入 `provider/model-id` 则指定具体模型。选择结果会持久化到 `.pi/inspect-image.json`，因此随后的 `inspect_image` 调用会直接使用它。

`inspect_image` 的报错信息会列出当前可用的 image 模型并提示调用这个工具，方便主力 LLM 在会话内自行恢复。

## 开发

```bash
npm install
npm test
npm run type-check
```
