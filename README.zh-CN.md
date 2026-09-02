# Bilibili Digest

[English](README.md) | [简体中文](README.zh-CN.md)

把 B 站和 YouTube 视频变成一份可以深入学习的资料。Bilibili Digest 把字幕、双语翻译、AI 概览、内容讲解和时间戳笔记放进同一个 Chrome 侧边栏，让你可以持续学习视频中的知识和语言，同时不丢失原视频上下文。

- 把零碎字幕变成清晰、可搜索的学习资料。
- 查看原文、简体中文翻译，或中英双语对照字幕来学习语言。
- 通过 AI 概览、章节、重点引用和选中文本讲解建立系统理解。
- 点击字幕、概览或笔记中的时间戳，快速跳转到对应位置。
- 保存带字幕和截图的时间戳笔记，并可以导出为 PDF。
- 使用自己的 API Key，数据保存在本地 Chrome 中，不包含分析统计或行为追踪。

Bilibili Digest 是一个需要自行提供 API Key 的开源项目，通过 GitHub 安装。目前没有上架 Chrome 应用商店，不赠送 API 额度，也没有开发者运营的服务器。

## 让你的编程 Agent 帮你安装

你不需要看懂代码，也不需要会使用命令行。把下面这段话发送给你的编程 Agent：

> 请把这个项目下载或克隆到我选择的长期保留文件夹，告诉我准确的完整路径，并让 Chrome“加载已解压的扩展程序”使用同一个文件夹。如果我在第一次安装时需要位置建议，可以推荐 macOS 或 Linux 上的 `~/Documents/bilibili-digest`，或 Windows 上的 `%USERPROFILE%\Documents\bilibili-digest`，但不要假设我一定使用这些路径。请用简单易懂的语言一步一步指导我完成安装和配置。https://github.com/Vic6521/bilibili-digest

你的 Agent 应该帮你：

1. 先询问你想把项目长期保存在哪里，再下载或克隆到那里，并告诉你准确的完整路径。如果你需要建议，可以推荐 macOS 或 Linux 上的 `~/Documents/bilibili-digest`，或 Windows 上的 `%USERPROFILE%\Documents\bilibili-digest`。
2. 打开下方 DeepSeek、Supadata 和 Qwen 官方页面，指导你创建自己的账号。
3. 指导你在 Chrome 中通过“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹。
4. 告诉你应该在扩展的“设置”页面哪个位置填写 API Key。
5. 打开一个 B 站或 YouTube 视频，确认字幕和翻译功能可以使用。

安装后请让这个文件夹留在原位。如果移动或删除它，Chrome 中加载的本地扩展会失效，需要从新的长期存放位置重新加载。

不要把 API Key 发送到 AI 对话、源代码、截图或公开消息中。请你自己在 Bilibili Digest 的设置页面直接填写。编程 Agent 可以告诉你填写位置，但不需要看到 Key。

## 手动安装

如果你想自己操作：

1. 打开 [github.com/Vic6521/bilibili-digest](https://github.com/Vic6521/bilibili-digest)。
2. 点击 **Code**，再选择 **Download ZIP**。
3. 选择一个长期保留的文件夹，并把项目解压到这里。可选建议是 macOS 或 Linux 上的 `~/Documents/bilibili-digest`，或 Windows 上的 `%USERPROFILE%\Documents\bilibili-digest`。你也可以使用其他文件夹。
4. 在 Chrome 地址栏打开 `chrome://extensions`。
5. 打开右上角的“开发者模式”。
6. 点击“加载已解压的扩展程序”。
7. 选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest.json`。
8. 如果需要，可以在 Chrome 扩展菜单中固定 Bilibili Digest。

这是一个本地加载的扩展，不会自动更新。下载新版或让 Agent 修改代码后，请在 `chrome://extensions` 中找到 Bilibili Digest 并点击“重新加载”，然后刷新已经打开的视频页面。如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。

## 设置 API Key

Bilibili Digest 需要你在自己的服务账号中准备以下 Key，具体取决于平台和功能：

1. **DeepSeek API Key**，用于两个平台上的概览、讲解、翻译和笔记润色等文本 AI 功能。
2. **Supadata API Key**，用于获取 YouTube 字幕；当 B 站视频没有原生字幕时，也会作为备用方案。
3. **Qwen（阿里云百炼 / DashScope）API Key**，用于截图相关的 AI 功能，例如总结保存的截图或讲解当前视频画面。

B 站视频优先使用 B 站官方字幕 API，因此只看 B 站字幕不需要 Supadata。YouTube 字幕始终需要 Supadata。

### 获取 DeepSeek API Key

1. 打开官方 [DeepSeek API Keys 页面](https://platform.deepseek.com/api_keys)。
2. 如果尚未注册，先创建 DeepSeek 开放平台账号并登录。
3. 点击 **Create new API key**，输入一个容易识别的名称，例如 `Bilibili Digest`，然后创建。
4. 立即复制密钥。完整密钥可能只显示一次。
5. 把它粘贴到 Bilibili Digest 设置页面的 **DeepSeek API key** 中。
6. 如果 DeepSeek 提示余额不足，请先在 DeepSeek 开放平台账号中充值，再重试。

更多账号和 API 信息，请查看 [DeepSeek 官方 API 文档](https://api-docs.deepseek.com/)。

### 获取 Supadata API Key

1. 打开官方 [Supadata 注册页面](https://dash.supadata.ai/auth/sign-up)。
2. 创建账号并完成简短的开通流程。
3. 开通流程中 Supadata 会自动生成 API Key。
4. 之后需要查找或管理密钥时，打开 [Supadata 控制台](https://dash.supadata.ai/)。
5. 复制密钥，粘贴到 Bilibili Digest 设置页面的 **Supadata API key** 中。

如果控制台流程发生变化，请查看 [Supadata 官方文档](https://docs.supadata.ai/)。

### 获取 Qwen API Key

1. 打开 [阿里云百炼控制台](https://bailian.console.aliyun.com/) 或 DashScope 控制台。
2. 如果尚未注册，先创建阿里云账号并登录。
3. 创建 DashScope API Key，并确保开通了计费。
4. 复制密钥，粘贴到 Bilibili Digest 设置页面的 **Qwen API key** 中。

截图总结和画面讲解等视觉功能通过 DashScope 兼容模式调用 `qwen-vl-plus`。没有 Qwen Key 时，扩展的其余功能仍然可用，只有视觉相关任务不可用。

打开侧边栏中的 **Settings**，或者在 `chrome://extensions` 的 Bilibili Digest 卡片上打开 **选项** 页面（也可以右键点击工具栏图标）。只把 Key 粘贴到这些设置字段中。永远不要把 Key 粘贴到 AI 对话、仓库文件、截图或公开消息中。

发布版本把文本 AI 任务路由到 DeepSeek V4 Flash，把截图相关任务路由到 Qwen VL Plus：

```text
DeepSeek 文本模型
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash

Qwen 视觉模型
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
Model: qwen-vl-plus
```

Bilibili Digest 以非思考模式发送每次 DeepSeek 请求，以获得快速稳定的交互体验。端点和模型在设置中是固定的，因此你只需要填写 DeepSeek 和 Qwen 两个 API Key。如果想使用其他服务或模型，请先在自己的本地副本上使用设置中的安全自定义提示词，并交给编程 Agent 修改。永远不要在提示词或聊天中加入 API 密钥。

密钥和设置保存在 Chrome 本地扩展存储中。发布版本不包含也不会使用 `config.js`。

## 使用 Bilibili Digest
<img width="782" height="527" alt="bili操作流程" src="https://github.com/user-attachments/assets/c89cb47d-5a56-4982-891d-20338ad90865" />

1. 打开 Bilibili 或 YouTube 视频。
2. 点击浏览器扩展图标，打开 Bilibili Digest 侧边栏。
3. 查看视频字幕，可切换原文、中文或双语模式。
4. 切换到“总览”页面，查看 AI 生成的章节和重点内容。
5. 在视频页面点击“Note”按钮，保存当前时间点和视频截图。
6. 打开“笔记”页面，查看、编辑笔记或识别截图中的板书文字。
7. 选择“当前视频”或“全部笔记”查看笔记内容。
8. 点击“导出 PDF”，笔记文件会自动下载到本地。

快捷操作：
- 按 N：保存当前视频笔记
- 点击时间点：跳转到视频对应位置
- 按 Ctrl + Enter：快速保存新知识点
## 当前可用的功能
<img width="760" height="552" alt="diagram-2026-08-28" src="https://github.com/user-attachments/assets/e5bffd6e-dbd8-4e79-bfe2-46b7e9ae4d8d" />



Bilibili Digest 是一款 AI 视频学习助手，支持 Bilibili 和 YouTube 视频内容整理。

主要功能：
- 自动提取视频字幕
- AI 生成章节和内容摘要
- 提取关键知识点和重点引用
- 截图识别板书、文字和数学公式
- 按章节分级管理学习笔记
- 支持笔记编辑、删除和实时同步
- 一键导出并下载 PDF 笔记
- 支持中文、原文和双语字幕
- 本地保存数据，减少重复请求

产品核心价值：
将视频内容快速转化为结构化、可编辑、可复习的学习资料。
<img width="738" height="912" alt="image" src="https://github.com/user-attachments/assets/f23420ed-44c9-4cd1-b53a-737937d6bbb2" />


## Supadata 免费额度与请求成本

截至 2026 年 8 月 9 日，[Supadata 定价页面](https://supadata.ai/pricing)显示免费套餐每月 **100 个额度**，无需信用卡。未用完的额度不会结转。Supadata 定价可能变化，请在依赖这些数字前查看当前页面。

[Supadata 字幕文档](https://docs.supadata.ai/get-transcript)描述了请求模式和额度计算：

- 一次原生字幕请求使用 **1 个额度**，与视频时长无关。
- 一次生成字幕按 **每分钟 2 个额度** 计费。Bilibili Digest 对 YouTube 不使用这条路径，因为它强制使用 `mode=native`。
- 返回 HTTP `206` 的不可用原生查询仍然使用 **1 个额度**。

目前 YouTube 只走原生模式，免费额度每月大约可以覆盖 **100 次字幕查询**（假设每次请求都能一次成功）。重试和不可用字幕的查询也会消耗额度，因此实际可成功覆盖的视频数量可能更低。

DeepSeek 和 Qwen 的使用与 Supadata 相互独立。DeepSeek 和 Qwen 可能有各自的免费配额、限速或费用。Bilibili Digest 不代收费用，也不转售访问权限。请为两个账号分别设置消费上限并留意余额。下面的估算说明了当前 DeepSeek 翻译成本。

## DeepSeek V4 Flash 翻译成本估算

截至 2026 年 8 月 10 日，DeepSeek 官方 [定价页面](https://api-docs.deepseek.com/quick_start/pricing/)列出每 100 万 token 的价格：

- 缓存命中输入：**¥0.02（约 $0.0028 USD）**。
- 缓存未命中输入：**¥1（约 $0.14 USD）**。
- 输出：**¥2（约 $0.28 USD）**。

DeepSeek 表示这些价格近期可能上调，请在使用前查看当前定价页面。其官方 [token 用量说明](https://api-docs.deepseek.com/quick_start/token_usage/)估算每个英文字符约 0.3 token、每个中文字符约 0.6 token。其 [上下文缓存说明](https://api-docs.deepseek.com/guides/kv_cache/)解释了用于重复前缀的自动磁盘缓存机制。

一个实测的 20 分钟英文讲座包含 **2,935 个英文口语词**，共 15,433 个正文字符。按 Bilibili Digest 当前的分组方式，它被分成 128 个语义分段和 43 次请求，每次 3 个分段。重复的提示词和 JSON 使实际输入约 108,528 个英文字符，按 DeepSeek 每英文字符 0.3 token 估算，约 32,600 个输入 token。翻译后的中文 JSON 输出按每中文字符 0.6 token 估算，约为 3,500 到 4,500 个 token，另加 JSON 和 ID 开销。

如果全部输入都按缓存未命中计费，输入成本约 $0.0046，输出成本约 $0.0010 到 $0.0013，合计约 $0.0056 到 $0.0059。当大量重复的系统提示词命中 DeepSeek 的自动缓存时，一个更现实的低端约为 $0.002 到 $0.003。因此完整翻译这个讲座的实用估算为 **$0.002 到 $0.006 USD（约 ¥0.02 到 ¥0.04）**。

翻译是懒加载、渐进式的。已缓存的分段会被复用，只有你滚动进入的行才会触发请求。重试、服务商行为变化和价格调整都可能增加最终成本。

## 用编程 Agent 改造它

这是一个个人改造项目，不接受上游 Issue 或 Pull Request。如果出现问题或想要新功能，请下载或 Fork 自己的副本，让你的编程 Agent 帮你修复、改造或个性化。

Bilibili Digest 使用纯 HTML、CSS 和 JavaScript，没有构建步骤，是 Agent 辅助项目友好的起点。可以尝试的方向：

- 增加更多翻译语言，让每个人选择自己的学习语言。
- 为讲座、访谈、教程、评测或研究报告创建定制概览模板。
- 建立生词本，保存单词、所在句子、释义和视频时间戳。
- 把笔记和生词导出为 Markdown、CSV、Anki 或其他学习工具。
- 增加个人主题筛选，只突出与你目标相关的章节。
- 增加本地模型选项，获得不同的隐私和成本方案。
- 改善键盘操作、字体大小和高对比度等无障碍体验。

请让 Agent 保留用户自带 API Key 的模式，不要把秘密写入源代码，并运行下方检查。分享自己的版本前，也要在真实视频上测试。

如果想使用其他 AI 服务或模型，请先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 Bilibili Digest 项目文件夹。然后打开 Bilibili Digest 设置并点击 **Copy customization prompt**。发送前替换 `[PROVIDER]` 和 `[MODEL]`，但不要加入任何 API Key。Agent 完成本地代码修改后，请你自己在它指出的设置位置填写 Key。

## 隐私和数据流向

Bilibili Digest 会直接从扩展向服务商发送请求：

1. 在 B 站视频上，向 B 站字幕 API 请求该视频的字幕 JSON。
2. 查看 YouTube 字幕时，向 Supadata 发送标准化的 YouTube 视频地址；当 B 站视频没有原生字幕时，也作为备用方案发送。
3. 使用文本 AI 功能时，把字幕和相关视频信息发送给 DeepSeek；使用视觉功能时，把截图或画面内容发送给 Qwen。
4. 讲解、翻译等功能只发送当前需要的内容，例如选中的文本和上下文，或少量字幕分段。
5. API Key、设置、笔记和最近缓存保存在 Chrome 本地。

Bilibili Digest 没有账号系统、广告、分析统计或行为追踪。Supadata、DeepSeek、Qwen 和 B 站仍会按照各自的条款和隐私政策处理数据。详情请查看 [PRIVACY.md](PRIVACY.md)。

## 常见问题

### B 站视频找不到字幕

- 确认视频是公开的，并且有字幕轨道。部分 B 站视频没有字幕。
- 如果视频没有原生字幕，Bilibili Digest 会回退到 Supadata。如果预期走备用路径，请检查 Supadata Key、剩余额度、限速和账号状态。
- 在 `chrome://extensions` 中找到 Bilibili Digest，点击“重新加载”，然后刷新 B 站页面。
- 如果问题仍然存在，让你的编程 Agent 在这个具体视频页面检查 content script。

### YouTube 视频页面没有显示 Digest 按钮

- 在 `chrome://extensions` 中找到 Bilibili Digest，点击“重新加载”，然后刷新 YouTube 页面。
- 确认当前页面是标准 `https://www.youtube.com/watch?...` 页面，而不是 Shorts、嵌入页面或直播页面。
- 当前版本会在 YouTube 响应式操作栏变化时自动重新定位按钮。页面加载完成后可以稍等片刻。
- 如果你使用的是较早下载的版本，可以先横向调整一次 YouTube 窗口宽度让按钮出现，然后下载最新版，这样之后不再需要调整窗口。
- 如果按钮仍然没有出现，让你的编程 Agent 在这个具体视频页面检查 content script。

### 侧边栏无法打开

- 确认你打开的是标准 B 站视频页面或 `https://www.youtube.com/watch?...` 页面。
- 在 `chrome://extensions` 中确认 Bilibili Digest 已启用，并点击“重新加载”。
- 重新加载扩展后，刷新视频页面。
- 如果问题仍然存在，让你的编程 Agent 检查扩展。

### Bilibili Digest 提示需要设置

- 打开 **Settings**，保存 DeepSeek Key 以使用文本 AI 功能。YouTube 字幕需要 Supadata Key，截图功能需要 Qwen Key。
- 发布版本固定使用 DeepSeek V4 Flash 和 Qwen VL Plus，没有需要填写的 Base URL 或 Model 字段。
- 如果设置提示旧的自定义服务已移除，请重新填写 DeepSeek Key。旧 AI Key 已安全清除，避免被错误用于 DeepSeek。

### 找不到字幕

- 确认视频是公开的，并且有字幕。
- 当字幕请求走 Supadata 时，检查 Supadata Key、剩余额度、限速和账号状态。
- 没有字幕的查询和手动重试也可能消耗额度。

Bilibili Digest 不会自动改用 AI 生成字幕。

### AI 请求失败

- `401` 或 `403` 通常表示 DeepSeek 或 Qwen Key 或账号权限有问题。
- `429` 通常表示达到了 DeepSeek 或 Qwen 服务限速或消费上限。
- 确认 Key 来自上方链接的对应服务商账号，并且账号有可用额度。
- 如果你把本地副本改成了其他模型，请再次使用设置中的自定义 prompt，让编程 Agent 检查本地实现。

不要在对话、截图或日志中分享 API Key、私密字幕或个人笔记。

## 给编程 Agent 的检查命令

修改项目后，让你的编程 Agent 运行：

```bash
npm test
npm run check
npm run package
```

Agent 还应该在 Chrome 中重新加载扩展，并测试多个真实的 B 站和 YouTube 视频。自动检查通过，不代表真实服务请求和视频页面交互一定正常。

## 开源许可

MIT，详见 [LICENSE](LICENSE)。
