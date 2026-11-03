// Study Buddy — a lightweight AI tutor.
// Express backend that keeps the Anthropic API key on the server and exposes:
//   POST /api/materials   upload a PDF / text / markdown file to study from
//   GET  /api/materials   list uploaded materials
//   DELETE /api/materials/:id
//   POST /api/chat        streaming tutor chat (Server-Sent Events)
//   POST /api/quiz        generate a multiple-choice quiz as structured JSON

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.TUTOR_MODEL || "claude-opus-5-5";
const MAX_UPLOAD_MB = 20;

// Server-side refusal fallback: if the model declines, the API re-runs the
// request on Anthropic's recommended fallback model inside the same call.
const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

// Reads ANTHROPIC_API_KEY (or an `ant auth login` profile) from the environment.
const client = new Anthropic();

// ---------------------------------------------------------------------------
// Study materials (kept in memory — they disappear when the server restarts)
// ---------------------------------------------------------------------------
/** @type {Map<string, {id:string,name:string,kind:"pdf"|"text",size:number,data:string,uploadedAt:string}>} */
const materials = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".py", ".js", ".java", ".c", ".cpp"]);

function publicMaterial(m) {
  const { data, ...rest } = m;
  return rest;
}

/** Build the content block that gives Claude a material to read. */
function materialBlock(m) {
  if (m.kind === "pdf") {
    return {
      type: "document",
      title: m.name,
      source: { type: "base64", media_type: "application/pdf", data: m.data },
    };
  }
  return {
    type: "document",
    title: m.name,
    source: { type: "text", media_type: "text/plain", data: m.data },
  };
}

function selectedMaterials(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => materials.get(id)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const LEVEL_HINTS = {
  beginner: "The student is a beginner: use plain language, short steps and everyday analogies.",
  intermediate: "The student has some background: be precise and connect ideas, but still explain new terms.",
  advanced: "The student is advanced: be rigorous and concise, and point to deeper ideas and edge cases.",
};

const MODE_HINTS = {
  explain: "Mode: Explain. Teach the concept clearly with an example, then ask one short question to check understanding.",
  socratic:
    "Mode: Socratic. Do not hand over the final answer straight away. Guide the student with one or two focused questions or hints at a time, and confirm or gently correct their reasoning.",
  solve: "Mode: Solve. Work through the problem step by step, explaining why each step is taken, then summarise the method so the student can reuse it.",
};

function tutorSystemPrompt({ level, mode, hasMaterials }) {
  return [
    "You are Study Buddy, a patient and encouraging personal tutor.",
    "Your goal is for the student to understand, not just to receive answers.",
    LEVEL_HINTS[level] || LEVEL_HINTS.intermediate,
    MODE_HINTS[mode] || MODE_HINTS.explain,
    hasMaterials
      ? "The student has shared study material. Ground your answers in it, mention the document (and page or section when you can) you are drawing on, and say clearly when something goes beyond the material."
      : "",
    "Format answers in Markdown. Use headings or lists only when they help, write math with LaTeX between $...$ or $$...$$, and keep replies focused.",
    "If the student seems stuck or frustrated, slow down and encourage them.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "public")));

// Browser libraries are served from node_modules so the app works without a CDN
// (handy on school networks that block third-party hosts).
const vendor = (pkgPath) => path.join(here, "node_modules", pkgPath);
app.get("/vendor/marked.js", (_req, res) => res.sendFile(vendor("marked/lib/marked.umd.js")));
app.get("/vendor/purify.js", (_req, res) => res.sendFile(vendor("dompurify/dist/purify.min.js")));
app.get("/vendor/katex.js", (_req, res) => res.sendFile(vendor("katex/dist/katex.min.js")));
app.get("/vendor/katex.css", (_req, res) => res.sendFile(vendor("katex/dist/katex.min.css")));
app.use("/vendor/fonts", express.static(vendor("katex/dist/fonts"), { maxAge: "7d" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL });
});

app.get("/api/materials", (_req, res) => {
  res.json([...materials.values()].map(publicMaterial));
});

app.post("/api/materials", upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded." });

  const ext = path.extname(file.originalname).toLowerCase();
  let kind;
  let data;
  if (file.mimetype === "application/pdf" || ext === ".pdf") {
    kind = "pdf";
    data = file.buffer.toString("base64");
  } else if (file.mimetype.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) {
    kind = "text";
    data = file.buffer.toString("utf8");
    if (!data.trim()) return res.status(400).json({ error: "That file is empty." });
  } else {
    return res.status(400).json({ error: "Please upload a PDF or a text/Markdown file." });
  }

  const m = {
    id: crypto.randomUUID(),
    name: file.originalname,
    kind,
    size: file.size,
    data,
    uploadedAt: new Date().toISOString(),
  };
  materials.set(m.id, m);
  res.status(201).json(publicMaterial(m));
});

app.delete("/api/materials/:id", (req, res) => {
  materials.delete(req.params.id);
  res.status(204).end();
});

/** Turn the browser's chat history into API messages, attaching materials to the first user turn. */
function buildMessages(history, mats) {
  const clean = (Array.isArray(history) ? history : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-40)
    .map((m) => ({ role: m.role, content: m.content }));

  // The API expects the conversation to start with a user turn.
  while (clean.length && clean[0].role !== "user") clean.shift();
  if (!clean.length || clean[clean.length - 1].role !== "user") return null;

  if (mats.length) {
    const blocks = mats.map(materialBlock);
    // Cache the (large, unchanging) materials so follow-up questions are cheaper and faster.
    blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
    clean[0] = { role: "user", content: [...blocks, { type: "text", text: clean[0].content }] };
  }
  return clean;
}

function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "The server's Anthropic API key is missing or invalid.";
  if (err instanceof Anthropic.RateLimitError) return "The tutor is busy right now (rate limited). Please try again in a moment.";
  if (err instanceof Anthropic.BadRequestError) return `The request was rejected: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API. Check the server's network connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status}): ${err.message}`;
  return err?.message || "Unexpected server error.";
}

app.post("/api/chat", async (req, res) => {
  const { history, materialIds, level, mode } = req.body || {};
  const mats = selectedMaterials(materialIds);
  const messages = buildMessages(history, mats);
  if (!messages) return res.status(400).json({ error: "Send at least one user message." });

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 16000,
        ...FALLBACK,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        system: tutorSystemPrompt({ level, mode, hasMaterials: mats.length > 0 }),
        messages,
      },
      { signal: controller.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "thinking") {
        send("status", { state: "thinking" });
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        send("delta", { text: event.delta.text });
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      send("error", { message: "The tutor declined to answer that request. Try rephrasing it as a study question." });
    } else {
      send("done", { stopReason: final.stop_reason, usage: final.usage });
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error("chat error:", err);
      send("error", { message: describeApiError(err) });
    }
  } finally {
    res.end();
  }
});

// JSON schema for a generated quiz (used with structured outputs).
const QUIZ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "questions"],
  properties: {
    title: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "options", "answerIndex", "explanation", "concept"],
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answerIndex: { type: "integer" },
          explanation: { type: "string" },
          concept: { type: "string" },
        },
      },
    },
  },
};

app.post("/api/quiz", async (req, res) => {
  const { topic = "", materialIds, count = 5, difficulty = "medium", level = "intermediate" } = req.body || {};
  const mats = selectedMaterials(materialIds);
  const n = Math.min(Math.max(Number(count) || 5, 1), 15);
  if (!String(topic).trim() && !mats.length) {
    return res.status(400).json({ error: "Give a topic or select some study material." });
  }

  const instructions = [
    `Write a ${difficulty}-difficulty multiple-choice quiz with exactly ${n} questions.`,
    String(topic).trim() ? `Topic: ${String(topic).trim()}` : "Cover the most important ideas in the attached material.",
    mats.length ? "Base every question on the attached material." : "",
    LEVEL_HINTS[level] || LEVEL_HINTS.intermediate,
    "Each question has exactly 4 options, one of them correct; answerIndex is the 0-based index of the correct option.",
    "Vary the position of the correct answer. Make wrong options plausible, testing common misconceptions rather than being obviously wrong.",
    "The explanation says why the correct answer is right and why the most tempting wrong option is wrong, in 1-3 sentences.",
    "concept is a short (1-4 word) label for the idea each question tests.",
    "Write math in LaTeX between $...$.",
  ]
    .filter(Boolean)
    .join("\n");

  const content = [...mats.map(materialBlock), { type: "text", text: instructions }];

  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      ...FALLBACK,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: QUIZ_SCHEMA } },
      system: "You are an expert teacher who writes clear, fair, well-explained quiz questions.",
      messages: [{ role: "user", content }],
    });
    const final = await stream.finalMessage();

    if (final.stop_reason === "refusal") {
      return res.status(422).json({ error: "The tutor declined to write that quiz. Try a different topic." });
    }
    if (final.stop_reason === "max_tokens") {
      return res.status(502).json({ error: "The quiz was too long to finish. Try fewer questions." });
    }
    const text = final.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const quiz = JSON.parse(text);
    quiz.questions = (quiz.questions || []).filter(
      (q) => Array.isArray(q.options) && q.options.length >= 2 && q.answerIndex >= 0 && q.answerIndex < q.options.length,
    );
    if (!quiz.questions.length) throw new Error("The quiz came back empty.");
    res.json(quiz);
  } catch (err) {
    console.error("quiz error:", err);
    res.status(500).json({ error: describeApiError(err) });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `Files must be ${MAX_UPLOAD_MB} MB or smaller.` });
  }
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log(`Study Buddy running at http://localhost:${PORT}  (model: ${MODEL})`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log("Note: ANTHROPIC_API_KEY is not set. Set it (or run `ant auth login`) before chatting.");
  }
});
