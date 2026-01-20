// index.js — HelloAI Backend (Full Working Version + Agent Smith)

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
