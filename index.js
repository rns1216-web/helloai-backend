// index.js — HelloAI Backend (Full Working Version + Agent Smith + Evidence Search)

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { OpenAI } = require("openai");

// Load .env variables
dotenv.config();

// Ensure API key exists
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --------------------------------------------------
// HELPERS (Evidence Search)
// --------------------------------------------------

function safeString(x) {
  return typeof x === "string" ? x : "";
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function decodeHtmlEntities(str) {
  return safeString(str)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function stripTags(str) {
  return safeString(str).replace(/<[^>]*>/g, "").trim();
}

// Very simple credibility heuristic (Phase 3b-ready; replace later)
function credibilityScoreFor(url, source) {
  const d = (extractDomain(url) || "").toLowerCase();
  const s = (safeString(source) || "").toLowerCase();

  // High-ish credibility defaults for well-known domains/sources
  const high = [
    "reuters.com",
    "apnews.com",
    "bbc.co.uk",
    "bbc.com",
    "ft.com",
    "wsj.com",
    "economist.com",
    "investopedia.com",
    "sec.gov",
    "federalreserve.gov",
    "bls.gov",
    "whitehouse.gov",
    "cdc.gov",
    "nih.gov",
    "who.int",
    "oecd.org",
    "worldbank.org",
    "imf.org",
    "nber.org",
    "nature.com",
    "science.org"
  ];

  const mid = [
    "wikipedia.org",
    "nerdwallet.com",
    "bankrate.com",
    "morningstar.com",
    "khanacademy.org"
  ];

  if (high.includes(d)) return 86;
  if (mid.includes(d)) return 78;

  // if we at least have a real domain, give a neutral mid score
  if (d) return 72;

  // unknown
  return 60;
}

// Pull top DDG results from HTML (no API key).
// NOTE: DDG HTML markup can change; this is intentionally defensive.
function parseDuckDuckGoHtml(html) {
  const out = [];
  const text = safeString(html);

  // Match blocks that contain result links and snippets
  // We try to capture:
  // - href from <a class="result__a" href="...">
  // - inner text of that anchor (title)
  // - snippet from <a class="result__snippet"> or <div class="result__snippet">
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/g;

  const links = [];
  let m;
  while ((m = linkRegex.exec(text)) !== null) {
    const href = decodeHtmlEntities(m[1]);
    const titleHtml = m[2];
    const title = decodeHtmlEntities(stripTags(titleHtml));
    if (href && title) links.push({ href, title });
    if (links.length >= 10) break;
  }

  const snippets = [];
  let s;
  while ((s = snippetRegex.exec(text)) !== null) {
    const sn = decodeHtmlEntities(stripTags(s[1] || s[2] || ""));
    if (sn) snippets.push(sn);
    if (snippets.length >= 10) break;
  }

  // Pair by index (best-effort)
  for (let i = 0; i < links.length; i++) {
    const url = links[i].href;
    const title = links[i].title;
    const domain = extractDomain(url);
    const snippet = snippets[i] || "No snippet available.";
    out.push({
      title,
      url,
      domain,
      snippet
    });
  }

  return out;
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "HelloAI backend is running 🚀" });
});

// --------------------------------------------------
// MINI-BRAIN GENERATE ENDPOINT (MAIN ENDPOINT)
// --------------------------------------------------
app.post("/generate", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing 'prompt' in request body." });
    }

    console.log("📩 Incoming prompt:", prompt.substring(0, 200) + "...");

    // Call OpenAI
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are Hello AI's smart assistant engine." },
        { role: "user", content: prompt }
      ]
    });

    const output = completion.choices?.[0]?.message?.content || "";

    console.log("📤 Output length:", output.length);

    return res.json({ result: output });

  } catch (err) {
    console.error("❌ /generate failed:", err);
    return res.status(500).json({ error: "AI generation failed", details: err.message });
  }
});

// --------------------------------------------------
// AGENT SMITH ENDPOINT (NEW)
// Expects: { prompt: string }
// Returns: strict JSON matching AgentSmithScreen parser
// --------------------------------------------------
app.post("/agent_smith", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({
        error: true,
        message: "Missing 'prompt' in request body."
      });
    }

    console.log("🕵️ /agent_smith prompt head:", prompt.substring(0, 200) + "...");

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      messages: [
        // IMPORTANT: your Android sends a fully-built contract in prompt,
        // so keep this role simple and non-conflicting.
        { role: "system", content: "Return ONLY valid JSON. No markdown. No extra text." },
        { role: "user", content: prompt }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    console.log("🧾 /agent_smith raw length:", raw.length);

    // Try parse JSON (model should output strict JSON)
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Safe fallback JSON for the app
      parsed = {
        answer: [raw || "Model returned empty output."],
        evidence: [],
        assumptionsAndUnknowns: ["Model did not return valid JSON."],
        warnings: ["Schema violation: non-JSON response."],
        confidence: 40,
        stoplight: "YELLOW",
        violationTags: ["SchemaViolation"],
        attemptsUsed: 1
      };
    }

    // Minimal normalization (protect Android parser)
    if (!Array.isArray(parsed.answer)) parsed.answer = [String(parsed.answer || "No answer.")];
    if (!Array.isArray(parsed.evidence)) parsed.evidence = [];
    if (!Array.isArray(parsed.assumptionsAndUnknowns)) parsed.assumptionsAndUnknowns = [];
    if (!Array.isArray(parsed.warnings)) parsed.warnings = [];
    if (typeof parsed.confidence !== "number") parsed.confidence = 60;
    if (!parsed.stoplight) parsed.stoplight = "YELLOW";
    if (!Array.isArray(parsed.violationTags)) parsed.violationTags = [];
    if (typeof parsed.attemptsUsed !== "number") parsed.attemptsUsed = 1;

    // Ensure stoplight is one of GREEN/YELLOW/RED
    const s = String(parsed.stoplight).toUpperCase();
    parsed.stoplight = s === "GREEN" || s === "RED" ? s : "YELLOW";

    return res.json(parsed);

  } catch (err) {
    console.error("❌ /agent_smith failed:", err);
    return res.status(500).json({
      error: true,
      message: "Agent Smith generation failed",
      details: err.message
    });
  }
});

// --------------------------------------------------
// EVIDENCE SEARCH ENDPOINT (NEW)
// Expects: { query: string }
// Returns: { results: EvidenceItem[] }
// Evidence is independent of Agent Smith answers.
// --------------------------------------------------
app.post("/evidence_search", async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== "string") {
      return res.status(400).json({
        error: true,
        message: "Missing 'query' in request body."
      });
    }

    const q = query.trim();
    console.log("🔎 /evidence_search query:", q);

    // DuckDuckGo HTML results (no API key)
    const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;

    const resp = await fetch(ddgUrl, {
      method: "GET",
      headers: {
        // simple UA to reduce bot-blocking
        "User-Agent": "HelloAI-EvidenceBot/1.0"
      }
    });

    if (!resp.ok) {
      console.error("❌ DDG fetch failed:", resp.status, resp.statusText);
      return res.json({ results: [] });
    }

    const html = await resp.text();
    const parsed = parseDuckDuckGoHtml(html).slice(0, 3);

    const results = parsed.map((r) => {
      const source = r.domain ? r.domain.split(".").slice(-2).join(".") : null; // fallback source
      return {
        title: r.title,
        source: source,
        date: null, // DDG doesn’t reliably provide dates; Phase 3b can enrich later
        url: r.url,
        snippet: r.snippet,
        credibilityScore: credibilityScoreFor(r.url, source)
      };
    });

    return res.json({ results });

  } catch (err) {
    console.error("❌ /evidence_search failed:", err);
    return res.status(500).json({
      error: true,
      message: "Evidence search failed",
      details: err.message
    });
  }
});

// --------------------------------------------------
// TEMP TEST ROUTE (SAFE TO KEEP)
// --------------------------------------------------
app.post("/test", (req, res) => {
  res.json({
    received: req.body || {},
    message: "Test route working!"
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ HelloAI server listening on port ${PORT}`);
});
