# 配置说明（域名与问答 Class）

插件使用 `config.js` 统一定义平台识别与问答容器 class。

## 当前配置
- Kimi
  - 域名前缀：`https://www.kimi.com/chat`、`https://kimi.com/chat`、`https://kimi.moonshot.cn/chat`
  - 问-class：`chat-content-item-user`
  - 答-class：`chat-content-item-assistant`
  - ref-class 选择器：`.rag-tag.text`
  - ref-text 属性：`data-site-name`
  - exclude-class：`toolcall-container`
  - 扫描范围：`scanLatestAnswerOnly = true`（仅最新回答）
- 豆包（占位）
  - 域名前缀：`https://www.doubao.com/chat`、`https://doubao.com/chat`
  - 问-class：`chat-content-item-user`
  - 答-class：`chat-content-item-assistant`
  - ref-class 选择器：`.rag-tag.text`
  - ref-text 属性：`data-site-name`
  - exclude-class：`toolcall-container`
  - 扫描范围：`scanLatestAnswerOnly = true`（仅最新回答）

## 使用方式
- `manifest.json` 已按顺序注入：
  1. `config.js`
  2. `content.js`
- `content.js` 只按配置匹配，不再使用模糊关键词识别。
- 抽取时优先按 `refSelector` 命中 ref 节点，并读取 `refTextAttr`（如 `News18`）。
- claim 文本采用“该 ref 节点之前最近一句文本”。
- 抽取结果不合并，按文本在页面中的出现顺序逐条输出。
- 位于 `exclude-class` 容器（如 `.toolcall-container`）内的内容会被忽略。
