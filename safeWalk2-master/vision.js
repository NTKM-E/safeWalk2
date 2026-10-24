// ---------- Computer vision: suggest an incident type from a photo ----------
// We send the photo to Google's Gemini model and ask it to answer with JSON
// that picks one of our incident types. The key and model name come from
// config.js (CONFIG.GEMINI_KEY, CONFIG.GEMINI_MODEL).
// The type keys must match INCIDENT_TYPES in incidents.js (and the database).

// What each type looks like, in words the model can match against the photo.
// "none" is only for the AI: it means "this photo shows no problem".
const AI_TYPE_HINTS = {
  pothole:                 "potholes, cracked, broken or uneven pavement or sidewalk, trip hazards",
  unpaved_surface:         "dirt, gravel or unpaved road or path where pavement is expected",
  pedestrian_signal_issue: "broken, dark or damaged traffic light or pedestrian crossing signal",
  lighting:                "broken or unlit streetlight, or a walkway that is clearly too dark",
  construction:            "construction work, cones, barriers, scaffolding, closed sidewalk",
  trash:                   "litter, trash bags, dumped items or debris on the path",
  obstruction:             "vehicles, fallen trees or large objects blocking the path",
  other:                   "a pedestrian infrastructure problem that fits none of the above",
  none:                    "no infrastructure problem is visible, or the photo is unrelated",
};

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// Instructions for the model. We keep it to things a camera can actually see.
const VISION_PROMPT = `You review photos submitted to a pedestrian safety app.
Classify the main pedestrian or road infrastructure problem visible in the photo.
Types:
${Object.entries(AI_TYPE_HINTS).map(([key, hint]) => `- ${key}: ${hint}`).join("\n")}
Only describe what is visible. Do not guess about people, crime, or intent.
Give a conservative confidence from 0 to 1 and a one-sentence description.`;

// Gemini's structured-output schema: forces the reply into this exact shape.
const VISION_SCHEMA = {
  type: "OBJECT",
  properties: {
    type:        { type: "STRING", enum: Object.keys(AI_TYPE_HINTS) },
    confidence:  { type: "NUMBER" },
    description: { type: "STRING" },
  },
  required: ["type", "confidence", "description"],
};

// Is the AI set up? If not, the user just picks the type themselves.
function visionEnabled() {
  return Boolean(CONFIG.GEMINI_KEY);
}

// Retry temporary Gemini overloads/rate limits using exponential backoff.
// Three retries means at most four total requests (initial request + retries).
async function fetchGeminiWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, options);
    if (response.ok) return response;

    const retryable = [429, 500, 502, 503, 504].includes(response.status);
    if (!retryable || attempt >= maxRetries) {
      const detail = await response.text();
      throw new Error(`Gemini returned HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }

    // Wait approximately 1, 2, then 4 seconds, with small jitter.
    const delay = 1000 * (2 ** attempt) + Math.random() * 500;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

// Send a photo (a Blob, already shrunk) to Gemini and return
// { type, confidence, description }. `type` is one of AI_TYPE_HINTS' keys.
async function classifyImage(blob) {
  if (!visionEnabled()) throw new Error("Add GEMINI_KEY to config.js to enable AI suggestions.");
  const model = CONFIG.GEMINI_MODEL || "gemini-2.0-flash-lite";

  const res = await fetchGeminiWithRetry(`${GEMINI_URL}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": CONFIG.GEMINI_KEY },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: VISION_PROMPT },
          { inline_data: { mime_type: blob.type || "image/jpeg", data: await blobToBase64(blob) } },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: VISION_SCHEMA,
        temperature: 0,
      },
    }),
  });
  const data = await res.json();

  // The JSON answer comes back as text inside the first candidate.
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini gave no answer (the image may have been blocked).");
  const result = JSON.parse(text);

  // Never trust the reply blindly: clamp it back into our allowed values.
  return {
    type: AI_TYPE_HINTS[result.type] ? result.type : "other",
    confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
    description: String(result.description || "").slice(0, 300),
  };
}

// Gemini wants the image as plain base64 text (without the "data:...;base64," prefix).
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read the photo."));
    reader.readAsDataURL(blob);
  });
}