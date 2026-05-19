# Step 2 说明：平台识别与消息协议

## 关键函数名
- `background.js`
  - `getActiveTabId()`
  - `detectPlatformFromActiveTab()`
- `content.js`
  - `detectPlatformByHost(hostname)`
  - `findKimiAnswerContainer()`
  - `detectCurrentPageStatus()`
- `sidepanel.js`
  - `refreshPlatformStatus()`
  - `formatPlatformLabel(status)`

## 消息协议
- `sidepanel -> background`
  - `GET_PLATFORM_STATUS`
- `background -> content`
  - `DETECT_PLATFORM`

## 返回结构
```json
{
  "ok": true,
  "data": {
    "platform": "kimi|doubao|unsupported",
    "supportStatus": "ready|pending|none",
    "answerContainerFound": true,
    "matchedSelector": "[data-testid*=assistant]"
  }
}
```

## 验证步骤
1. 重新加载扩展（`chrome://extensions` -> 重新加载）。
2. 打开 Kimi 页面并打开侧边栏，检查：
   - 平台状态：`Kimi`
   - 回答容器：`已找到`（若页面结构变化可能显示未找到）
3. 打开非目标页面，检查平台状态为 `未支持`。
