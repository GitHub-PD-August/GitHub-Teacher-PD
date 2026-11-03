// Study Buddy — browser app. No build step; plain JavaScript.
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  // ------------------------------------------------------------------
  // Local storage helpers (everything here is per-browser convenience)
  // ------------------------------------------------------------------
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage may be full or blocked; the app still works */
      }
    },
  };

  const KEYS = { chat: "sb.chat", settings: "sb.settings", progress: "sb.progress" };

  const state = {
    chat: store.get(KEYS.chat, []), // [{role, content}]
    materials: [], // from server
    selected: new Set(store.get(KEYS.settings, {}).selected || []),
    streaming: null, // AbortController while a reply streams
    progress: store.get(KEYS.progress, { quizzes: [], questionsAsked: 0, days: [] }),
  };

  // ------------------------------------------------------------------
  // Markdown + math rendering
  // ------------------------------------------------------------------
  marked.setOptions({ gfm: true, breaks: false });

  function renderMarkdown(text) {
    // Pull math out first so Markdown doesn't mangle backslashes and underscores.
    const math = [];
    const protect = (tex, display) => {
      math.push({ tex, display });
      return `@@MATH${math.length - 1}@@`;
    };
    let src = text
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => protect(t, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => protect(t, true))
      .replace(/\\\((.+?)\\\)/g, (_, t) => protect(t, false))
      .replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_, pre, t) => pre + protect(t, false));

    let html = DOMPurify.sanitize(marked.parse(src));
    html = html.replace(/@@MATH(\d+)@@/g, (_, i) => {
      const { tex, display } = math[Number(i)];
      try {
        return katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false });
      } catch {
        return escapeHtml(tex);
      }
    });
    return html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  function saveSettings() {
    store.set(KEYS.settings, {
      level: $("#levelSelect").value,
      mode: $("#modeSelect").value,
      selected: [...state.selected],
    });
  }
  function loadSettings() {
    const s = store.get(KEYS.settings, {});
    if (s.level) $("#levelSelect").value = s.level;
    if (s.mode) $("#modeSelect").value = s.mode;
  }
  $("#levelSelect").addEventListener("change", saveSettings);
  $("#modeSelect").addEventListener("change", saveSettings);

  // ------------------------------------------------------------------
  // Tabs and mobile sidebar
  // ------------------------------------------------------------------
  function showTab(name) {
    $$(".tab").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
    });
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    if (name === "progress") renderProgress();
    if (name === "quiz") updateQuizMaterialNote();
  }
  $$(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

  const sidebar = $("#sidebar");
  const scrim = $("#scrim");
  const toggleSidebar = (open) => {
    sidebar.classList.toggle("open", open);
    scrim.classList.toggle("show", open);
  };
  $("#menuBtn").addEventListener("click", () => toggleSidebar(true));
  scrim.addEventListener("click", () => toggleSidebar(false));

  // ------------------------------------------------------------------
  // Materials
  // ------------------------------------------------------------------
  async function loadMaterials() {
    try {
      const res = await fetch("/api/materials");
      state.materials = await res.json();
      // Drop selections for files the server no longer has (e.g. after a restart).
      const ids = new Set(state.materials.map((m) => m.id));
      state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
      saveSettings();
    } catch {
      state.materials = [];
    }
    renderMaterials();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderMaterials(pending = []) {
    const list = $("#materialList");
    list.innerHTML = "";
    for (const m of state.materials) {
      const li = document.createElement("li");
      li.innerHTML = `
        <label>
          <input type="checkbox" ${state.selected.has(m.id) ? "checked" : ""} />
          <span style="min-width:0">
            <div class="name" title="${escapeHtml(m.name)}">${m.kind === "pdf" ? "📕" : "📄"} ${escapeHtml(m.name)}</div>
            <div class="meta">${formatSize(m.size)}</div>
          </span>
        </label>
        <button class="icon-btn" title="Remove" aria-label="Remove ${escapeHtml(m.name)}">✕</button>`;
      li.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) state.selected.add(m.id);
        else state.selected.delete(m.id);
        saveSettings();
        updateQuizMaterialNote();
      });
      li.querySelector("button").addEventListener("click", async () => {
        await fetch(`/api/materials/${m.id}`, { method: "DELETE" });
        state.selected.delete(m.id);
        await loadMaterials();
        updateQuizMaterialNote();
      });
      list.appendChild(li);
    }
    for (const name of pending) {
      const li = document.createElement("li");
      li.className = "uploading";
      li.innerHTML = `<span class="name">⏳ ${escapeHtml(name)}</span>`;
      list.appendChild(li);
    }
  }

  async function uploadFiles(files) {
    const pending = [...files].map((f) => f.name);
    renderMaterials(pending);
    for (const file of files) {
      const body = new FormData();
      body.append("file", file);
      try {
        const res = await fetch("/api/materials", { method: "POST", body });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        state.materials.push(data);
        state.selected.add(data.id);
      } catch (err) {
        alert(`Could not upload ${file.name}: ${err.message}`);
      }
      pending.shift();
      renderMaterials(pending);
    }
    saveSettings();
    updateQuizMaterialNote();
  }

  const dropzone = $("#dropzone");
  $("#fileInput").addEventListener("change", (e) => {
    if (e.target.files.length) uploadFiles(e.target.files);
    e.target.value = "";
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove("over");
    }),
  );
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  // ------------------------------------------------------------------
  // Chat
  // ------------------------------------------------------------------
  const chatLog = $("#chatLog");
  const chatInput = $("#chatInput");
  const sendBtn = $("#sendBtn");

  function addBubble(role, content, { error = false } = {}) {
    $("#chatEmpty").style.display = "none";
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}${error ? " error" : ""}`;
    wrap.innerHTML = `<div class="avatar">${role === "user" ? "🙂" : "🎓"}</div><div class="bubble"></div>`;
    const bubble = wrap.querySelector(".bubble");
    if (role === "user") bubble.textContent = content;
    else bubble.innerHTML = error ? escapeHtml(content) : renderMarkdown(content);
    chatLog.appendChild(wrap);
    scrollChat();
    return bubble;
  }

  function scrollChat() {
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function renderChat() {
    chatLog.querySelectorAll(".msg").forEach((el) => el.remove());
    $("#chatEmpty").style.display = state.chat.length ? "none" : "";
    for (const m of state.chat) addBubble(m.role, m.content);
  }

  function saveChat() {
    store.set(KEYS.chat, state.chat.slice(-60));
  }

  function markStudyDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (!state.progress.days.includes(today)) state.progress.days.push(today);
    store.set(KEYS.progress, state.progress);
  }

  function setStreaming(on) {
    sendBtn.textContent = on ? "Stop" : "Send";
    sendBtn.classList.toggle("primary", !on);
    sendBtn.type = on ? "button" : "submit";
  }

  async function sendMessage(text) {
    text = text.trim();
    if (!text || state.streaming) return;

    state.chat.push({ role: "user", content: text });
    saveChat();
    addBubble("user", text);
    chatInput.value = "";
    autosize();
    state.progress.questionsAsked += 1;
    markStudyDay();

    const bubble = addBubble("assistant", "");
    bubble.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>`;

    const controller = new AbortController();
    state.streaming = controller;
    setStreaming(true);

    let reply = "";
    let errorMsg = null;
    let renderQueued = false;
    const queueRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        bubble.innerHTML = renderMarkdown(reply);
        scrollChat();
      });
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          history: state.chat,
          materialIds: [...state.selected],
          level: $("#levelSelect").value,
          mode: $("#modeSelect").value,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server error ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const dataLine = /^data: (.*)$/m.exec(raw)?.[1];
          if (!event || !dataLine) continue;
          const data = JSON.parse(dataLine);
          if (event === "delta") {
            reply += data.text;
            queueRender();
          } else if (event === "error") {
            errorMsg = data.message;
          }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") errorMsg = err.message;
    } finally {
      state.streaming = null;
      setStreaming(false);
    }

    if (reply) {
      bubble.innerHTML = renderMarkdown(reply);
      state.chat.push({ role: "assistant", content: reply });
      saveChat();
    } else {
      bubble.closest(".msg").remove();
    }
    if (errorMsg) {
      addBubble("assistant", errorMsg, { error: true });
      if (!reply) {
        // Let the student retry the same question.
        state.chat.pop();
        saveChat();
        chatInput.value = text;
      }
    }
    chatInput.focus();
  }

  function autosize() {
    chatInput.style.height = "auto";
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 200)}px`;
  }

  $("#chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage(chatInput.value);
  });
  sendBtn.addEventListener("click", (e) => {
    if (state.streaming) {
      e.preventDefault();
      state.streaming.abort();
    }
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(chatInput.value);
    }
  });
  chatInput.addEventListener("input", autosize);
  $$(".chip[data-prompt]").forEach((c) => c.addEventListener("click", () => sendMessage(c.dataset.prompt)));

  $("#clearChatBtn").addEventListener("click", () => {
    if (state.streaming) state.streaming.abort();
    if (state.chat.length && !confirm("Start a new conversation? The current one will be cleared.")) return;
    state.chat = [];
    saveChat();
    renderChat();
  });

  $("#quizFromChatBtn").addEventListener("click", () => {
    const lastQuestion = [...state.chat].reverse().find((m) => m.role === "user");
    if (lastQuestion) $("#quizTopic").value = lastQuestion.content.slice(0, 160);
    showTab("quiz");
    $("#quizTopic").focus();
  });

  // ------------------------------------------------------------------
  // Quiz
  // ------------------------------------------------------------------
  const quizArea = $("#quizArea");

  function updateQuizMaterialNote() {
    const names = state.materials.filter((m) => state.selected.has(m.id)).map((m) => m.name);
    $("#quizMaterialNote").textContent = names.length
      ? `Questions will be based on: ${names.join(", ")}`
      : "Tip: tick study material in the sidebar to get questions from your own notes.";
  }

  $("#quizForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const topic = $("#quizTopic").value.trim();
    if (!topic && !state.selected.size) {
      alert("Type a topic, or tick some study material in the sidebar.");
      return;
    }
    const btn = $("#quizBtn");
    btn.disabled = true;
    quizArea.innerHTML = `<div class="card loading">✍️ Writing your quiz… this can take a little while.</div>`;
    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          count: Number($("#quizCount").value),
          difficulty: $("#quizDifficulty").value,
          level: $("#levelSelect").value,
          materialIds: [...state.selected],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create the quiz.");
      renderQuiz(data, topic);
    } catch (err) {
      quizArea.innerHTML = `<div class="card" style="color:var(--bad)">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  });

  function renderQuiz(quiz, topic) {
    const answers = new Array(quiz.questions.length).fill(null);
    quizArea.innerHTML = `<h2 style="margin:8px 0 14px">${escapeHtml(quiz.title || "Quiz")}</h2>`;

    quiz.questions.forEach((q, qi) => {
      const card = document.createElement("div");
      card.className = "card question";
      card.innerHTML = `
        <div class="qnum">Question ${qi + 1} of ${quiz.questions.length} · ${escapeHtml(q.concept || "")}</div>
        <h3>${renderMarkdown(q.question)}</h3>
        <div class="options"></div>
        <div class="explanation" hidden></div>`;
      const opts = card.querySelector(".options");
      q.options.forEach((opt, oi) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "option";
        b.innerHTML = `<strong>${String.fromCharCode(65 + oi)}.</strong> ${renderMarkdown(opt).replace(/^<p>|<\/p>\s*$/g, "")}`;
        b.addEventListener("click", () => {
          if (answers[qi] !== null) return;
          answers[qi] = oi;
          opts.querySelectorAll(".option").forEach((el, i) => {
            el.disabled = true;
            if (i === q.answerIndex) el.classList.add("correct");
            else if (i === oi) el.classList.add("wrong");
          });
          const ex = card.querySelector(".explanation");
          const right = oi === q.answerIndex;
          ex.innerHTML = `<strong>${right ? "✅ Correct!" : "❌ Not quite."}</strong> ${renderMarkdown(q.explanation)}`;
          ex.hidden = false;
          if (answers.every((a) => a !== null)) finishQuiz(quiz, answers, topic);
        });
        opts.appendChild(b);
      });
      quizArea.appendChild(card);
    });
    quizArea.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function finishQuiz(quiz, answers, topic) {
    const total = quiz.questions.length;
    const score = quiz.questions.reduce((s, q, i) => s + (answers[i] === q.answerIndex ? 1 : 0), 0);
    const concepts = {};
    quiz.questions.forEach((q, i) => {
      const key = (q.concept || "General").trim();
      concepts[key] ??= { right: 0, total: 0 };
      concepts[key].total += 1;
      if (answers[i] === q.answerIndex) concepts[key].right += 1;
    });
    state.progress.quizzes.push({
      date: new Date().toISOString(),
      title: quiz.title || topic || "Quiz",
      score,
      total,
      concepts,
    });
    state.progress.quizzes = state.progress.quizzes.slice(-200);
    markStudyDay();

    const pct = Math.round((score / total) * 100);
    const msg = pct === 100 ? "Perfect score! 🌟" : pct >= 70 ? "Great work! 💪" : pct >= 40 ? "Good effort — review the explanations." : "Keep going — every attempt helps you learn.";
    const missed = quiz.questions.filter((q, i) => answers[i] !== q.answerIndex);

    const card = document.createElement("div");
    card.className = "card score";
    card.innerHTML = `
      <div class="big">${score} / ${total}</div>
      <p>${msg}</p>
      <div class="quiz-actions">
        ${missed.length ? `<button class="btn primary" id="reviewMissedBtn">Ask the tutor about my mistakes</button>` : ""}
        <button class="btn" id="newQuizBtn">Another quiz</button>
        <button class="btn" id="seeProgressBtn">See progress</button>
      </div>`;
    quizArea.appendChild(card);
    card.scrollIntoView({ behavior: "smooth", block: "center" });

    card.querySelector("#newQuizBtn").addEventListener("click", () => {
      quizArea.innerHTML = "";
      $("#quizForm").scrollIntoView({ behavior: "smooth" });
    });
    card.querySelector("#seeProgressBtn").addEventListener("click", () => showTab("progress"));
    card.querySelector("#reviewMissedBtn")?.addEventListener("click", () => {
      const list = missed
        .map((q) => `- "${q.question}" (correct answer: ${q.options[q.answerIndex]})`)
        .join("\n");
      showTab("chat");
      sendMessage(`I just took a quiz and got these questions wrong:\n${list}\n\nCan you help me understand the ideas behind them?`);
    });
  }

  // ------------------------------------------------------------------
  // Progress
  // ------------------------------------------------------------------
  function streak(days) {
    const set = new Set(days);
    let count = 0;
    const d = new Date();
    // Today not studied yet still keeps yesterday's streak alive.
    if (!set.has(d.toISOString().slice(0, 10))) d.setDate(d.getDate() - 1);
    while (set.has(d.toISOString().slice(0, 10))) {
      count += 1;
      d.setDate(d.getDate() - 1);
    }
    return count;
  }

  function renderProgress() {
    const p = state.progress;
    const quizzes = p.quizzes;
    const answered = quizzes.reduce((s, q) => s + q.total, 0);
    const right = quizzes.reduce((s, q) => s + q.score, 0);
    const accuracy = answered ? Math.round((right / answered) * 100) : 0;

    const concepts = {};
    for (const q of quizzes) {
      for (const [name, c] of Object.entries(q.concepts || {})) {
        const key = name.toLowerCase();
        concepts[key] ??= { name, right: 0, total: 0 };
        concepts[key].right += c.right;
        concepts[key].total += c.total;
      }
    }
    const conceptList = Object.values(concepts).sort((a, b) => a.right / a.total - b.right / b.total || b.total - a.total);
    const weakest = conceptList.filter((c) => c.right / c.total < 0.7).slice(0, 3);

    const area = $("#progressArea");
    area.innerHTML = `
      <div class="stats">
        <div class="stat"><div class="value">${streak(p.days)}🔥</div><div class="label">Day streak</div></div>
        <div class="stat"><div class="value">${quizzes.length}</div><div class="label">Quizzes taken</div></div>
        <div class="stat"><div class="value">${answered ? accuracy + "%" : "–"}</div><div class="label">Quiz accuracy</div></div>
        <div class="stat"><div class="value">${p.questionsAsked}</div><div class="label">Questions asked</div></div>
      </div>
      ${
        weakest.length
          ? `<div class="card"><h2>Suggested next steps</h2><p class="muted small">These concepts need the most practice.</p>
             <div class="starters" style="justify-content:flex-start">${weakest
               .map((c) => `<button class="chip" data-review="${escapeHtml(c.name)}">Review “${escapeHtml(c.name)}”</button>`)
               .join("")}</div></div>`
          : ""
      }
      <div class="card">
        <h2>Concept mastery</h2>
        ${
          conceptList.length
            ? `<div class="concepts">${conceptList
                .map((c) => {
                  const pct = Math.round((c.right / c.total) * 100);
                  const cls = pct < 50 ? "low" : pct >= 80 ? "high" : "";
                  return `<div class="concept-row"><span class="name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
                    <div class="bar ${cls}" role="img" aria-label="${pct}%"><span style="width:${pct}%"></span></div>
                    <span class="small muted">${c.right}/${c.total}</span></div>`;
                })
                .join("")}</div>`
            : `<p class="muted">Take a quiz to see which concepts you've mastered.</p>`
        }
      </div>
      <div class="card">
        <h2>Recent quizzes</h2>
        ${
          quizzes.length
            ? `<table class="history"><thead><tr><th>Date</th><th>Quiz</th><th>Score</th></tr></thead><tbody>${[...quizzes]
                .reverse()
                .slice(0, 15)
                .map(
                  (q) =>
                    `<tr><td class="small">${new Date(q.date).toLocaleDateString()}</td><td>${escapeHtml(q.title)}</td><td>${q.score}/${q.total}</td></tr>`,
                )
                .join("")}</tbody></table>`
            : `<p class="muted">No quizzes yet.</p>`
        }
        ${quizzes.length || p.questionsAsked ? `<p style="margin-top:12px"><button class="btn ghost" id="resetProgressBtn">Reset progress</button></p>` : ""}
      </div>`;

    area.querySelectorAll("[data-review]").forEach((b) =>
      b.addEventListener("click", () => {
        showTab("chat");
        sendMessage(`I keep getting "${b.dataset.review}" wrong in quizzes. Can you re-teach it simply and then give me a practice question?`);
      }),
    );
    area.querySelector("#resetProgressBtn")?.addEventListener("click", () => {
      if (!confirm("Clear all quiz history and stats on this device?")) return;
      state.progress = { quizzes: [], questionsAsked: 0, days: [] };
      store.set(KEYS.progress, state.progress);
      renderProgress();
    });
  }

  // ------------------------------------------------------------------
  // Start up
  // ------------------------------------------------------------------
  async function checkServer() {
    const el = $("#serverStatus");
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      el.textContent = `Connected · ${data.model}`;
    } catch {
      el.textContent = "Server not reachable";
    }
  }

  loadSettings();
  renderChat();
  loadMaterials().then(updateQuizMaterialNote);
  checkServer();
})();
