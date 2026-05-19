console.log("[ref-check] content script loaded");
if (window.__REF_CHECK_CONTENT_READY__) {
  console.log("[ref-check] content script already initialized");
} else {
  window.__REF_CHECK_CONTENT_READY__ = true;

function getPlatformConfigMap() {
  return window.__REF_CHECK_CONFIG__ || {};
}

function getMatchedPlatformConfig() {
  const configMap = getPlatformConfigMap();
  const currentUrl = window.location.href;
  const candidates = Object.values(configMap);
  for (const item of candidates) {
    const prefixes = Array.isArray(item?.domainPrefixes) ? item.domainPrefixes : [];
    if (prefixes.some((prefix) => currentUrl.startsWith(prefix))) {
      return item;
    }
  }
  return null;
}

function normalizeCssSelector(selector) {
  const value = normalizeWhitespace(selector || "");
  if (!value) {
    return "";
  }
  return value.startsWith(".") ? value : `.${value}`;
}

function findConversationNodesByConfig(platformConfig) {
  if (!platformConfig) {
    return {
      questionNodes: [],
      answerNodes: []
    };
  }
  const questionSelector = normalizeCssSelector(platformConfig.questionClass);
  const answerSelector = normalizeCssSelector(platformConfig.answerClass);
  return {
    questionNodes: Array.from(document.querySelectorAll(questionSelector)),
    answerNodes: Array.from(document.querySelectorAll(answerSelector))
  };
}

function isNodeVisible(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  if (node.getAttribute("aria-hidden") === "true") {
    return false;
  }
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isExcludedNode(node, platformConfig) {
  const className = normalizeWhitespace(platformConfig?.excludeClass || "");
  if (!className || !node || !node.closest) {
    return false;
  }
  const classTokens = className.split(/\s+/).filter(Boolean);
  for (const token of classTokens) {
    if (node.closest(`.${token}`)) {
      return true;
    }
  }
  return false;
}

function pickTargetAnswerNodes(answerNodes, platformConfig) {
  const filtered = answerNodes.filter(
    (node) => !isExcludedNode(node, platformConfig) && isNodeVisible(node)
  );
  if (!filtered.length) {
    return [];
  }
  if (platformConfig?.scanLatestAnswerOnly) {
    return [filtered[filtered.length - 1]];
  }
  return filtered;
}

function toCssPath(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  const parts = [];
  let current = node;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      part += `#${CSS.escape(current.id)}`;
      parts.unshift(part);
      break;
    }
    const parent = current.parentElement;
    if (!parent) {
      break;
    }
    const sameTagSiblings = Array.from(parent.children).filter(
      (child) => child.tagName === current.tagName
    );
    if (sameTagSiblings.length > 1) {
      const index = sameTagSiblings.indexOf(current) + 1;
      part += `:nth-of-type(${index})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(" > ");
}

function normalizeWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function collectDeepMatches(root, selector) {
  if (!root || !selector) {
    return [];
  }
  const results = [];
  const seen = new Set();

  function visit(node) {
    if (!node) {
      return;
    }
    if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of Array.from(node.children || [])) {
        visit(child);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const element = node;
    if (element.matches?.(selector) && !seen.has(element)) {
      seen.add(element);
      results.push(element);
    }
    if (element.shadowRoot) {
      visit(element.shadowRoot);
    }
    for (const child of Array.from(element.children || [])) {
      visit(child);
    }
  }

  visit(root);
  return results;
}

function collectDeepElements(root) {
  return collectDeepMatches(root, "*");
}

function extractNodeText(node, maxLen = 500) {
  const text = normalizeWhitespace(node?.innerText || node?.textContent || "");
  if (!text) {
    return "";
  }
  return maxLen > 0 ? text.slice(0, maxLen) : text;
}

function collectMatchedNodeTexts(nodes, maxItems = 20, maxLen = 500) {
  return Array.from(nodes || [])
    .map((node) => extractNodeText(node, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function collectPlatformMatchedTexts(selector, maxItems = 20, maxLen = 500) {
  const normalizedSelector = normalizeCssSelector(selector);
  if (!normalizedSelector) {
    return [];
  }
  const nodes = Array.from(document.querySelectorAll(normalizedSelector));
  return collectMatchedNodeTexts(nodes, maxItems, maxLen);
}

function collectPlatformMatchedHtml(selector, maxItems = 20, maxLen = 2000) {
  const normalizedSelector = normalizeCssSelector(selector);
  if (!normalizedSelector) {
    return [];
  }
  return Array.from(document.querySelectorAll(normalizedSelector))
    .map((node) => ({
      text: extractNodeText(node, 500),
      html: normalizeWhitespace((node?.outerHTML || "").slice(0, maxLen))
    }))
    .filter((item) => item.text || item.html)
    .slice(0, maxItems);
}

function splitIntoSentences(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }
  const chunks = normalized
    .split(/(?<=[。！？!?\.])\s+|(?<=[。！？!?])/)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean);
  return chunks.length ? chunks : [normalized];
}

function getClaimSentence(anchor, container) {
  const block = anchor.closest("p, li, blockquote, div, section, article") || anchor.parentElement || container;
  const blockText = normalizeWhitespace(block?.innerText || "");
  const anchorText = normalizeWhitespace(anchor.innerText || anchor.textContent || "");
  if (!blockText || !anchorText) {
    return { claimText: "", context: "" };
  }

  const sentences = splitIntoSentences(blockText);
  const targetSentence = sentences.find((sentence) => sentence.includes(anchorText)) || blockText;

  const idx = blockText.indexOf(targetSentence);
  let context = targetSentence;
  if (idx >= 0) {
    const start = Math.max(0, idx - 50);
    const end = Math.min(blockText.length, idx + targetSentence.length + 50);
    context = blockText.slice(start, end);
  }

  return {
    claimText: normalizeWhitespace(targetSentence),
    context: normalizeWhitespace(context)
  };
}

function getNearestClaimBeforeRef(refNode, container, platformConfig) {
  const localBlock =
    refNode.closest("td, li, p, blockquote, section, article, div") || refNode.parentElement || container;
  const localText = getTextBeforeNodeInParent(refNode, localBlock, platformConfig);
  const localResult = buildClaimFromText(localText);
  return localResult;
}

function getTextBeforeNodeInParent(targetNode, parentNode, platformConfig) {
  if (!targetNode || !parentNode || !parentNode.childNodes) {
    return "";
  }
  const texts = [];
  for (const node of parentNode.childNodes) {
    if (node === targetNode) {
      break;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      texts.push(node.textContent || "");
      continue;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node;
      if (isExcludedNode(element, platformConfig)) {
        continue;
      }
      const refSelector = normalizeWhitespace(platformConfig?.refSelector || "");
      if (refSelector && element.matches(refSelector)) {
        continue;
      }
      texts.push(element.innerText || element.textContent || "");
    }
  }
  return normalizeWhitespace(texts.join(" "));
}

function buildClaimFromText(rawText) {
  const beforeText = normalizeWhitespace(rawText);
  if (!beforeText) {
    return { claimText: "", context: "" };
  }
  const sentences = splitIntoSentences(beforeText);
  let claimText = normalizeWhitespace(sentences[sentences.length - 1] || beforeText);
  claimText = claimText
    .replace(/\[[^\]]+\]\s*$/g, "")
    .replace(/\([^)]+\)\s*$/g, "")
    .trim();
  const contextStart = Math.max(0, beforeText.length - 120);
  const context = normalizeWhitespace(beforeText.slice(contextStart));
  return { claimText, context };
}

function buildClaimFromBlockText(blockText, anchorText) {
  const normalizedBlockText = normalizeWhitespace(blockText);
  if (!normalizedBlockText) {
    return { claimText: "", context: "" };
  }

  const sentences = splitIntoSentences(normalizedBlockText);
  const anchor = normalizeWhitespace(anchorText);
  const matchedSentence = anchor
    ? sentences.find((sentence) => sentence.includes(anchor))
    : "";
  const claimText = normalizeWhitespace(matchedSentence || normalizedBlockText);
  const context = normalizedBlockText;
  return { claimText, context };
}

function isValidHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function resolveHttpUrlFromNode(node, scopeRoot) {
  const directLink = node?.closest?.("a[href]");
  const directHref = directLink?.getAttribute("href") || "";
  if (isValidHttpUrl(directHref)) {
    return new URL(directHref, window.location.href).toString();
  }

  const localBlock =
    node?.closest?.("td, li, p, blockquote, section, article, div") || scopeRoot || null;
  const roots = [localBlock, scopeRoot].filter(Boolean);
  for (const root of roots) {
    const anchors = Array.from(root.querySelectorAll("a[href]")).filter(
      (anchor) => isNodeVisible(anchor)
    );
    for (const anchor of anchors) {
      const rawUrl = anchor.getAttribute("href") || "";
      if (isValidHttpUrl(rawUrl)) {
        return new URL(rawUrl, window.location.href).toString();
      }
    }
  }

  return "";
}

function extractHttpUrlFromText(text) {
  const rawText = normalizeWhitespace(text);
  if (!rawText) {
    return "";
  }
  const match = rawText.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) {
    return "";
  }
  return isValidHttpUrl(match[0]) ? new URL(match[0], window.location.href).toString() : "";
}

function getKimiCiteUrl(node) {
  if (!node) {
    return "";
  }
  const linkNode = node.querySelector?.("a[href]");
  const rawHref = linkNode?.getAttribute("href") || "";
  if (isValidHttpUrl(rawHref)) {
    return new URL(rawHref, window.location.href).toString();
  }
  return "";
}

function getTextBeforeNodeInParagraph(paragraphNode, targetNode) {
  if (!paragraphNode || !targetNode) {
    return "";
  }
  const walker = document.createTreeWalker(
    paragraphNode,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
  );
  const texts = [];
  let current = walker.nextNode();
  while (current) {
    if (current === targetNode || (current.nodeType === Node.ELEMENT_NODE && current.contains?.(targetNode))) {
      break;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      texts.push(current.textContent || "");
    }
    current = walker.nextNode();
  }
  return normalizeWhitespace(texts.join(" "));
}

function getKimiClaimTextFromCite(node) {
  if (!node) {
    return { claimText: "", context: "" };
  }

  const citeParagraph = node.closest?.(".paragraph") || null;
  const paragraphText = getTextBeforeNodeInParagraph(citeParagraph, node);
  return {
    claimText: paragraphText,
    context: paragraphText
  };
}

function buildDomLocation(anchor) {
  const parent = anchor.parentElement || anchor;
  const textNodeIndex = Array.from(parent.childNodes).findIndex((node) => node === anchor);
  return {
    cssPath: toCssPath(parent),
    textNodeIndex: textNodeIndex >= 0 ? textNodeIndex : 0,
    startOffset: 0,
    endOffset: normalizeWhitespace(anchor.textContent || "").length
  };
}

function buildElementLocation(element) {
  return {
    cssPath: toCssPath(element),
    textNodeIndex: 0,
    startOffset: 0,
    endOffset: normalizeWhitespace(element?.textContent || "").length
  };
}

function highlightAndScrollToElement(element) {
  if (!element) {
    return false;
  }

  element.scrollIntoView({ behavior: "smooth", block: "center" });
  const previousOutline = element.style.outline;
  const previousTransition = element.style.transition;
  element.style.transition = "outline 0.2s ease";
  element.style.outline = "3px solid #f59e0b";
  window.setTimeout(() => {
    element.style.outline = previousOutline;
    element.style.transition = previousTransition;
  }, 2000);
  return true;
}

function resolveElementByCssPath(cssPath) {
  if (!cssPath) {
    return null;
  }
  try {
    return document.querySelector(cssPath);
  } catch (_error) {
    return null;
  }
}

function locateClaimInKimi(claim) {
  const cssPath = claim?.domLocation?.cssPath || "";
  const target = resolveElementByCssPath(cssPath);
  if (!target) {
    return { ok: false, error: "TARGET_NOT_FOUND" };
  }
  highlightAndScrollToElement(target);
  return { ok: true };
}

function extractClaimsByConfig(platformConfig) {
  const { questionNodes, answerNodes } = findConversationNodesByConfig(platformConfig);
  const claims = [];
  const claimKeySet = new Set();
  let claimIndex = 0;
  const diagnostics = {
    platform: platformConfig?.platform || "unknown",
    questionNodeCount: questionNodes.length,
    answerNodeCount: answerNodes.length,
    targetAnswerNodeCount: 0,
    kimiAnswerChecks: []
  };

  function pushClaim(candidate) {
    const claimText = normalizeWhitespace(candidate?.claimText || "");
    const url = normalizeWhitespace(candidate?.url || "");
    if (!claimText || !url) {
      return;
    }
    const key = `${claimText}||${url}`;
    if (claimKeySet.has(key)) {
      return;
    }
    claimKeySet.add(key);
    claimIndex += 1;
    claims.push({
      id: `claim_${claimIndex}`,
      claimText,
      anchorText: normalizeWhitespace(candidate?.anchorText || ""),
      refText: normalizeWhitespace(candidate?.refText || ""),
      refTexts: Array.isArray(candidate?.refTexts) ? candidate.refTexts : [],
      url,
      urls: [url],
      domLocation: candidate?.domLocation || { cssPath: "", textNodeIndex: 0, startOffset: 0, endOffset: 0 },
      context: normalizeWhitespace(candidate?.context || "")
    });
  }

  if (platformConfig.platform === "kimi") {
    const citeNodes = Array.from(document.querySelectorAll(".paragraph .pua-ref-renderer--cite")).filter(
      (node) => !isExcludedNode(node, platformConfig)
    );
    diagnostics.targetAnswerNodeCount = citeNodes.length;

    for (const node of citeNodes) {
      const url = getKimiCiteUrl(node);
      if (!url) {
        continue;
      }

      const { claimText, context } = getKimiClaimTextFromCite(node, null, platformConfig);
      if (!claimText) {
        continue;
      }

      const paragraphNode = node.closest(".paragraph");
      pushClaim({
        claimText,
        anchorText: normalizeWhitespace(node.innerText || node.textContent || ""),
        refText: normalizeWhitespace(node.innerText || node.textContent || ""),
        refTexts: [normalizeWhitespace(node.innerText || node.textContent || "")].filter(Boolean),
        url,
        domLocation: buildElementLocation(paragraphNode || node),
        context
      });
    }

    return {
      claims,
      matchedConversationContent: {
        user: collectPlatformMatchedTexts(platformConfig.questionClass),
        assistant: collectPlatformMatchedTexts(platformConfig.answerClass)
      },
      htmlcontent: {
        user: collectPlatformMatchedHtml(platformConfig.questionClass),
        assistant: collectPlatformMatchedHtml(platformConfig.answerClass),
        cite: citeNodes.map((node) => ({
          text: extractNodeText(node, 500),
          html: normalizeWhitespace((node?.outerHTML || "").slice(0, 2000))
        }))
      },
      diagnostics
    };
  }

  const targetAnswerNodes = pickTargetAnswerNodes(answerNodes, platformConfig);
  if (!targetAnswerNodes.length) {
    return {
      claims: [],
      matchedConversationContent: {
        user: collectPlatformMatchedTexts(platformConfig.questionClass),
        assistant: collectPlatformMatchedTexts(platformConfig.answerClass)
      },
      htmlcontent: {
        user: collectPlatformMatchedHtml(platformConfig.questionClass),
        assistant: collectPlatformMatchedHtml(platformConfig.answerClass),
        cite: []
      },
      diagnostics
    };
  }

  for (const answerNode of targetAnswerNodes) {
    if (isExcludedNode(answerNode, platformConfig)) {
      continue;
    }

    const refSelector = normalizeWhitespace(platformConfig.refSelector || "");
    const refSelectors = [
      refSelector,
      "[data-site-name]",
      "a[href]",
      ".rag-tag"
    ].filter(Boolean);
    const refNodeSet = new Set();
    for (const selector of refSelectors) {
      for (const node of Array.from(answerNode.querySelectorAll(selector))) {
        if (!isExcludedNode(node, platformConfig)) {
          refNodeSet.add(node);
        }
      }
    }
    const filteredRefNodes = Array.from(refNodeSet).filter((node) => isNodeVisible(node));

    for (const node of filteredRefNodes) {
      if (isExcludedNode(node, platformConfig)) {
        continue;
      }
      const refText = normalizeWhitespace(
        node.getAttribute(platformConfig.refTextAttr || "") || node.textContent || ""
      );
      if (!refText) {
        continue;
      }
      const { claimText, context } = getNearestClaimBeforeRef(node, answerNode, platformConfig);
      const blockFallback = buildClaimFromBlockText(node.closest("p, li, blockquote, div, section, article")?.innerText || "", refText);
      const finalClaimText = claimText || blockFallback.claimText;
      const finalContext = context || blockFallback.context;
      if (!finalClaimText) {
        continue;
      }
      const url = resolveHttpUrlFromNode(node, answerNode);
      pushClaim({
        claimText: finalClaimText,
        anchorText: refText,
        refText,
        refTexts: refText ? [refText] : [],
        url,
        domLocation: buildDomLocation(node),
        context: finalContext
      });
    }

    const anchors = Array.from(answerNode.querySelectorAll("a[href]")).filter(
      (node) => !isExcludedNode(node, platformConfig) && isNodeVisible(node)
    );
    for (const anchor of anchors) {
      const rawUrl = anchor.getAttribute("href") || "";
      if (!isValidHttpUrl(rawUrl)) {
        continue;
      }
      const url = new URL(rawUrl, window.location.href).toString();
      const anchorText = normalizeWhitespace(anchor.innerText || anchor.textContent || "");
      const { claimText, context } = getClaimSentence(anchor, answerNode);
      if (!anchorText || !claimText) {
        continue;
      }
      pushClaim({
        claimText,
        anchorText,
        refText: "",
        refTexts: [],
        url,
        domLocation: buildDomLocation(anchor),
        context
      });
    }
  }

  return {
    claims,
    matchedConversationContent: {
      user: collectPlatformMatchedTexts(platformConfig.questionClass),
      assistant: collectPlatformMatchedTexts(platformConfig.answerClass)
    },
    htmlcontent: {
      user: collectPlatformMatchedHtml(platformConfig.questionClass),
      assistant: collectPlatformMatchedHtml(platformConfig.answerClass),
      cite: []
    },
    diagnostics
  };
}

function detectCurrentPageStatus() {
  const platformConfig = getMatchedPlatformConfig();
  if (!platformConfig) {
    return {
      platform: "unsupported",
      supportStatus: "none",
      questionContainerFound: false,
      answerContainerFound: false,
      matchedSelector: null,
      domainMatched: false,
      questionClass: null,
      answerClass: null
    };
  }

  const { questionNodes, answerNodes } = findConversationNodesByConfig(platformConfig);
  return {
    platform: platformConfig.platform,
    supportStatus: platformConfig.supportStatus,
    questionContainerFound: questionNodes.length > 0,
    answerContainerFound: answerNodes.length > 0,
    matchedSelector: normalizeCssSelector(platformConfig.answerClass),
    domainMatched: true,
    questionClass: platformConfig.questionClass,
    answerClass: platformConfig.answerClass,
    refSelector: platformConfig.refSelector || null,
    refTextAttr: platformConfig.refTextAttr || null,
    excludeClass: platformConfig.excludeClass || null,
    scanLatestAnswerOnly: !!platformConfig.scanLatestAnswerOnly
  };
}

function canExtractClaims(status) {
  return status.platform === "kimi" && status.answerContainerFound;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DETECT_PLATFORM") {
    sendResponse(detectCurrentPageStatus());
    return true;
  }
  if (message?.type === "LOCATE_CLAIM") {
    const status = detectCurrentPageStatus();
    if (!canExtractClaims(status) || !getMatchedPlatformConfig()) {
      sendResponse({ ok: false, error: "UNSUPPORTED_OR_CONTAINER_MISSING" });
      return true;
    }
    sendResponse(locateClaimInKimi(message.claim));
    return true;
  }
  if (message?.type === "EXTRACT_CLAIMS") {
    const status = detectCurrentPageStatus();
    const platformConfig = getMatchedPlatformConfig();
    if (!canExtractClaims(status) || !platformConfig) {
      sendResponse({
        ok: false,
        error: "UNSUPPORTED_OR_CONTAINER_MISSING",
        claims: [],
        status
      });
      return true;
    }

    const extraction = extractClaimsByConfig(platformConfig);
    const claims = extraction?.claims || [];
    const diagnostics = extraction?.diagnostics || null;
    sendResponse({
      ok: true,
      platform: "kimi",
      claims,
      status,
      diagnostics
    });
    return true;
  }
  return false;
});
}
