(() => {
  const RECORD_KEY = "bossV2Records";
  const LOG_KEY = "bossV2Logs";
  const RUN_KEY = "bossV2Run";

  const APPLY_TEXTS = [
    "与BOSS随时沟通",
    "立即沟通",
    "BOSS随时沟通",
    "在线沟通",
    "马上沟通",
    "继续沟通",
    "聊一聊",
    "开聊",
    "投递简历",
    "立即投递",
    "申请职位",
    "投递"
  ];
  const SEND_TEXTS = ["发送", "确定", "确认", "开始沟通", "发送简历", "继续沟通"];
  const BAD_BUTTON_TEXT = /(去\s*App|下载\s*App|打开\s*App|收藏|举报|分享|反馈|换一个|查看更多)/i;
  const DONE_TEXT = /(已沟通|已投递|不合适|已关闭|停止招聘|暂停招聘)/;
  const BLOCK_TEXT = /(验证码|安全验证|请登录|登录后|扫码登录|账号登录|拖动滑块)/;
  const SALARY_PATTERN = /(薪资面议|\d+(?:\.\d+)?\s*[-~—]\s*\d+(?:\.\d+)?\s*(?:K|k|千|万|元\/天|元\/月|\/天|\/月)|\d+(?:\.\d+)?\s*(?:K|k|千|万|元\/天|元\/月|\/天|\/月))/;

  const CARD_SELECTORS = [
    ".job-card-wrapper",
    ".job-list-box li",
    ".job-primary",
    ".job-card-body",
    "[class*='job-card']",
    "[class*='jobCard']",
    "[class*='job-list'] li",
    "[class*='jobList'] li"
  ];

  const state = {
    running: false,
    paused: false,
    stop: false,
    found: 0,
    sent: 0,
    clicked: 0,
    skipped: 0,
    errors: 0,
    message: "v2 已连接。",
    settings: null,
    records: loadJson(RECORD_KEY, {}),
    logs: loadJson(LOG_KEY, []),
    companies: new Set(),
    sessionKeys: new Set(),
    currentJob: null,
    searchUrl: ""
  };

  hydrateCompanies();
  restoreRun();
  ensureOverlay();
  updateOverlay();
  window.setTimeout(autoResume, 900);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((error) => {
        state.errors += 1;
        state.message = error.message || "v2 操作失败。";
        updateOverlay();
        sendResponse(getStatus());
      });
    return true;
  });

  async function handleMessage(message) {
    switch (message.type) {
      case "BOSS_V2_STATUS":
        restoreRun();
        return getStatus();
      case "BOSS_V2_SCAN":
        scanCards();
        return getStatus();
      case "BOSS_V2_START":
        if (state.running) {
          state.paused = false;
          state.message = "v2 继续运行。";
          updateOverlay();
          return getStatus();
        }
        state.settings = normalizeSettings(message.settings);
        startRun();
        return getStatus();
      case "BOSS_V2_PAUSE":
        state.paused = true;
        state.message = "v2 已暂停。";
        persistRun();
        updateOverlay();
        return getStatus();
      case "BOSS_V2_STOP":
        state.running = false;
        state.paused = false;
        state.stop = true;
        state.message = "v2 已停止。";
        clearRun();
        updateOverlay();
        return getStatus();
      case "BOSS_V2_EXPORT":
        return { ...getStatus(), csv: toCsv(state.logs) };
      case "BOSS_V2_CLEAR":
        state.records = {};
        state.logs = [];
        state.companies.clear();
        state.sessionKeys.clear();
        saveJson(RECORD_KEY, state.records);
        saveJson(LOG_KEY, state.logs);
        clearRun();
        scanCards();
        state.message = "v2 记录已清空。";
        updateOverlay();
        return getStatus();
      default:
        return getStatus();
    }
  }

  function startRun() {
    state.running = true;
    state.paused = false;
    state.stop = false;
    state.sent = 0;
    state.clicked = 0;
    state.skipped = 0;
    state.errors = 0;
    state.sessionKeys = new Set();
    state.currentJob = null;
    state.searchUrl = location.href;
    state.message = "v2 开始处理左侧岗位列表。";
    persistRun();
    updateOverlay();
    runLoop();
  }

  async function autoResume() {
    restoreRun();
    const run = loadRun();
    if (!run?.active || state.paused || state.stop || state.running || !state.settings) {
      updateOverlay();
      return;
    }
    if (isChatPage() && state.currentJob) {
      await finishOnChatPage();
      return;
    }
    if (!isChatPage()) {
      runLoop();
    }
  }

  async function runLoop() {
    state.running = true;
    state.paused = false;
    state.stop = false;
    persistRun();
    updateOverlay();

    try {
      while (state.running && !state.stop && handledCount() < state.settings.maxJobs) {
        closeReturnDialogIfPresent();
        if (detectBlocker()) {
          state.paused = true;
          state.running = false;
          state.message = "检测到登录或安全验证，请手动处理后再开始。";
          break;
        }

        const jobs = scanCards();
        let touchedOnPage = 0;

        for (const job of jobs) {
          await waitIfPaused();
          if (!state.running || state.stop || handledCount() >= state.settings.maxJobs) {
            break;
          }

          const skipReason = getSkipReason(job, state.settings);
          if (skipReason) {
            if (skipReason !== "本轮已处理" && skipReason !== "成功记录已存在") {
              state.skipped += 1;
              log("skip", job, skipReason);
            }
            state.sessionKeys.add(job.key);
            touchedOnPage += 1;
            updateOverlay(job.card);
            continue;
          }

          const result = await processJob(job);
          if (result.status === "pending-chat") {
            state.running = false;
            persistRun();
            return;
          }
          markJob(job, result.status, result.note);
          touchedOnPage += 1;
          await randomDelay(state.settings.delayMin, state.settings.delayMax);
        }

        if (!state.running || state.stop || handledCount() >= state.settings.maxJobs) {
          break;
        }

        if (!state.settings.autoNext) {
          state.message = `当前页处理完毕：${touchedOnPage} 个。`;
          state.stop = true;
          break;
        }

        const loaded = await loadMoreJobs(jobs.length);
        if (!loaded) {
          state.message = "当前可见岗位处理完毕，没有加载到更多岗位。";
          state.stop = true;
          break;
        }
      }
    } finally {
      state.running = false;
      state.paused = false;
      if (state.stop || handledCount() >= state.settings.maxJobs) {
        clearRun();
      } else {
        persistRun();
      }
      updateOverlay();
    }
  }

  async function processJob(job) {
    state.message = `v2 选中：${job.title || "未知岗位"} / ${job.company || "未知公司"}`;
    updateOverlay(job.card);

    try {
      selectCard(job.card);
      const detailReady = await waitForDetail(job, 2500);
      if (!detailReady) {
        state.message = `右侧详情未明显刷新：${job.title || "未知岗位"}`;
      }

      const button = await waitForApplyButton(4500);
      if (!button) {
        state.skipped += 1;
        state.message = `没找到沟通/投递按钮：${job.title || "未知岗位"}`;
        log("skip", job, "未找到沟通/投递按钮");
        return { status: "failed", note: "未找到沟通/投递按钮" };
      }

      clickElement(button);
      await sleep(900);

      state.currentJob = stripJob(job);
      persistRun();
      const continued = await clickContinueChatIfPresent(4500);
      if (continued) {
        state.message = `已点继续沟通，等待聊天页：${job.title || "未知岗位"}`;
        log("continue", job, "已点击立即沟通和继续沟通，等待进入聊天页");
        persistRun();
        await sleep(1200);
        return { status: "pending-chat", note: "等待聊天页发送留言" };
      }

      const filled = await fillHrMessage(state.settings.hrMessage);
      await sleep(500);
      const sent = filled ? await clickSendIfPresent(2500) : false;

      if (filled && sent) {
        state.sent += 1;
        state.currentJob = null;
        state.message = `已发送留言：${job.title || "未知岗位"}`;
        log("sent", job, "已填写 HR 留言并点击发送/确认");
        persistRun();
        return { status: "sent", note: "已填写 HR 留言并点击发送/确认" };
      }

      state.clicked += 1;
      state.currentJob = null;
      const note = filled
        ? "已填写 HR 留言，但未找到发送/确认按钮"
        : "已点击沟通/投递按钮，未找到可填写输入框";
      state.message = `${note}：${job.title || "未知岗位"}`;
      log("clicked", job, note);
      persistRun();
      return { status: "clicked", note };
    } catch (error) {
      state.errors += 1;
      state.currentJob = null;
      const note = error.message || "处理异常";
      state.message = `异常：${note}`;
      log("error", job, note);
      persistRun();
      return { status: "failed", note };
    }
  }

  function scanCards() {
    const raw = uniqueElements(
      CARD_SELECTORS.flatMap((selector) => [...document.querySelectorAll(selector)])
    ).filter(isLikelyJobCard);

    const jobs = [];
    const seen = new Set();
    for (const card of raw) {
      const info = getJobInfo(card);
      if (!info.title && !info.company) {
        continue;
      }
      if (seen.has(info.key)) {
        continue;
      }
      seen.add(info.key);
      jobs.push({ ...info, card });
    }

    state.found = jobs.length;
    state.message = jobs.length ? `v2 当前页发现 ${jobs.length} 个岗位。` : "v2 没识别到左侧岗位卡片。";
    updateOverlay();
    return jobs;
  }

  function isLikelyJobCard(el) {
    if (!isVisible(el) || el.closest(".boss-v2-overlay")) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 180 || rect.width > 620 || rect.height < 48 || rect.height > 260) {
      return false;
    }
    if (rect.left > window.innerWidth * 0.58) {
      return false;
    }
    const text = cleanText(el.textContent);
    if (text.length < 8 || text.length > 800) {
      return false;
    }
    return SALARY_PATTERN.test(text) || /经验不限|本科|大专|实习|全职|兼职|校招|社招/.test(text);
  }

  function getJobInfo(card) {
    const title =
      firstText(card, [".job-name", ".job-title", "[class*='job-name']", "[class*='jobTitle']", "[class*='job-title']"]) ||
      inferTitleFromText(card);
    const company =
      firstText(card, [".company-name", ".company-text", "[class*='company-name']", "[class*='companyName']", "[class*='company']"]) ||
      inferCompanyFromText(card);
    const salary = firstText(card, [".salary", ".red", "[class*='salary']"]) || inferSalaryFromText(card);
    const text = cleanText(card.textContent);
    const key = normalizeKey(`${title}|${company}|${salary}|${text.slice(0, 80)}`);
    return { title, company, salary, text, key };
  }

  function selectCard(card) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    const rect = card.getBoundingClientRect();
    const x = rect.left + Math.min(Math.max(rect.width * 0.24, 48), 150);
    const y = rect.top + Math.min(Math.max(rect.height * 0.2, 26), 50);
    const target = document.elementFromPoint(x, y) || card;
    clickElement(target, x, y);
    card.classList.add("boss-v2-highlight");
  }

  async function waitForDetail(job, timeoutMs) {
    const start = Date.now();
    const expected = compact(job.title);
    while (Date.now() - start < timeoutMs) {
      const rightText = getRightSideText();
      if (!expected || compact(rightText).includes(expected.slice(0, Math.min(expected.length, 10)))) {
        return true;
      }
      await sleep(180);
    }
    return false;
  }

  function getRightSideText() {
    const candidates = [
      ...document.querySelectorAll(".job-detail, .job-detail-box, [class*='job-detail'], [class*='jobDetail'], .job-sec, [class*='detail']")
    ].filter(isVisible);
    const right = candidates
      .filter((el) => el.getBoundingClientRect().left > window.innerWidth * 0.28)
      .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
    return cleanText((right || document.body).textContent);
  }

  async function waitForApplyButton(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const button = findApplyButton();
      if (button) {
        return button;
      }
      await sleep(220);
    }
    return null;
  }

  function findApplyButton() {
    const candidates = [
      ...document.querySelectorAll("button, a, .btn, [role='button'], input[type='button'], input[type='submit']")
    ].filter((el) => isVisible(el) && !isDisabled(el));

    return candidates
      .map((el) => ({ el, text: cleanText(el.textContent || el.value || ""), rect: el.getBoundingClientRect() }))
      .filter(({ text, rect }) => {
        if (!text || DONE_TEXT.test(text)) {
          return false;
        }
        if (BAD_BUTTON_TEXT.test(text) && !/沟通|投递|申请/.test(text)) {
          return false;
        }
        if (rect.left < window.innerWidth * 0.28) {
          return false;
        }
        return APPLY_TEXTS.some((word) => text.includes(word));
      })
      .sort((a, b) => scoreApplyButton(b.text, b.rect) - scoreApplyButton(a.text, a.rect))[0]?.el || null;
  }

  async function clickContinueChatIfPresent(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const button = findButtonByText(["继续沟通", "去沟通", "进入沟通", "继续"], {
        preferDialog: true,
        exclude: ["留在此页", "取消", "关闭"]
      });
      if (button) {
        clickElement(button);
        return true;
      }
      await sleep(220);
    }
    return false;
  }

  function closeReturnDialogIfPresent() {
    if (!document.body.textContent.includes("已向BOSS发送消息")) {
      return false;
    }
    const stay = findButtonByText(["留在此页", "关闭", "取消"], {
      preferDialog: true,
      exclude: ["继续沟通"]
    });
    if (stay) {
      clickElement(stay);
      return true;
    }
    return false;
  }

  function scoreApplyButton(text, rect) {
    let score = 0;
    if (/与BOSS随时沟通|立即沟通|BOSS随时沟通|在线沟通|马上沟通/.test(text)) {
      score += 100;
    } else if (/投递简历|立即投递|申请职位/.test(text)) {
      score += 90;
    } else if (/继续沟通|聊一聊|开聊/.test(text)) {
      score += 80;
    } else if (/沟通/.test(text)) {
      score += 70;
    } else if (/投递|申请/.test(text)) {
      score += 60;
    }
    if (rect.width >= 60 && rect.height >= 24) {
      score += 8;
    }
    if (rect.left > window.innerWidth * 0.45) {
      score += 5;
    }
    return score;
  }

  async function fillHrMessage(message) {
    const text = cleanText(message);
    if (!text) {
      return false;
    }
    const input = await waitForInput(4500);
    if (!input) {
      return false;
    }
    input.focus();
    if (input.isContentEditable) {
      input.textContent = text;
    } else {
      input.value = text;
    }
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  async function waitForInput(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const input = findMessageInput();
      if (input) {
        return input;
      }
      await sleep(220);
    }
    return null;
  }

  function findMessageInput() {
    const candidates = [
      ...document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']")
    ].filter((el) => isVisible(el) && !isDisabled(el));

    return candidates
      .map((el) => ({
        el,
        text: cleanText(`${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.className || ""}`),
        rect: el.getBoundingClientRect()
      }))
      .filter(({ el, text, rect }) => {
        if (/搜索|职位|公司|城市|验证码|密码|手机号|邮箱/.test(text)) {
          return false;
        }
        if (rect.width < 80 || rect.height < 18) {
          return false;
        }
        return /消息|留言|招呼|沟通|输入|回复|说点|聊天/.test(text) || el.isContentEditable || el.tagName === "TEXTAREA";
      })
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.el || null;
  }

  async function clickSendIfPresent(timeoutMs = 2500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const button = findButtonByText(SEND_TEXTS, {
        exclude: ["继续沟通", "发送简历", "发简历", "换电话", "换微信"]
      });
      if (button && !isDisabled(button)) {
        clickElement(button);
        return true;
      }
      await sleep(180);
    }
    return false;
  }

  async function finishOnChatPage() {
    state.running = true;
    state.message = `聊天页发送留言：${state.currentJob.title || "当前岗位"}`;
    persistRun();
    updateOverlay();

    const job = state.currentJob;
    try {
      const filled = await fillHrMessage(state.settings.hrMessage);
      await sleep(600);
      const sent = filled ? await clickSendIfPresent(4000) : false;
      if (filled && sent) {
        state.sent += 1;
        markJob(job, "sent", "聊天页已填写留言并发送");
        log("sent", job, "聊天页已填写留言并发送");
        state.message = `聊天页已发送，返回搜索页：${job.title || "当前岗位"}`;
      } else {
        state.clicked += 1;
        const note = filled ? "聊天页已填写留言，但未找到可点击发送按钮" : "聊天页未找到可填写输入框";
        markJob(job, "clicked", note);
        log("clicked", job, note);
        state.message = `${note}，返回搜索页`;
      }
    } catch (error) {
      state.errors += 1;
      const note = error.message || "聊天页发送异常";
      markJob(job, "failed", note);
      log("error", job, note);
      state.message = `${note}，返回搜索页`;
    } finally {
      state.currentJob = null;
      state.running = false;
      persistRun();
      updateOverlay();
      await randomDelay(state.settings.delayMin, state.settings.delayMax);
      returnToSearchPage();
    }
  }

  function findButtonByText(words, options = {}) {
    const candidates = [
      ...document.querySelectorAll("button, a, .btn, [role='button'], input[type='button'], input[type='submit']")
    ].filter((el) => isVisible(el));

    return candidates
      .map((el) => ({ el, text: cleanText(el.textContent || el.value || ""), rect: el.getBoundingClientRect() }))
      .filter(({ el, text }) => {
        if (!text || BAD_BUTTON_TEXT.test(text)) {
          return false;
        }
        if (options.exclude?.some((word) => text.includes(word))) {
          return false;
        }
        if (options.preferDialog && !isInDialog(el)) {
          return false;
        }
        return words.some((word) => text.includes(word));
      })
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.el || null;
  }

  async function loadMoreJobs(previousCount) {
    state.message = "当前可见岗位已处理，滚动加载更多。";
    updateOverlay();
    const scroller = findJobListScroller();
    for (let i = 0; i < 6; i += 1) {
      if (scroller) {
        scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 850 }));
        scroller.scrollTop += 850;
      } else {
        window.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 850 }));
        window.scrollBy({ top: 850, behavior: "smooth" });
      }
      await sleep(900);
      const count = scanCards().length;
      if (count > previousCount) {
        return true;
      }
    }
    return scanCards().some((job) => !getSkipReason(job, state.settings));
  }

  function findJobListScroller() {
    const cards = scanCards();
    const card = cards[0]?.card;
    if (!card) {
      return null;
    }
    let el = card.parentElement;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 80) {
        return el;
      }
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function isInDialog(el) {
    return Boolean(
      el.closest("[role='dialog'], .dialog, .modal, .boss-dialog, [class*='dialog'], [class*='modal']")
    ) || document.body.textContent.includes("已向BOSS发送消息");
  }

  function isChatPage() {
    const url = location.href.toLowerCase();
    if (/\/chat|\/message|\/im|\/web\/geek\/chat/.test(url)) {
      return true;
    }
    const text = cleanText(document.body.textContent);
    return /搜索30天内的联系人|发简历|换电话|换微信|按Enter键发送/.test(text) && findMessageInput();
  }

  function returnToSearchPage() {
    const target = state.searchUrl;
    if (target && history.length > 1) {
      history.back();
      return;
    }
    if (target) {
      location.href = target;
    }
  }

  function stripJob(job) {
    return {
      title: job.title || "",
      company: job.company || "",
      salary: job.salary || "",
      text: job.text || "",
      key: job.key || ""
    };
  }

  function restoreRun() {
    const run = loadRun();
    if (!run) {
      return;
    }
    state.settings = run.settings || state.settings;
    state.currentJob = run.currentJob || null;
    state.searchUrl = run.searchUrl || state.searchUrl;
    state.sent = run.sent ?? state.sent;
    state.clicked = run.clicked ?? state.clicked;
    state.skipped = run.skipped ?? state.skipped;
    state.errors = run.errors ?? state.errors;
    state.paused = Boolean(run.paused);
    state.stop = Boolean(run.stop);
    state.sessionKeys = new Set(run.sessionKeys || []);
    state.message = run.message || state.message;
  }

  function persistRun(active = true) {
    saveJson(RUN_KEY, {
      active,
      paused: state.paused,
      stop: state.stop,
      settings: state.settings,
      currentJob: state.currentJob,
      searchUrl: state.searchUrl,
      sent: state.sent,
      clicked: state.clicked,
      skipped: state.skipped,
      errors: state.errors,
      sessionKeys: [...state.sessionKeys],
      message: state.message
    });
  }

  function loadRun() {
    return loadJson(RUN_KEY, null);
  }

  function clearRun() {
    localStorage.removeItem(RUN_KEY);
  }

  function getSkipReason(job, settings) {
    const combined = `${job.title} ${job.company} ${job.salary} ${job.text}`.toLowerCase();
    const blacklist = parseList(settings.blacklist).map((item) => item.toLowerCase());
    if (blacklist.some((word) => word && combined.includes(word))) {
      return "黑名单跳过";
    }
    if (state.sessionKeys.has(job.key)) {
      return "本轮已处理";
    }
    if (settings.skipSent && ["sent", "clicked"].includes(state.records[job.key]?.status)) {
      return "成功记录已存在";
    }
    if (settings.dedupeCompany && job.company && state.companies.has(normalizeKey(job.company))) {
      return "同公司已处理";
    }
    return "";
  }

  function markJob(job, status, note) {
    state.sessionKeys.add(job.key);
    state.records[job.key] = {
      status,
      note,
      title: job.title,
      company: job.company,
      salary: job.salary,
      time: new Date().toISOString()
    };
    if (["sent", "clicked"].includes(status) && job.company) {
      state.companies.add(normalizeKey(job.company));
    }
    saveJson(RECORD_KEY, state.records);
  }

  function handledCount() {
    return state.sent + state.clicked;
  }

  function detectBlocker() {
    return BLOCK_TEXT.test(cleanText(document.body.textContent || ""));
  }

  async function waitIfPaused() {
    while (state.paused && !state.stop) {
      await sleep(400);
    }
  }

  function clickElement(el, clientX, clientY) {
    const rect = el.getBoundingClientRect();
    const x = clientX ?? rect.left + rect.width / 2;
    const y = clientY ?? rect.top + rect.height / 2;
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      el.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y
        })
      );
    }
  }

  function firstText(root, selectors) {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      const text = cleanText(el?.textContent || "");
      if (text) {
        return text;
      }
    }
    return "";
  }

  function inferTitleFromText(card) {
    const text = cleanText(card.textContent);
    const match = text.match(SALARY_PATTERN);
    const before = match ? text.slice(0, match.index) : text;
    return before.replace(/^(急聘|热招|推荐|新)\s*/, "").trim().slice(0, 60);
  }

  function inferSalaryFromText(card) {
    return cleanText(card.textContent).match(SALARY_PATTERN)?.[0] || "";
  }

  function inferCompanyFromText(card) {
    const text = cleanText(card.textContent);
    const parts = text.split(/\s+/).filter(Boolean);
    return parts.find((part) => /公司|科技|软件|数据|网络|集团|有限|华为|阿里|字节|腾讯/.test(part)) || "";
  }

  function parseList(value) {
    return String(value || "")
      .split(/[\n,，;；]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function normalizeSettings(settings = {}) {
    const delayMin = clamp(settings.delayMin, 1, 60, 4);
    const delayMax = clamp(settings.delayMax, 1, 120, 9);
    return {
      maxJobs: clamp(settings.maxJobs, 1, 1000, 80),
      delayMin,
      delayMax: Math.max(delayMin, delayMax),
      blacklist: String(settings.blacklist || ""),
      hrMessage: String(settings.hrMessage || ""),
      autoNext: Boolean(settings.autoNext),
      dedupeCompany: Boolean(settings.dedupeCompany),
      skipSent: settings.skipSent !== false
    };
  }

  function hydrateCompanies() {
    Object.values(state.records || {}).forEach((item) => {
      if (["sent", "clicked"].includes(item?.status) && item.company) {
        state.companies.add(normalizeKey(item.company));
      }
    });
  }

  function ensureOverlay() {
    if (document.querySelector(".boss-v2-overlay")) {
      return;
    }
    const overlay = document.createElement("div");
    overlay.className = "boss-v2-overlay";
    overlay.innerHTML = "<strong>BOSS 海投助手 v2</strong><span>等待启动</span>";
    document.body.appendChild(overlay);
  }

  function updateOverlay(highlight) {
    document.querySelectorAll(".boss-v2-highlight").forEach((el) => {
      if (el !== highlight) {
        el.classList.remove("boss-v2-highlight");
      }
    });
    if (highlight) {
      highlight.classList.add("boss-v2-highlight");
    }
    const overlay = document.querySelector(".boss-v2-overlay");
    if (!overlay) {
      return;
    }
    overlay.innerHTML = `
      <strong>BOSS 海投助手 v2：${state.running ? "运行中" : state.paused ? "已暂停" : "就绪"}</strong>
      <span>发现 ${state.found} · 发送 ${state.sent} · 点击 ${state.clicked} · 跳过 ${state.skipped} · 异常 ${state.errors}</span>
      <span>${escapeHtml(state.message)}</span>
    `;
  }

  function getStatus() {
    return {
      running: state.running,
      paused: state.paused,
      found: state.found,
      sent: state.sent,
      clicked: state.clicked,
      skipped: state.skipped,
      errors: state.errors,
      message: state.message
    };
  }

  function log(status, job, note) {
    state.logs.push({
      time: new Date().toISOString(),
      status,
      title: job.title || "",
      company: job.company || "",
      salary: job.salary || "",
      note: note || ""
    });
    state.logs = state.logs.slice(-1000);
    saveJson(LOG_KEY, state.logs);
  }

  function toCsv(rows) {
    const header = ["time", "status", "title", "company", "salary", "note"];
    const data = rows.map((row) => header.map((key) => csvCell(row[key])).join(","));
    return [header.join(","), ...data].join("\n");
  }

  function csvCell(value) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
  }

  function randomDelay(minSeconds, maxSeconds) {
    const min = Math.min(minSeconds, maxSeconds) * 1000;
    const max = Math.max(minSeconds, maxSeconds) * 1000;
    return sleep(min + Math.random() * (max - min));
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function clamp(value, min, max, fallback) {
    const num = Number.parseInt(value, 10);
    if (!Number.isFinite(num)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, num));
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function compact(value) {
    return cleanText(value).replace(/\s+/g, "").toLowerCase();
  }

  function normalizeKey(value) {
    return compact(value);
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function isDisabled(el) {
    return Boolean(
      el.disabled ||
        el.getAttribute("disabled") !== null ||
        el.getAttribute("aria-disabled") === "true" ||
        /\bdisabled\b/.test(`${el.className || ""}`)
    );
  }

  function uniqueElements(elements) {
    return [...new Set(elements)];
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
