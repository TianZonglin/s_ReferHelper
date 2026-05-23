importScripts("url_text_match_module.js");

chrome.runtime.onInstalled.addListener(() => {
  console.log("[ref-check] background installed");
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  }
});

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id ?? null;
}

async function ensureContentScriptsInjected(tabId) {
  if (!tabId) {
    return false;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["config.js", "content.js"]
    });
    return true;
  } catch (_error) {
    return false;
  }
}

async function analyzeUrlTextMatchFromStorage(payload) {
  const storage = await chrome.storage.local.get(["openaiApiKey", "openaiModel", "openaiBaseUrl"]);
  const aiApiKey =
    storage.openaiApiKey ||
    "sk-ant-sid01--3357e5f859e0e9dde27f5228b7eae85d80c9b5875e555ac13acf95a3f54cb254";
  const aiModel = storage.openaiModel || "gpt-5.3-codex";
  const aiBaseUrl = storage.openaiBaseUrl || "https://relay.nf.video/v1";
  return UrlTextMatchModule.analyzeUrlTextMatch({
    url: payload?.url || "",
    inputText: payload?.inputText || "",
    openAIApiKey: aiApiKey,
    openAIModel: payload?.model || aiModel,
    openAIBaseUrl: payload?.baseUrl || aiBaseUrl
  });
}

async function evaluateClaimsByUrl(claims) {
  const evaluated = [];
  for (const item of claims) {
    if (!item?.url) {
      evaluated.push({
        ...item,
        checkClass: "status-pending-check",
        possibilityScore: null,
        checkLabel: "待核查 --",
        possibilityMethod: "token_window_v1",
        sourceFetchOk: false,
        sourceFetchError: "NO_URL",
        sourceLanguage: "unknown",
        claimLanguage: UrlTextMatchModule.detectDominantLanguage(item?.claimText || ""),
        translatedClaimText: item?.claimText || "",
        translationOk: false
      });
      continue;
    }

    const result = await analyzeUrlTextMatchFromStorage({
      url: item.url,
      inputText: item.claimText || ""
    });

    if (!result?.ok) {
      evaluated.push({
        ...item,
        checkClass: "status-pending-check",
        possibilityScore: null,
        checkLabel: "待核查 --",
        possibilityMethod: "token_window_v1",
        sourceFetchOk: false,
        sourceFetchError: (result?.errors && result.errors[0]) || "ANALYZE_FAILED",
        sourceLanguage: result?.intermediate?.sourceLanguage || "unknown",
        claimLanguage: result?.intermediate?.inputLanguage || "unknown",
        translatedClaimText: result?.intermediate?.translatedInputText || item?.claimText || "",
        displayMatchText: result?.intermediate?.translatedInputText || item?.claimText || "",
        translationOk: !!result?.intermediate?.translationApplied
      });
      continue;
    }

    evaluated.push({
      ...item,
      checkClass: "status-pending-check",
      possibilityScore: result.output.matchScore,
      checkLabel: `待核查 ${result.output.matchPercent}%`,
      possibilityMethod: "token_window_v1",
      sourceFetchOk: true,
      sourceFetchError: null,
      sourceLanguage: result.intermediate.sourceLanguage,
      claimLanguage: result.intermediate.inputLanguage,
      translatedClaimText: result.intermediate.translatedInputText,
      displayMatchText: result.intermediate.translatedInputText || item?.claimText || "",
      translationOk: result.intermediate.translationApplied,
      translationTargetLanguage: result.intermediate.sourceLanguage,
      translationError: null,
      aiExplanation: result.output.explanation?.aiExplanation || "",
      aiEvidenceSnippet: result.output.explanation?.evidenceSnippet || "",
      aiExplanationFound: !!result.output.explanation?.found,
      aiExplanationReason: result.output.explanation?.reason || ""
    });
  }
  return evaluated;
}

function buildPendingClaim(item) {
  const claimText = item?.claimText || "";
  return {
    ...item,
    checkClass: "status-pending-check",
    possibilityScore: null,
    checkLabel: "待核查 --",
    possibilityMethod: "token_window_v1",
    sourceFetchOk: false,
    sourceFetchError: null,
    sourceLanguage: "unknown",
    claimLanguage: UrlTextMatchModule.detectDominantLanguage(claimText),
    translatedClaimText: claimText,
    displayMatchText: claimText,
    translationOk: false,
    translationError: null,
    aiExplanation: "",
    aiEvidenceSnippet: "",
    aiExplanationFound: false,
    aiExplanationReason: ""
  };
}

async function evaluateClaimsByUrlAsync(claims, progressCallback) {
  const storage = await chrome.storage.local.get(["openaiApiKey", "openaiModel", "openaiBaseUrl"]);
  const aiApiKey =
    storage.openaiApiKey ||
    "sk-ant-sid01--3357e5f859e0e9dde27f5228b7eae85d80c9b5875e555ac13acf95a3f54cb254";
  const aiModel = storage.openaiModel || "gpt-5.3-codex";
  const aiBaseUrl = storage.openaiBaseUrl || "https://relay.nf.video/v1";

  const working = claims.map((item) => buildPendingClaim(item));
  const total = working.length;

  // 1) fetch source text and language
  const sourceByUrl = new Map();
  for (const item of working) {
    if (!item.url) continue;
    if (sourceByUrl.has(item.url)) continue;
    const fetched = await UrlTextMatchModule.getSourceText(item.url);
    if (!fetched?.ok) {
      sourceByUrl.set(item.url, { ok: false, error: fetched?.error || "SOURCE_FETCH_FAILED", text: "", lang: "unknown" });
      continue;
    }
    const text = fetched.text || "";
    const lang = UrlTextMatchModule.detectDominantLanguage(text);
    sourceByUrl.set(item.url, { ok: true, error: null, text, lang });
  }

  // 2) batch translate by target language
  const needTranslateByLang = new Map();
  for (const item of working) {
    const source = sourceByUrl.get(item.url);
    const sourceLang = source?.ok ? source.lang : "unknown";
    item.sourceLanguage = sourceLang;
    item.claimLanguage = UrlTextMatchModule.detectDominantLanguage(item.claimText || "");
    if (sourceLang !== "unknown" && item.claimLanguage !== "unknown" && item.claimLanguage !== sourceLang) {
      const target = sourceLang === "zh" ? "zh-CN" : sourceLang === "en" ? "en" : "";
      if (target) {
        if (!needTranslateByLang.has(target)) needTranslateByLang.set(target, []);
        needTranslateByLang.get(target).push({ id: item.id, text: item.claimText || "" });
      }
    } else {
      item.translatedClaimText = item.claimText || "";
      item.displayMatchText = item.claimText || "";
      item.translationOk = true;
    }
  }

  const translatedById = new Map();
  let alignCompleted = 0;
  for (const [targetLanguage, arr] of needTranslateByLang.entries()) {
    const ret = await UrlTextMatchModule.translateBatchWithAI({
      apiKey: aiApiKey,
      model: aiModel,
      baseUrl: aiBaseUrl,
      targetLanguage,
      items: arr
    });
    if (!ret.ok) {
      for (const x of arr) {
        translatedById.set(x.id, { ok: false, text: x.text, error: ret.error || "AI_TRANSLATION_FAILED" });
        alignCompleted += 1;
      }
      if (progressCallback) {
        progressCallback({ phase: "align", completed: alignCompleted, total });
      }
      continue;
    }
    const map = new Map(ret.items.map((x) => [x.id, x.translatedText]));
    for (const x of arr) {
      const t = map.get(x.id);
      if (!t) translatedById.set(x.id, { ok: false, text: x.text, error: "AI_BATCH_TRANSLATION_PARSE_FAILED" });
      else translatedById.set(x.id, { ok: true, text: t, error: null });
      alignCompleted += 1;
    }
    if (progressCallback) {
      progressCallback({ phase: "align", completed: alignCompleted, total });
    }
  }
  // claims that don't need translation are considered aligned immediately
  for (const item of working) {
    if (!translatedById.has(item.id)) {
      alignCompleted += 1;
      translatedById.set(item.id, { ok: true, text: item.claimText || "", error: null });
    }
  }
  if (progressCallback) {
    progressCallback({ phase: "align", completed: alignCompleted, total });
  }

  // 3) score and explanation per item (async progress)
  let evalCompleted = 0;
  for (let i = 0; i < working.length; i += 1) {
    const item = working[i];
    const source = sourceByUrl.get(item.url);
    if (!item.url || !source?.ok) {
      item.sourceFetchOk = false;
      item.sourceFetchError = !item.url ? "NO_URL" : (source?.error || "SOURCE_FETCH_FAILED");
      item.checkLabel = "待核查 --";
      evalCompleted += 1;
      if (progressCallback) progressCallback({ phase: "eval", completed: evalCompleted, total, index: i, item });
      continue;
    }

    const trans = translatedById.get(item.id);
    if (trans) {
      item.translationOk = !!trans.ok;
      item.translationError = trans.error || null;
      item.translatedClaimText = trans.text || item.claimText || "";
      item.displayMatchText = item.translatedClaimText;
    } else {
      item.translationOk = true;
      item.translationError = null;
      item.translatedClaimText = item.claimText || "";
      item.displayMatchText = item.claimText || "";
    }

    const analysis = await UrlTextMatchModule.analyzeUrlTextMatch({
      url: item.url,
      inputText: item.claimText || "",
      sourceText: source.text,
      sourceLanguage: source.lang,
      openAIApiKey: aiApiKey,
      openAIModel: aiModel,
      openAIBaseUrl: aiBaseUrl
    });

    if (!analysis?.ok) {
      item.checkLabel = "待核查 --";
      item.possibilityScore = null;
      item.sourceFetchOk = false;
      item.sourceFetchError = (analysis?.errors && analysis.errors[0]) || "ANALYZE_FAILED";
      evalCompleted += 1;
      if (progressCallback) progressCallback({ phase: "eval", completed: evalCompleted, total, index: i, item });
      continue;
    }

    item.possibilityScore = analysis.output.matchScore;
    item.checkLabel = `待核查 ${analysis.output.matchPercent}%`;
    item.sourceFetchOk = true;
    item.sourceFetchError = null;
    item.sourceLanguage = analysis.intermediate.sourceLanguage;
    item.claimLanguage = analysis.intermediate.inputLanguage;
    item.aiExplanation = analysis.output.explanation?.aiExplanation || "";
    item.aiEvidenceSnippet = analysis.output.explanation?.evidenceSnippet || "";
    item.aiExplanationFound = !!analysis.output.explanation?.found;
    item.aiExplanationReason = analysis.output.explanation?.reason || "";
    evalCompleted += 1;
    if (progressCallback) progressCallback({ phase: "eval", completed: evalCompleted, total, index: i, item });
  }

  return working;
}

async function detectPlatformFromActiveTab() {
  const tabId = await getActiveTabId();
  if (!tabId) {
    return { ok: false, error: "NO_ACTIVE_TAB" };
  }

  const injected = await ensureContentScriptsInjected(tabId);
  if (!injected) {
    return { ok: false, error: "INJECT_FAILED" };
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "DETECT_PLATFORM" });
    return { ok: true, data: result };
  } catch (_error) {
    return { ok: false, error: "CONTENT_SCRIPT_UNREACHABLE" };
  }
}

async function scanClaimsFromActiveTab() {
  const tabId = await getActiveTabId();
  if (!tabId) {
    return {
      ok: false,
      error: "NO_ACTIVE_TAB",
      claims: [],
      details: {
        tabId: null,
        parsedTextContent: []
      }
    };
  }

  const injected = await ensureContentScriptsInjected(tabId);
  if (!injected) {
    return {
      ok: false,
      error: "INJECT_FAILED",
      claims: [],
      details: {
        tabId,
        parsedTextContent: []
      }
    };
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_CLAIMS" });
    const rawClaims = Array.isArray(result?.claims) ? result.claims : [];
    const pendingClaims = rawClaims.map((item) => buildPendingClaim(item));

    // asynchronous background evaluation and sidepanel updates
    evaluateClaimsByUrlAsync(rawClaims, ({ phase, completed, total, index, item }) => {
      chrome.runtime.sendMessage({
        type: "SCAN_PHASE_PROGRESS",
        phase,
        completed,
        total
      }).catch(() => {});
      if (phase !== "eval") return;
      chrome.runtime.sendMessage({
        type: "SCAN_CLAIM_PROGRESS",
        index,
        item
      }).catch(() => {});
    }).then((finalClaims) => {
      chrome.runtime.sendMessage({
        type: "SCAN_CLAIMS_DONE",
        claims: finalClaims
      }).catch(() => {});
    }).catch((e) => {
      chrome.runtime.sendMessage({
        type: "SCAN_CLAIMS_DONE",
        error: e?.message || "ASYNC_EVALUATE_FAILED",
        claims: pendingClaims
      }).catch(() => {});
    });

    return {
      ok: !!result?.ok,
      platform: result?.platform || "unknown",
      error: result?.error || null,
      details: {
        claims: rawClaims.map((item) => ({
          claimText: item?.claimText || "",
          url: item?.url || ""
        })),
        matchedConversationContent: result?.matchedConversationContent || { user: [], assistant: [] },
        htmlcontent: result?.htmlcontent || { user: [], assistant: [], cite: [] }
      },
      claims: pendingClaims
    };
  } catch (error) {
    return {
      ok: false,
      error: "CONTENT_SCRIPT_UNREACHABLE",
      claims: [],
      details: {
        tabId,
        parsedTextContent: [],
        message: error?.message || String(error || "UNKNOWN_ERROR"),
        stack: error?.stack || ""
      }
    };
  }
}

async function locateClaimOnActiveTab(claim) {
  const tabId = await getActiveTabId();
  if (!tabId) {
    return { ok: false, error: "NO_ACTIVE_TAB" };
  }

  const injected = await ensureContentScriptsInjected(tabId);
  if (!injected) {
    return { ok: false, error: "INJECT_FAILED" };
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "LOCATE_CLAIM",
      claim
    });
    return result || { ok: false, error: "LOCATE_FAILED" };
  } catch (_error) {
    return { ok: false, error: "CONTENT_SCRIPT_UNREACHABLE" };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ ok: true, source: "background" });
    return true;
  }
  if (message?.type === "ANALYZE_URL_TEXT_MATCH") {
    analyzeUrlTextMatchFromStorage(message.payload || {}).then(sendResponse);
    return true;
  }
  if (message?.type === "GET_PLATFORM_STATUS") {
    detectPlatformFromActiveTab().then(sendResponse);
    return true;
  }
  if (message?.type === "SCAN_CLAIMS") {
    scanClaimsFromActiveTab().then(sendResponse);
    return true;
  }
  if (message?.type === "LOCATE_CLAIM") {
    locateClaimOnActiveTab(message.claim).then(sendResponse);
    return true;
  }
  return false;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.windowId) {
    return;
  }
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (_error) {
    // Ignore; panel behavior is already configured by setPanelBehavior.
  }
});
