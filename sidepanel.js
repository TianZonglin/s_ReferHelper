const scanBtn = document.getElementById("scan-btn");
const results = document.getElementById("results");
const platformStatus = document.getElementById("platform-status");
const containerStatus = document.getElementById("container-status");
const classStatus = document.getElementById("class-status");
const statusArea = document.querySelector(".status-area");
let latestPlatformData = null;
let latestClaims = [];
let selectedClaimIndex = null;
let expandedClaimIndex = null;
let isScanning = false;
let scanProgress = {
  align: { total: 0, completed: 0, running: false },
  eval: { total: 0, completed: 0, running: false }
};
const SCAN_BTN_IDLE_TEXT = "扫描当前回答";
const SCAN_BTN_BUSY_TEXT = "扫描当前回答（正在解析中...）";

function setScanButtonBusy(busy) {
  if (!scanBtn) return;
  scanBtn.disabled = !!busy;
  scanBtn.textContent = busy ? SCAN_BTN_BUSY_TEXT : SCAN_BTN_IDLE_TEXT;
}

function formatPlatformLabel(status) {
  if (status === "kimi") return "Kimi";
  if (status === "doubao") return "豆包（待支持）";
  return "未支持";
}

function setDetectingState() {
  platformStatus.textContent = "平台状态：检测中";
  containerStatus.textContent = "回答容器：检测中";
  classStatus.textContent = "问答Class：检测中";
}

async function refreshPlatformStatus() {
  setDetectingState();
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_PLATFORM_STATUS" });
    if (!response?.ok) {
      latestPlatformData = null;
      platformStatus.textContent = "平台状态：未支持";
      containerStatus.textContent = "回答容器：无法检测";
      classStatus.textContent = "问答Class：无法检测";
      renderErrorBlock("平台检测失败", {
        error: response?.error || "UNKNOWN_ERROR",
        details: response?.details || null
      });
      return;
    }

    const data = response.data || {};
    latestPlatformData = data;
    platformStatus.textContent = `平台状态：${formatPlatformLabel(data.platform)}`;
    containerStatus.textContent = `回答容器：${data.answerContainerFound ? "已找到" : "未找到"}`;
    if (data.domainMatched) {
      const questionTag = data.questionContainerFound ? "问已找到" : "问未找到";
      const answerTag = data.answerContainerFound ? "答已找到" : "答未找到";
      const refTag = data.refSelector ? `；Ref=${data.refSelector} [${data.refTextAttr || "text"}]` : "";
      const excludeTag = data.excludeClass ? `；Exclude=.${data.excludeClass}` : "";
      const latestTag = data.scanLatestAnswerOnly ? "；Scope=latest-answer" : "；Scope=all-answers";
      classStatus.textContent = `问答Class：${data.questionClass} / ${data.answerClass}（${questionTag}，${answerTag}）${refTag}${excludeTag}${latestTag}`;
    } else {
      classStatus.textContent = "问答Class：未匹配到配置域名";
    }

    if (data.platform === "doubao") {
      results.textContent = "豆包适配器已预留，后续步骤接入。";
    } else if (data.platform === "unsupported") {
      results.textContent = "当前页面不在 Kimi/豆包 范围内。";
    } else if (data.platform === "kimi" && data.answerContainerFound) {
      results.textContent = "Kimi 页面检测通过，可进入 Step 3。";
    } else {
      results.textContent = "识别为 Kimi，但尚未定位到回答容器。";
    }
  } catch (_error) {
    latestPlatformData = null;
    platformStatus.textContent = "平台状态：未支持";
    containerStatus.textContent = "回答容器：无法检测";
    classStatus.textContent = "问答Class：无法检测";
    renderErrorBlock("平台检测失败", {
      error: "RUNTIME_EXCEPTION",
      details: {
        message: _error?.message || String(_error || "UNKNOWN_ERROR"),
        stack: _error?.stack || ""
      }
    });
  }
}

function escapeHtml(text) {
  return (text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function stringifyDetails(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function renderErrorBlock(title, response) {
  const parts = [];
  if (response?.error) parts.push(`error: ${response.error}`);
  if (response?.message) parts.push(`message: ${response.message}`);
  if (response?.details) parts.push(`details: ${stringifyDetails(response.details)}`);
  if (response?.stack) parts.push(`stack: ${response.stack}`);
  const detailText = parts.length ? parts.join("\n\n") : "未提供异常细节";
  results.innerHTML = `
    <div class="scan-error">
      <div class="scan-error-title">${escapeHtml(title)}</div>
      <pre class="scan-error-detail">${escapeHtml(detailText)}</pre>
    </div>`;
}

function renderMatchedConversationContent(details) {
  const claims = Array.isArray(details?.claims) ? details.claims : [];
  const userTexts = Array.isArray(details?.matchedConversationContent?.user)
    ? details.matchedConversationContent.user
    : [];
  const assistantTexts = Array.isArray(details?.matchedConversationContent?.assistant)
    ? details.matchedConversationContent.assistant
    : [];
  const userHtml = Array.isArray(details?.htmlcontent?.user) ? details.htmlcontent.user : [];
  const assistantHtml = Array.isArray(details?.htmlcontent?.assistant) ? details.htmlcontent.assistant : [];
  const citeHtml = Array.isArray(details?.htmlcontent?.cite) ? details.htmlcontent.cite : [];
  return `
    <div class="scan-debug">
      <div>claims: ${escapeHtml(stringifyDetails(claims))}</div>
      <div>user: ${escapeHtml(userTexts.join(" | ") || "[]")}</div>
      <div>assistant: ${escapeHtml(assistantTexts.join(" | ") || "[]")}</div>
      <div>userHtml: ${escapeHtml(stringifyDetails(userHtml))}</div>
      <div>assistantHtml: ${escapeHtml(stringifyDetails(assistantHtml))}</div>
      <div>citeHtml: ${escapeHtml(stringifyDetails(citeHtml))}</div>
    </div>`;
}

function getDomain(urlText) {
  try {
    return new URL(urlText).hostname;
  } catch (_error) {
    return "invalid-url";
  }
}

function resolveRefLabel(item) {
  const mergedRefs = Array.isArray(item.refTexts) && item.refTexts.length ? item.refTexts.join(", ") : "";
  if (mergedRefs) return mergedRefs;
  if (item.refText) return item.refText;
  if (item.url) return getDomain(item.url);
  return "no-ref";
}

function getPossibilityPercent(item) {
  const score = Number(item?.possibilityScore);
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

function getMatchedText(item) {
  return (item?.displayMatchText || item?.translatedClaimText || item?.claimText || "").trim();
}

function escapeRegExp(text) {
  return (text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHighlightedMatchHtml(item) {
  const text = getMatchedText(item);
  if (!text) {
    return "";
  }
  return `<span class="claim-operation-hit">${escapeHtml(text)}</span>`;
}

function getLanguageDisplayName(lang) {
  const value = String(lang || "").trim().toLowerCase();
  if (!value || value === "unknown") return "\u672a\u77e5";
  if (value === "zh") return "\u4e2d\u6587";
  if (value === "en") return "\u82f1\u6587";
  return value;
}

function buildOperationArea(item) {
  const percent = getPossibilityPercent(item);
  const matchedHtml = buildHighlightedMatchHtml(item);
  const translatedTag = item?.translationOk ? "\uff08\u7ffb\u8bd1\u540e\uff09" : "";
  const aiExplanation = item?.aiExplanation ? escapeHtml(item.aiExplanation) : "";
  const claimLang = getLanguageDisplayName(item?.claimLanguage);
  const sourceLang = getLanguageDisplayName(item?.sourceLanguage);
  const aiMatchLevel = String(item?.aiMatchLevel || item?.matchLevel || "\u65e0\u6cd5\u5224\u65ad");
  const aiFound = typeof item?.aiExplanationFound === "boolean" ? item.aiExplanationFound : null;
  const aiReason = String(item?.aiExplanationReason || "");
  const aiLocation = String(item?.aiLocation || item?.location || "").trim();
  const rawClaimLang = String(item?.claimLanguage || "").trim().toLowerCase();
  const rawSourceLang = String(item?.sourceLanguage || "").trim().toLowerCase();
  const translationNeeded =
    rawClaimLang &&
    rawSourceLang &&
    rawClaimLang !== "unknown" &&
    rawSourceLang !== "unknown" &&
    rawClaimLang !== rawSourceLang;
  const translationFailedHint =
    translationNeeded && !item?.translationOk
      ? '<div class="claim-operation-text">翻译失败，已回退为原始引文文本</div>'
      : "";
  const explanationHtml = aiExplanation ? `<div class="claim-ai-explanation">AI\u89e3\u91ca\uff1a${aiExplanation}</div>` : "";
  const evidenceTitle =
    aiFound === true
      ? "关键支撑段落："
      : aiFound === false
        ? "不支撑原因："
        : "判断依据：";
  const evidenceText = aiLocation || aiReason || "";
  const evidenceHtml = evidenceText
    ? `<div class="claim-operation-text claim-ai-evidence"><span class="claim-ai-evidence-label">${evidenceTitle}</span>${escapeHtml(evidenceText)}</div>`
    : "";
  return `
  <div class="claim-operation-area">
    <div class="claim-progress-row">
      <span class="claim-progress-label">内容重合度：</span>
      <div class="claim-progress-track">
        <div class="claim-progress-fill" style="width:${percent}%;"></div>
      </div>
      <span class="claim-progress-text">${percent}%</span>
    </div>
    <div class="claim-operation-text">\u5f15\u6587\u8bed\u8a00\uff1a${escapeHtml(claimLang)}</div>
    <div class="claim-operation-text">\u539f\u6587\u8bed\u8a00\uff1a${escapeHtml(sourceLang)}</div>
    <div class="claim-operation-text">\u5339\u914d\u6587\u672c${translatedTag}\uff1a${matchedHtml}</div>
    ${translationFailedHint}
    <div class="claim-operation-text">AI判断结论：${escapeHtml(aiMatchLevel)}</div>
    ${evidenceHtml}
    ${explanationHtml}
  </div>`;
}


function renderStatusProgress() {
  if (!statusArea) return;
  const old = document.getElementById("scan-phase-progress");
  if (old) old.remove();
  const phases = [
    { key: "align", label: "\u5bf9\u9f50\u72b6\u6001" },
    { key: "eval", label: "\u53ef\u4fe1\u8bc4\u4f30" }
  ];
  const rows = phases
    .map(({ key, label }) => {
      const p = scanProgress[key] || { completed: 0, total: 0, running: false };
      const total = Math.max(0, Number(p.total || 0));
      const completed = Math.max(0, Math.min(total || 0, Number(p.completed || 0)));
      const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
      const statusText = p.running ? "\u5904\u7406\u4e2d" : (total > 0 ? "\u5df2\u5b8c\u6210" : "\u672a\u5f00\u59cb");
      return `
        <div class="phase-progress-row">
          <div class="phase-progress-head">
            <span class="phase-progress-label">${label}</span>
            <span class="phase-progress-meta">${statusText} ${completed}/${total}（${percent}%）</span>
          </div>
          <div class="phase-progress-track">
            <div class="phase-progress-fill" style="width:${percent}%;"></div>
          </div>
        </div>`;
    })
    .join("");
  statusArea.insertAdjacentHTML("beforeend", `<div id="scan-phase-progress" class="phase-progress">${rows}</div>`);
}

function renderClaimList(claims, meta = {}) {
  latestClaims = Array.isArray(claims) ? claims : [];
  if (!latestClaims.length) {
    if (meta?.error || meta?.details || meta?.stack) {
      renderErrorBlock("未提取到带链接的引用句", meta);
      return;
    }
    results.innerHTML = '<p class="empty-text">未提取到带链接的引用句。</p>';
    return;
  }

  const rows = latestClaims
    .map((item, index) => {
      const summary = item.claimText || "";
      const refLabel = resolveRefLabel(item);
      const statusLabel = item.checkLabel || "待核查";
      const statusClass = item.checkClass || "status-pending-check";
      const isOpen = index === expandedClaimIndex;
      const isSelected = index === selectedClaimIndex;
      return `<li class="claim-row${isSelected ? " is-selected" : ""}${isOpen ? " is-open" : ""}" data-claim-index="${index}" tabindex="0">
  <div class="claim-main">${escapeHtml(summary)}</div>
  <div class="claim-meta">
    <span class="claim-domain">${escapeHtml(refLabel)}</span>
    <button type="button" class="claim-check-btn ${escapeHtml(statusClass)}" data-action="toggle-check" aria-expanded="${isOpen ? "true" : "false"}">${escapeHtml(statusLabel)}</button>
  </div>
  ${isOpen ? buildOperationArea(item) : ""}
</li>`;
    })
    .join("");

  results.innerHTML = `<ul class="claim-list">${rows}</ul>`;
  if (meta?.details) {
    results.insertAdjacentHTML("beforeend", renderMatchedConversationContent(meta.details));
  }
  attachClaimItemEvents();
}

function updateSingleClaim(index, item) {
  if (!Number.isInteger(index) || index < 0) return;
  if (!latestClaims[index]) return;
  latestClaims[index] = { ...latestClaims[index], ...(item || {}) };
  renderClaimList(latestClaims);
}

async function locateClaimItem(index) {
  const item = latestClaims[index];
  if (!item) return;
  try {
    await chrome.runtime.sendMessage({ type: "LOCATE_CLAIM", claim: item });
  } catch (_error) {
    results.textContent = "定位失败，无法连接到后台服务。";
  }
}

function attachClaimItemEvents() {
  const items = results.querySelectorAll(".claim-row");
  items.forEach((item) => {
    const index = Number(item.getAttribute("data-claim-index"));
    const checkBtn = item.querySelector(".claim-check-btn");
    const activate = async () => {
      selectedClaimIndex = index;
      items.forEach((el) => el.classList.remove("is-selected"));
      item.classList.add("is-selected");
      await locateClaimItem(index);
    };

    item.addEventListener("click", (event) => {
      if (event.target.closest(".claim-check-btn")) return;
      activate();
    });
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });

    checkBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      expandedClaimIndex = expandedClaimIndex === index ? null : index;
      renderClaimList(latestClaims);
    });
  });
}

async function scanClaims() {
  if (isScanning) return;
  isScanning = true;
  setScanButtonBusy(true);
  results.textContent = "正在扫描当前回答...";
  try {
    const response = await chrome.runtime.sendMessage({ type: "SCAN_CLAIMS" });
    if (!response?.ok) {
      isScanning = false;
      setScanButtonBusy(false);
      renderErrorBlock("扫描失败", {
        error: response?.error || "UNKNOWN_ERROR",
        details: response?.details || null
      });
      return;
    }
    const total = Array.isArray(response.claims) ? response.claims.length : 0;
    scanProgress = {
      align: { total, completed: 0, running: total > 0 },
      eval: { total, completed: 0, running: total > 0 }
    };
    renderStatusProgress();
    renderClaimList(response.claims || [], response);
  } catch (_error) {
    isScanning = false;
    setScanButtonBusy(false);
    renderErrorBlock("扫描失败", {
      error: "RUNTIME_EXCEPTION",
      details: {
        message: _error?.message || String(_error || "UNKNOWN_ERROR"),
        stack: _error?.stack || ""
      }
    });
  }
}

scanBtn?.addEventListener("click", async () => {
  await refreshPlatformStatus();
  await scanClaims();
});

setScanButtonBusy(false);
refreshPlatformStatus();
renderStatusProgress();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SCAN_PHASE_PROGRESS") {
    const phase = message.phase === "align" ? "align" : message.phase === "eval" ? "eval" : "";
    if (!phase) return;
    const total = Math.max(0, Number(message.total || 0));
    const completed = Math.max(0, Math.min(total, Number(message.completed || 0)));
    scanProgress[phase] = {
      total,
      completed,
      running: total > 0 && completed < total
    };
    renderStatusProgress();
    return;
  }
  if (message?.type === "SCAN_CLAIM_PROGRESS") {
    updateSingleClaim(Number(message.index), message.item || {});
    return;
  }
  if (message?.type === "SCAN_CLAIMS_DONE" && Array.isArray(message.claims)) {
    isScanning = false;
    setScanButtonBusy(false);
    const total = message.claims.length;
    scanProgress = {
      align: { total, completed: total, running: false },
      eval: {
        total,
        completed: message.claims.filter((x) => Number.isFinite(Number(x?.possibilityScore))).length,
        running: false
      }
    };
    renderStatusProgress();
    renderClaimList(message.claims);
  }
});
