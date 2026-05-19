# Step 3 说明：抽取带链接引用句（句级）

## 新增消息协议
- `sidepanel -> background`
  - `SCAN_CLAIMS`
- `background -> content`
  - `EXTRACT_CLAIMS`

## 返回结构
```json
{
  "ok": true,
  "platform": "kimi",
  "claims": [
    {
      "id": "claim_1",
      "claimText": "......",
      "anchorText": "......",
      "url": "https://...",
      "domLocation": {
        "cssPath": "...",
        "textNodeIndex": 0,
        "startOffset": 0,
        "endOffset": 8
      },
      "context": "......"
    }
  ]
}
```

## 关键逻辑
- 仅在 Kimi 且回答容器已找到时执行抽取。
- 从回答容器内抽取 `a[href]`，过滤非 `http/https`。
- 以“含链接句子”为 claim，默认去重键：`claimText + url`。
- 过滤空 `anchorText`、空 `claimText`。
- 侧边栏每行展示：claim 摘要 + 域名 + `待核查`。
- 扫描后会按 URL 分组抓取 ref 网页全文（同 URL 只抓一次），并为每条 claim 计算可能性分数。
- 判定函数：`evaluateClaimPossibility(claimText, sourceText, method)`，当前默认方法 `token_window_v1`（后续可扩展新增方法）。

## 验证步骤
1. 重新加载扩展，打开 Kimi 带引用链接的回答页面。
2. 打开侧边栏，点击“扫描当前回答”。
3. 结果区应出现列表，每行显示：
   - claim 摘要
   - 域名
   - 状态“待核查”
4. 至少抽取一条记录时，检查每条都有 URL 与 claim 文本。
5. 无效链接或空文本不应出现在列表中。
