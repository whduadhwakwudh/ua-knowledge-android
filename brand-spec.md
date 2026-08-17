# UA · 品牌规格

个人知识库「UA」移动端入口。核心理念：**随手记录、随时检索、收藏沉淀**。目标用户：个人知识管理爱好者。

一句话系统：iOS 浅色原生风格——白底灰阶分组背景、系统蓝单点强调、SF Pro 字体栈、圆角卡片与克制的留白。

## 六项核心 Token（OKLch）

| Token | Light（浅色，默认） | Dark（深色可选） |
|---|---|---|
| `--bg` | `oklch(96.26% 0.007 286.3)`（iOS systemGroupedBackground #F2F2F7） | `oklch(0% 0 0)` |
| `--surface` | `oklch(100% 0 0)`（白 #FFFFFF） | `oklch(22.73% 0.004 286.1)`（#1C1C1E） |
| `--fg` | `oklch(0% 0 0)`（#000000） | `oklch(100% 0 0)` |
| `--muted` | `oklch(53.26% 0.006 286.2)`（#6C6C70，白底 5.23:1） | `oklch(68.19% 0.010 286.1)`（#98989F，深底 5.94:1） |
| `--border` | `oklch(88.4% 0.008 286.2)`（#D8D8DE） | `oklch(34.14% 0.003 286.2)`（#38383A） |
| `--accent` | `oklch(60.28% 0.218 257.4)`（系统蓝 #007AFF） | `oklch(62.43% 0.206 255.5)`（#0A84FF） |

派生色：`--accent-soft` / `--fg-soft` 一律用 `color-mix(in oklch, …)` 生成；搜索框填充 `--field` 浅色 `oklch(93.55% 0.007 286.3)`（#E9E9EE）、深色 `oklch(22.73% 0.004 286.1)`；占位文字 `--placeholder` 浅色 `oklch(48.36% 0.008 286.1)`（#5E5E63，字段底 5.33:1）、深色用 `--muted`。

## 字体栈

- **Display**：`-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif` — 700–800 字重，`letter-spacing: -0.02em`，用于大标题。
- **Body**：`-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif` — 15px/1.5。
- **Mono**：`ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace` — 数字、时间、编号用 `tabular-nums`。

## 视觉语言规则

1. **单点强调**：accent 系统蓝每屏 ≤ 2 次（默认 = 1 个激活 tab + 1 个主操作）。收藏状态用黑/灰星形，不用蓝色。
2. **分层背景**：`--bg` 分组灰底 + 白色卡片（14–16px 圆角、1px 发丝分隔），iOS grouped 列表风格。
3. **间距阶梯**：4 / 8 / 12 / 16 / 24px；内容边距 20px；触控目标 ≥ 44px。
4. **动效纪律**：150ms 状态确认、220ms 页面淡入、280ms sheet 滑入（iOS 曲线 `cubic-bezier(0.32, 0.72, 0, 1)`）；`prefers-reduced-motion` 时仅保留透明度变化。
5. **无装饰性动效**：只动「状态切换、层级推进」；不设漂浮、常驻加载动画。
