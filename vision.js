// ---------- Computer vision: classify a photo of an infrastructure issue ----------
// We send the photo to Google's Gemini model and ask it to answer with JSON
// that matches a fixed list of categories. The key and model name come from
// config.js (CONFIG.GEMINI_KEY, CONFIG.GEMINI_MODEL).

// The issue types we support. "severity" is a starting weight a route scorer
// can use later; "night" marks issues that matter more after dark.
const ISSUE_CATEGORIES = {
  pothole:          { label: "Pothole / damaged pavement",  icon: "🕳️", severity: 3, night: false },
  unpaved_road:     { label: "Unpaved or dirt path",        icon: "🟫", severity: 2, night: false },
  broken_signal:    { label: "Broken traffic / crosswalk light", icon: "🚦", severity: 3, night: false },
  lighting:         { label: "Broken streetlight / poor lighting", icon: "💡", severity: 2, night: true },
  construction:     { label: "Construction",                 icon: "🚧", severity: 2, night: false },
  obstruction:      { label: "Trash / obstruction",          icon: "🗑️", severity: 2, night: false },
  none:             { label: "No issue detected",            icon: "✅", severity: 0, night: false },
};

const SEVERITY_LEVELS = ["low", "medium", "high"];

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// Instructions for the model. We keep it to things a camera can actually see.
const VISION_PROMPT = `You review photos submitted to a pedestrian safety app.
Classify the main pedestrian or road infrastructure problem visible in the photo.
Categories:
- pothole: potholes, cracked, broken or uneven pavement or sidewalk, trip hazards
- unpaved_road: dirt, gravel or unpaved road or path where pavement is expected
- broken_signal: broken, dark or damaged traffic light or pedestrian crossing signal
- lighting: broken or unlit streetlight, or a walkway that is clearly too dark
- construction: construction work, cones, barriers, scaffolding, closed sidewalk
- obstruction: trash, debris, dumped items, vehicles or objects blocking the path
- none: no infrastructure problem is visible, or the photo is unrelated
Severity: "high" if it could injure someone or forces pedestrians into the road,
"medium" if it makes walking noticeably harder, "low" if it is minor.
Only describe what is visible. Do not guess about people, crime, or intent.
Give a conservative confidence from 0 to 1 and a one-sentence description.`;

// Gemini's structured-output schema: forces the reply into this exact shape.
const VISION_SCHEMA = {
  type: "OBJECT",
  properties: {
    category:    { type: "STRING", enum: Object.keys(ISSUE_CATEGORIES) },
    severity:    { type: "STRING", enum: SEVERITY_LEVELS },
    confidence:  { type: "NUMBER" },
    description: { type: "STRING" },
  },
  required: ["category", "severity", "confidence", "description"],
};

// Send a resized JPEG (as a data URL) to Gemini and return
// { category, severity, confidence, description }.
async function classifyImage(dataUrl) {
  if (!CONFIG.GEMINI_KEY) {
    throw new Error("Add GEMINI_KEY to config.js (get a free key at aistudio.google.com).");
  }
  const model = CONFIG.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const [header, base64] = dataUrl.split(",");
  const mimeType = header.match(/data:(.*);base64/)[1];

  const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": CONFIG.GEMINI_KEY },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: VISION_PROMPT },
          { inline_data: { mime_type: mimeType, data: base64 } },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: VISION_SCHEMA,
        temperature: 0,
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini returned HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();

  // The JSON answer comes back as text inside the first candidate.
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini gave no answer (the image may have been blocked).");
  const result = JSON.parse(text);

  // Never trust the reply blindly: clamp it back into our allowed values.
  return {
    category: ISSUE_CATEGORIES[result.category] ? result.category : "none",
    severity: SEVERITY_LEVELS.includes(result.severity) ? result.severity : "medium",
    confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
    description: String(result.description || "").slice(0, 300),
  };
}

// Shrink a photo before uploading. Phone photos are often 5+ MB; the model
// does not need that much detail, and smaller uploads are faster.
function resizeImage(file, maxSize = 1024, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file could not be read as an image."));
    };
    img.src = url;
  });
}
