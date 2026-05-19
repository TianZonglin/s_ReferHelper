/* global window */
(function initRefCheckConfig(global) {
  const PLATFORM_CONFIG = {
    kimi: {
      platform: "kimi",
      domainPrefixes: [
        "https://www.kimi.com/chat",
        "https://kimi.com/chat",
        "https://kimi.moonshot.cn/chat"
      ],
      questionClass: ".chat-content-item-user",
      answerClass: ".chat-content-item-assistant",
      refSelector: ".pua-ref-renderer--cite",
      refTextAttr: null,
      excludeClass: "toolcall-container",
      scanLatestAnswerOnly: true,
      supportStatus: "ready"
    },
    doubao: {
      platform: "doubao",
      domainPrefixes: [
        "https://www.doubao.com/chat",
        "https://doubao.com/chat"
      ],
      questionClass: ".chat-content-item-user",
      answerClass: ".chat-content-item-assistant",
      refSelector: ".rag-tag.text",
      refTextAttr: "data-site-name",
      excludeClass: "toolcall-container",
      scanLatestAnswerOnly: true,
      supportStatus: "pending"
    }
  };

  global.__REF_CHECK_CONFIG__ = PLATFORM_CONFIG;
})(window);
