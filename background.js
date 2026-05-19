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
  const aiApiKey = (await chrome.storage.local.get(["openaiApiKey"])).openaiApiKey || "";
  return UrlTextMatchModule.analyzeUrlTextMatch({
    url: payload?.url || "",
    inputText: payload?.inputText || "",
    openAIApiKey: aiApiKey,
    openAIModel: payload?.model || "gpt-4.1-mini"
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
    const evaluatedClaims = await evaluateClaimsByUrl(rawClaims);
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
      claims: evaluatedClaims
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
