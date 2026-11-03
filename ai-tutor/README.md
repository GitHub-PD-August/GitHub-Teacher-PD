# 🎓 Study Buddy: a lightweight AI tutor

A small, easy-to-read AI tutor web app powered by Claude. It was inspired by the ideas in
[HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor), but it is a deliberately tiny, original
codebase (about 1,000 lines). Teachers and students can read it, run it, and extend it.

## Features

| | |
|---|---|
| 💬 **Tutor chat** | Streaming answers with Markdown and LaTeX math. Choose the learner level (beginner / intermediate / advanced) and a tutor style: **Explain**, **Socratic** (hints instead of answers), or **Solve step by step**. |
| 📄 **Study from your own material** | Upload PDFs or text/Markdown notes. Ticked files are sent to Claude so it can answer from them and cite them. They're prompt-cached, so follow-up questions are cheaper. |
| 📝 **Generated quizzes** | Multiple-choice quizzes on any topic or on your uploaded material. Each question comes with an explanation and the concept it tests. The quiz is returned as structured JSON. |
| 📈 **Progress tracking** | Day streak, quiz accuracy, mastery for each concept, and quiz history. Weak concepts become one-click "review this with the tutor" buttons. |
| 🔁 **Closed loop** | "Quiz me" on a chat topic, then "Ask the tutor about my mistakes" after a quiz. |
| 📱 **Works anywhere** | Responsive layout with light and dark mode. No CDN is needed: libraries are served locally. |

## Run it

You need **Node.js 20+** and an **Anthropic API key** from <https://console.anthropic.com/>.

```bash
cd ai-tutor
npm install
```

Then set your API key (macOS / Linux):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

On Windows PowerShell, use `$env:ANTHROPIC_API_KEY="sk-ant-..."` instead.

```bash
npm start
```

Open <http://localhost:3000>.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `TUTOR_MODEL` | `claude-opus-5-5` | Claude model to use |

## How it works

```
browser (public/)                     server.js (Express)                 Claude API
─────────────────                     ───────────────────                 ──────────
Chat tab  ── POST /api/chat ───────▶  builds system prompt (level+style),
          ◀── Server-Sent Events ───  attaches selected materials ───────▶ messages.stream
Quiz tab  ── POST /api/quiz ───────▶  JSON-schema structured output ────▶ messages.stream
Sidebar   ── POST /api/materials ──▶  keeps uploads in memory
Progress  ── localStorage (per browser, nothing sent to the server)
```

- **`server.js`**: the API key stays on the server and is never sent to the browser.
  - Uses adaptive thinking with `medium` effort.
  - Turns on Anthropic's server-side refusal fallback.
  - Caches uploaded material so repeat questions about the same notes are cheaper.
- **`public/app.js`**: plain JavaScript with no build step. It handles streaming, rendering, quizzes and progress.
- **`public/style.css`**: all the styling, including dark mode and the mobile layout.

## Good to know / ideas to extend

- Uploaded materials live in server memory and disappear on restart. To keep them, add a database or save them to disk.
- Progress and chat history are stored in each student's browser (`localStorage`). For a class
  dashboard, add user accounts and store results on the server.
- There's no login. Don't expose the server publicly as-is, because anyone who can reach it uses your API key.
  Put it behind a login or run it on a private network.
- Ideas: flashcards with spaced repetition, a teacher view of class results, voice input,
  or a "GitHub Classroom" mode that explains feedback on student repos.
