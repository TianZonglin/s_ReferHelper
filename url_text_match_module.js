(function initUrlTextMatchModule(globalScope) {
  const MODULE_CACHE_TTL_MS = 10 * 60 * 1000;
  const SOURCE_TEXT_CACHE = new Map();
  const AI_TRANSLATION_CACHE = new Map();
  const DEFAULT_OPENAI_MODEL = "gpt-5.3-codex";
  const DEFAULT_OPENAI_BASE_URL = "https://relay.nf.video/v1";

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function stripHtmlToText(html) {
    const withoutScript = (html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
    return withoutScript
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, "\"")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenize(text) {
    const normalized = normalizeText(text).replace(/[^\p{L}\p{N}\s]/gu, " ");
    return normalized.split(/\s+/).filter(Boolean);
  }

  function detectDominantLanguage(text) {
    const value = (text || "").trim();
    if (!value) {
      return "unknown";
    }
    const hanCount = (value.match(/[\u4e00-\u9fff]/g) || []).length;
    const latinCount = (value.match(/[A-Za-z]/g) || []).length;
    const totalCount = hanCount + latinCount;
    if (totalCount === 0) {
      return "unknown";
    }
    const hanRatio = hanCount / totalCount;
    return hanRatio > 0.15 ? "zh" : "en";
  }

  function toTranslationTargetLanguage(language) {
    if (language === "zh") {
      return "zh-CN";
    }
    if (language === "en") {
      return "en";
    }
    return "";
  }

  function computeWindowContainmentScore(claimText, sourceText) {
    const normalizedClaim = normalizeText(claimText);
    const normalizedSource = normalizeText(sourceText);
    if (!normalizedClaim || !normalizedSource) {
      return 0;
    }
    if (normalizedSource.includes(normalizedClaim)) {
      return 0.99;
    }

    const claimTokens = tokenize(normalizedClaim);
    const sourceTokens = tokenize(normalizedSource);
    if (!claimTokens.length || !sourceTokens.length) {
      return 0;
    }

    const claimSet = new Set(claimTokens);
    const minWindow = Math.max(8, claimTokens.length);
    const maxWindow = Math.min(sourceTokens.length, Math.max(minWindow + 4, claimTokens.length * 2));
    let bestScore = 0;

    for (let windowSize = minWindow; windowSize <= maxWindow; windowSize += 2) {
      for (let i = 0; i + windowSize <= sourceTokens.length; i += 1) {
        const windowSet = new Set(sourceTokens.slice(i, i + windowSize));
        let overlap = 0;
        for (const token of claimSet) {
          if (windowSet.has(token)) {
            overlap += 1;
          }
        }
        const score = overlap / claimSet.size;
        if (score > bestScore) {
          bestScore = score;
        }
        if (bestScore >= 0.99) {
          return bestScore;
        }
      }
    }
    return bestScore;
  }

  function findEvidenceSnippet(sourceText, queryText) {
    const source = sourceText || "";
    const query = queryText || "";
    if (!source || !query) {
      return { snippet: "", start: -1, end: -1 };
    }
    const sourceLower = source.toLowerCase();
    const queryLower = query.toLowerCase();
    const index = sourceLower.indexOf(queryLower);
    if (index >= 0) {
      const snippetStart = Math.max(0, index - 80);
      const snippetEnd = Math.min(source.length, index + query.length + 80);
      return {
        snippet: source.slice(snippetStart, snippetEnd),
        start: index,
        end: index + query.length
      };
    }

    // fallback: use a short head sample when no direct substring found
    return {
      snippet: source.slice(0, 220),
      start: -1,
      end: -1
    };
  }

  async function fetchTextWithTimeout(url, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow"
      });
      if (!response.ok) {
        return { ok: false, error: `HTTP_${response.status}`, text: "" };
      }
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      const raw = await response.text();
      const text = contentType.includes("text/html") ? stripHtmlToText(raw) : (raw || "").trim();
      if (!text) {
        return { ok: false, error: "EMPTY_SOURCE_TEXT", text: "" };
      }
      return { ok: true, error: null, text };
    } catch (_error) {
      return { ok: false, error: "FETCH_FAILED", text: "" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getSourceText(url) {
    if (!url) {
      return { ok: false, error: "EMPTY_URL", text: "" };
    }
    const cached = SOURCE_TEXT_CACHE.get(url);
    if (cached && Date.now() - cached.savedAt <= MODULE_CACHE_TTL_MS) {
      return { ok: true, error: null, text: cached.text };
    }
    const fetched = await fetchTextWithTimeout(url);
    if (fetched.ok) {
      SOURCE_TEXT_CACHE.set(url, {
        text: fetched.text,
        savedAt: Date.now()
      });
    }
    return fetched;
  }

  function extractResponseOutputText(payload) {
    if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
      return payload.output_text.trim();
    }
    const chunks = [];
    for (const out of payload?.output || []) {
      for (const c of out?.content || []) {
        if (typeof c?.text === "string" && c.text.trim()) {
          chunks.push(c.text.trim());
        }
      }
    }
    return chunks.join("\n").trim();
  }

  function buildResponsesApiUrl(baseUrl) {
    const root = (baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    return `${root}/responses`;
  }

  async function callOpenAIText({
    apiKey,
    model,
    prompt,
    temperature = 0.1,
    baseUrl = DEFAULT_OPENAI_BASE_URL,
    systemPrompt = ""
  }) {
    if (!apiKey) {
      return { ok: false, error: "AI_API_KEY_MISSING", text: "" };
    }
    try {
      const response = await fetch(buildResponsesApiUrl(baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model || DEFAULT_OPENAI_MODEL,
          input: systemPrompt
            ? [
                { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
                { role: "user", content: [{ type: "input_text", text: prompt }] }
              ]
            : prompt,
          temperature
        })
      });
      if (!response.ok) {
        return { ok: false, error: `AI_HTTP_${response.status}`, text: "" };
      }
      const payload = await response.json();
      const text = extractResponseOutputText(payload);
      if (!text) {
        return { ok: false, error: "AI_EMPTY_OUTPUT", text: "" };
      }
      return { ok: true, error: null, text };
    } catch (_error) {
      return { ok: false, error: "AI_REQUEST_FAILED", text: "" };
    }
  }

  async function translateWithAI({ apiKey, model, text, targetLanguage, baseUrl = DEFAULT_OPENAI_BASE_URL }) {
    const value = (text || "").trim();
    if (!value) {
      return { ok: false, error: "EMPTY_TEXT", text: "" };
    }
    const key = `${targetLanguage}::${value}`;
    const cached = AI_TRANSLATION_CACHE.get(key);
    if (cached && Date.now() - cached.savedAt <= MODULE_CACHE_TTL_MS) {
      return { ok: true, error: null, text: cached.text };
    }

    const prompt = [
      "You are a translation engine.",
      `Translate the following text to ${targetLanguage}.`,
      "Only return the translated text, no extra explanation.",
      "",
      value
    ].join("\n");
    const translated = await callOpenAIText({ apiKey, model, prompt, temperature: 0, baseUrl });
    if (!translated.ok) {
      return translated;
    }
    AI_TRANSLATION_CACHE.set(key, {
      text: translated.text,
      savedAt: Date.now()
    });
    return translated;
  }

  async function translateBatchWithAI({
    apiKey,
    model,
    targetLanguage,
    items,
    baseUrl = DEFAULT_OPENAI_BASE_URL
  }) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      return { ok: true, error: null, items: [] };
    }
    const payload = list.map((item) => ({
      id: String(item?.id || ""),
      text: String(item?.text || "")
    }));
    const systemPrompt = [
      "You are a translation engine.",
      "You must return valid JSON only.",
      "Output schema must be exactly: {\"translations\":[{\"id\":\"string\",\"translatedText\":\"string\"}]}.",
      "Do not include markdown, comments, or extra keys.",
      `Translate all text into ${targetLanguage}.`
    ].join(" ");
    const prompt = JSON.stringify({ translations: payload });
    const result = await callOpenAIText({
      apiKey,
      model,
      prompt,
      temperature: 0,
      baseUrl,
      systemPrompt
    });
    if (!result.ok) {
      return { ok: false, error: result.error || "AI_TRANSLATION_FAILED", items: [] };
    }
    const parsed = safeParseJson(result.text);
    const out = Array.isArray(parsed?.translations) ? parsed.translations : [];
    if (!out.length) {
      return { ok: false, error: "AI_BATCH_TRANSLATION_PARSE_FAILED", items: [] };
    }
    return {
      ok: true,
      error: null,
      items: out.map((x) => ({
        id: String(x?.id || ""),
        translatedText: String(x?.translatedText || "")
      }))
    };
  }

  function safeParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  async function explainWithAI({
    apiKey,
    model,
    sourceLanguage,
    sourceText,
    translatedInputText,
    baseUrl = DEFAULT_OPENAI_BASE_URL
  }) {
    const maxSourceChars = 30000;
    const trimmedSourceText = String(sourceText || "").slice(0, maxSourceChars);
    const prompt = JSON.stringify({
      sourceLanguage,
      claimText: translatedInputText,
      sourceText: trimmedSourceText,
      note: "Judge whether sourceText contains content that directly supports claimText. If yes, return the key supporting segment from sourceText; if no, explain why."
    });
    const systemPrompt = [
      "You are a precise fact-checking assistant.",
      "Return valid JSON only.",
      "Schema:",
      "{\"found\":boolean,\"location\":\"string\",\"reason\":\"string\",\"aiExplanation\":\"string\",\"matchLevel\":\"string\"}.",
      "Rules:",
      "1) Decide from sourceText content only, do not use external knowledge.",
      "2) The task is not literal substring matching. Judge semantic involvement and direct support.",
      "3) If found=true, location must be the key source segment that directly supports claimText, preferably a short verbatim quote from sourceText.",
      "4) If found=false, location must be empty string and reason must explain why sourceText does not directly support claimText.",
      "5) aiExplanation must be concise Chinese.",
      "6) matchLevel must be exactly one of:",
      "完全符合, 非常符合, 基本符合, 无法判断, 基本不符合, 非常不符合, 完全不符合."
    ].join(" ");
    const result = await callOpenAIText({
      apiKey,
      model,
      prompt,
      temperature: 0.1,
      baseUrl,
      systemPrompt
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        data: {
          found: false,
          location: "",
          reason: "AI_REQUEST_FAILED",
          aiExplanation: "AI 解释生成失败，已回退到规则判定。",
          matchLevel: "无法判断"
        }
      };
    }

    const data = safeParseJson(result.text);
    if (!data || typeof data.found !== "boolean") {
      return {
        ok: false,
        error: "AI_EXPLANATION_PARSE_FAILED",
        data: {
          found: false,
          location: "",
          reason: "AI_EXPLANATION_PARSE_FAILED",
          aiExplanation: "AI 输出解析失败，已回退到规则判定。",
          matchLevel: "无法判断"
        }
      };
    }
    return {
      ok: true,
      error: null,
      data: {
        found: !!data.found,
        location: String(data.location || ""),
        reason: String(data.reason || ""),
        aiExplanation: String(data.aiExplanation || ""),
        matchLevel: String(data.matchLevel || "无法判断")
      }
    };
  }

  async function analyzeUrlTextMatch({
    url,
    inputText,
    sourceText = "",
    sourceLanguage = "unknown",
    openAIApiKey = "",
    openAIModel = DEFAULT_OPENAI_MODEL,
    openAIBaseUrl = DEFAULT_OPENAI_BASE_URL
  }) {
    const errors = [];
    const valueUrl = (url || "").trim();
    const valueInput = (inputText || "").trim();
    if (!valueUrl || !valueInput) {
      return {
        ok: false,
        errors: ["INVALID_INPUT"],
        input: { url: valueUrl, inputText: valueInput }
      };
    }

    let finalSourceText = (sourceText || "").trim();
    let sourceFetchError = null;
    if (!finalSourceText) {
      const fetched = await getSourceText(valueUrl);
      if (!fetched.ok) {
        return {
          ok: false,
          errors: [fetched.error || "SOURCE_FETCH_FAILED"],
          input: { url: valueUrl, inputText: valueInput }
        };
      }
      finalSourceText = fetched.text;
      sourceFetchError = fetched.error;
    }

    const finalSourceLanguage =
      sourceLanguage && sourceLanguage !== "unknown"
        ? sourceLanguage
        : detectDominantLanguage(finalSourceText);
    const inputLanguage = detectDominantLanguage(valueInput);
    const targetLanguage = toTranslationTargetLanguage(finalSourceLanguage);

    let translatedInputText = valueInput;
    let translationApplied = false;
    let translationOk = true;
    let translationError = null;

    if (
      targetLanguage &&
      inputLanguage !== "unknown" &&
      finalSourceLanguage !== "unknown" &&
      inputLanguage !== finalSourceLanguage
    ) {
      const translated = await translateWithAI({
        apiKey: openAIApiKey,
        model: openAIModel,
        text: valueInput,
        targetLanguage,
        baseUrl: openAIBaseUrl
      });
      if (!translated.ok) {
        translationOk = false;
        translationError = translated.error || "AI_TRANSLATION_FAILED";
        errors.push(translationError);
      } else {
        translatedInputText = translated.text;
        translationApplied = true;
      }
    }

    const score = computeWindowContainmentScore(translatedInputText, finalSourceText);
    const matchPercent = Math.round(score * 100);
    const normalizedSource = normalizeText(finalSourceText);
    const normalizedTranslated = normalizeText(translatedInputText);
    const fullMatch =
      normalizedSource && normalizedTranslated
        ? normalizedSource.includes(normalizedTranslated)
        : false;
    const foundByRule = fullMatch || score >= 0.6;
    const evidence = findEvidenceSnippet(finalSourceText, translatedInputText);

    const aiExplanationResult = await explainWithAI({
      apiKey: openAIApiKey,
      model: openAIModel,
      sourceLanguage: finalSourceLanguage,
      sourceText: finalSourceText,
      translatedInputText,
      baseUrl: openAIBaseUrl
    });
    if (!aiExplanationResult.ok && aiExplanationResult.error) {
      errors.push(aiExplanationResult.error);
    }

    const ruleReason =
      fullMatch
        ? "FULL_SUBSTRING_MATCH"
        : score >= 0.6
          ? "HIGH_TOKEN_OVERLAP"
          : "LOW_OVERLAP";

    const explanationData = aiExplanationResult.data || {
      found: foundByRule,
      location: evidence.snippet ? "rule-snippet" : "",
      reason: ruleReason,
      aiExplanation: "未生成 AI 解释。",
      matchLevel: "无法判断"
    };

    return {
      ok: true,
      input: {
        url: valueUrl,
        inputText: valueInput
      },
      intermediate: {
        sourceText: finalSourceText,
        sourceLanguage: finalSourceLanguage,
        inputLanguage,
        translatedInputText,
        translationApplied
      },
      output: {
        matchScore: score,
        matchPercent,
        explanation: {
          found: typeof explanationData.found === "boolean" ? explanationData.found : foundByRule,
          reason: explanationData.reason || ruleReason,
          location: explanationData.location || "",
          matchLevel: explanationData.matchLevel || "无法判断",
          evidenceSnippet: evidence.snippet,
          evidenceStart: evidence.start,
          evidenceEnd: evidence.end,
          aiExplanation: explanationData.aiExplanation || ""
        }
      },
      diagnostics: {
        sourceFetchError,
        translationOk,
        translationError
      },
      errors
    };
  }

  globalScope.UrlTextMatchModule = {
    analyzeUrlTextMatch,
    translateBatchWithAI,
    getSourceText,
    detectDominantLanguage,
    normalizeText,
    computeWindowContainmentScore
  };
})(self);
