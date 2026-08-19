# UA Knowledge Base — Android 客户端

一个 **Obsidian 风格的个人知识库移动端阅读器**（Capacitor + Android WebView）。

- **分类浏览**：按知识库目录（`wiki` / `outputs` / `raw`）筛选，Obsidian 风格左侧抽屉导航
- **随机阅读**：每次进入/切换分类/点「换一批」随机打乱笔记顺序
- **双链跳转**：`[[笔记名]]`、`[S024]` 来源编号均渲染为可点击链接；支持**反向链接**（哪些笔记引用了当前笔记）与跳转返回栈
- **全文搜索**：本地 MiniSearch 中文全文检索（离线可用）
- **智能助手**：知识库增强问答——可选「手机内置直连 LLM」或「服务端 `/v1/ask` 代理」两种模式
- **发布包自更新**：通过知识库同步服务远程分发 APK（仅展示最新版本）
- **离线优先**：内容缓存于本地 IndexedDB，可断网阅读、搜索、收藏
- **阅读缩放**：详情页双指手势缩放正文字号（0.7×–2.5×，自动记忆）

## 架构

```
┌──────────────────────┐      ┌──────────────────────────────┐
│  Android App (本仓库) │      │  ua-knowledge-sync (配套服务) │
│  Capacitor WebView   │ ───► │  Fastify 只读 API + manifest  │
│  IndexedDB 离线缓存   │      │  设备令牌认证 / SHA-256 校验    │
└──────────────────────┘      └──────────────────────────────┘
```

客户端通过设备令牌连接自建同步服务（`GET /v1/manifest`、`/v1/documents/:id`、`/v1/artifacts/:id`、可选 `POST /v1/ask`），把知识库的 Markdown 内容同步到本地离线缓存。**同步服务是独立仓库**：[ua-knowledge-sync](https://github.com/whduadhwakwudh/ua-knowledge-sync)。

## 构建

要求：Node 20+、Temurin JDK 21、Android SDK（API 36）。

```powershell
npm ci
npm test          # vitest 全量测试
& .\build-apk.ps1 # 测试 → 构建 web → cap sync → gradlew assembleDebug
```

产物：`dist\UA-debug.apk`（debug 签名，`io.ua.knowledgebase`，minSdk 24 / target 36）。

> 本仓库是 debug-signed 的自用/演示构建；正式发布需要 release keystore、签名配置与 AAB。

## 连接自己的知识库

1. 部署配套同步服务（见 [ua-knowledge-sync](https://github.com/whduadhwakwudh/ua-knowledge-sync) 的 README），签发设备令牌
2. App 内「我的 → 设置 → 知识库连接」填写服务器地址 + 设备令牌（可选：助手 API Key）
3. 首页「立即同步」→ 离线浏览全部内容

## License

MIT
