import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const defaultModel = process.env.OPENAI_MODEL || "gpt-5.4-nano";
const port = Number(process.env.PORT || 5173);
const allowedModels = new Set(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5-nano"]);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function modelFrom(value) {
  return allowedModels.has(value) ? value : defaultModel;
}

function extractOutputText(responseJson) {
  if (responseJson.output_text) return responseJson.output_text;
  const parts = [];
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n");
}

async function callOpenAI({ apiKey, model, system, userText, imageDataUrl, imageDetail = "high", reasoningEffort, schema }) {
  const content = [{ type: "input_text", text: userText }];
  if (imageDataUrl) content.push({ type: "input_image", image_url: imageDataUrl, detail: imageDetail });

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content }
      ],
      text: {
        format: {
          type: "json_schema",
          name: schema.name,
          strict: true,
          schema: schema.schema
        }
      }
    })
  });

  const responseJson = await response.json();
  if (!response.ok) throw new Error(responseJson.error?.message || `OpenAI request failed with ${response.status}`);
  const output = extractOutputText(responseJson);
  if (!output) throw new Error("The model returned no structured output.");
  return JSON.parse(output);
}

function fastReasoningEffort(model) {
  return model === "gpt-5-nano" ? "minimal" : "none";
}

const entitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "evidence"],
  properties: {
    name: { type: "string" },
    evidence: { type: "string" }
  }
};

function extractionSchema(objectCount) {
  return {
    name: "scene_inventory",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["objects"],
      properties: {
        objects: {
          type: "array",
          minItems: objectCount,
          maxItems: objectCount,
          items: entitySchema
        }
      }
    }
  };
}

function presenceSchema(candidateCount) {
  return {
    name: "object_presence",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["presence"],
      properties: {
        presence: {
          type: "array",
          minItems: candidateCount,
          maxItems: candidateCount,
          items: { type: "string", enum: ["y", "n"] }
        }
      }
    }
  };
}

const fastGroupingSchema = {
  name: "fast_object_groups",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["victims", "riskObjects"],
    properties: {
      victims: { type: "array", items: { type: "string" } },
      riskObjects: { type: "array", items: { type: "string" } }
    }
  }
};

const groupingSchema = {
  name: "object_groups",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["victims", "riskObjects"],
    properties: {
      victims: { type: "array", items: entitySchema },
      riskObjects: { type: "array", items: entitySchema }
    }
  }
};

const scoringSchema = {
  name: "pair_risk_scores",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["victimResults"],
    properties: {
      victimResults: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["victim", "rationale", "objectRisks"],
          properties: {
            victim: { type: "string" },
            rationale: { type: "string" },
            objectRisks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["object", "riskScore", "rationale"],
                properties: {
                  object: { type: "string" },
                  riskScore: { type: "number", minimum: 0, maximum: 1 },
                  rationale: { type: "string" }
                }
              }
            }
          }
        }
      }
    }
  }
};

function fastScoringSchema(victimCount, objectCount) {
  return {
    name: "fast_pair_scores",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scores"],
      properties: {
        scores: {
          type: "array",
          minItems: victimCount,
          maxItems: victimCount,
          items: {
            type: "array",
            minItems: objectCount,
            maxItems: objectCount,
            items: { type: "number", minimum: 0, maximum: 1 }
          }
        }
      }
    }
  };
}

function riskLevel(score) {
  if (score >= 0.67) return "high";
  if (score >= 0.34) return "medium";
  return "low";
}

function normalizeGroups(grouping, objects) {
  const victimDetails = new Map((grouping.victims || []).map((item) => [item.name.toLowerCase(), item]));
  const victims = objects
    .filter((item) => victimDetails.has(item.name.toLowerCase()))
    .map((item) => ({ ...item, ...victimDetails.get(item.name.toLowerCase()), name: item.name }));
  const victimNames = new Set(victims.map((item) => item.name.toLowerCase()));
  const riskDetails = new Map((grouping.riskObjects || []).map((item) => [item.name.toLowerCase(), item]));
  const riskObjects = objects
    .filter((item) => !victimNames.has(item.name.toLowerCase()))
    .map((item) => ({ ...item, ...riskDetails.get(item.name.toLowerCase()), name: item.name }));
  return { victims, riskObjects };
}

function normalizeScores(scoring, victims, riskObjects) {
  if (!victims.length) return { overallRiskScore: 0, victimResults: [] };

  const resultByVictim = new Map((scoring.victimResults || []).map((item) => [item.victim.toLowerCase(), item]));
  const victimResults = victims.map((victim) => {
    const result = resultByVictim.get(victim.name.toLowerCase()) || {};
    const pairByObject = new Map((result.objectRisks || []).map((item) => [item.object.toLowerCase(), item]));
    const objectRisks = riskObjects.map((object) => {
      const pair = pairByObject.get(object.name.toLowerCase());
      const riskScore = Math.max(0, Math.min(1, Number(pair?.riskScore || 0)));
      return {
        object: object.name,
        riskScore,
        riskLevel: riskLevel(riskScore),
        rationale: pair?.rationale || "No risk evidence identified for this pair."
      };
    });
    const riskScore = Math.max(...objectRisks.map((item) => item.riskScore), 0);
    return {
      victim: victim.name,
      riskScore,
      riskLevel: riskLevel(riskScore),
      rationale: result.rationale || "Risk reflects the highest-scoring object interaction.",
      objectRisks
    };
  });

  return {
    overallRiskScore: Math.max(...victimResults.map((item) => item.riskScore), 0),
    victimResults
  };
}

function scoringFromMatrix(matrix, victims, riskObjects) {
  return {
    victimResults: victims.map((victim, victimIndex) => ({
      victim: victim.name,
      rationale: "",
      objectRisks: riskObjects.map((object, objectIndex) => ({
        object: object.name,
        riskScore: Number(matrix?.[victimIndex]?.[objectIndex] || 0),
        rationale: ""
      }))
    }))
  };
}

async function extractObjects(req, res) {
  const { apiKey: providedApiKey, imageDataUrl, objectCount: requestedCount, candidates: requestedCandidates = [], model: requestedModel, fast = false } = await readBody(req);
  const objectCount = Math.max(2, Math.min(20, Number(requestedCount) || 10));
  const candidates = [...new Set(
    requestedCandidates.map((item) => String(item).trim()).filter(Boolean)
  )].slice(0, 50);
  const model = modelFrom(requestedModel);
  const apiKey = String(providedApiKey || "").trim();
  if (!imageDataUrl) return sendJson(res, 400, { error: "Missing image data. Please upload the image again." });
  if (fast && !candidates.length) return sendJson(res, 400, { error: "Fast mode requires at least one candidate object." });
  if (!apiKey) return sendJson(res, 401, { error: "Enter an OpenAI API key." });

  const extraction = await callOpenAI({
    apiKey,
    model,
    imageDataUrl,
    imageDetail: fast ? "low" : "high",
    reasoningEffort: fast ? fastReasoningEffort(model) : undefined,
    schema: fast ? presenceSchema(candidates.length) : extractionSchema(objectCount),
    system: fast
      ? "Classify whether each named object is visible in the image."
      : "Inventory visible physical entities in an image. Use unique one or two-word names and brief evidence describing appearance, position, or proximity.",
    userText: fast
      ? `Candidates in order: ${JSON.stringify(candidates)}\nReturn one lowercase y or n for each candidate in the same order. No explanations.`
      : `Return exactly ${objectCount} distinct visible entities. Include people, animals, small loose items, furniture, containers, surfaces, and room features. Inspect the whole image and never return an empty list.`
  });
  const objects = fast
    ? candidates
        .filter((_, index) => extraction.presence[index] === "y")
        .map((name) => ({ name, evidence: "" }))
    : extraction.objects.slice(0, objectCount);
  sendJson(res, 200, { objects, model, mock: false });
}

async function groupObjects(req, res) {
  const { apiKey: providedApiKey, riskDescription, objects = [], model: requestedModel, fast = false } = await readBody(req);
  const model = modelFrom(requestedModel);
  if (!objects.length) return sendJson(res, 200, { victims: [], riskObjects: [], model, mock: false });
  const apiKey = String(providedApiKey || "").trim();
  if (!apiKey) return sendJson(res, 401, { error: "Enter an OpenAI API key." });

  const grouping = await callOpenAI({
    apiKey,
    model,
    reasoningEffort: fast ? fastReasoningEffort(model) : undefined,
    schema: fast ? fastGroupingSchema : groupingSchema,
    system: "Partition extracted entities for a risk. A victim is the entity that would suffer harm, not the hazard source. Victims may be people, animals, robots, objects, or materials, and may be empty.",
    userText: fast
      ? `Risk: ${riskDescription}\nNames: ${JSON.stringify(objects.map((item) => item.name))}\nReturn exact names in victims or riskObjects. Choking: child=victim, coin=object. Fire: paper or wooden furniture may be victims. No explanations.`
      : `Risk: ${riskDescription}\nEntities: ${JSON.stringify(objects)}\nPut every entity exactly once in victims or riskObjects. For choking, a child is a victim and a coin is an object. For fire, paper or wooden furniture can be victims. Use exact names and brief evidence.`
  });
  const normalizedGrouping = fast
    ? {
        victims: grouping.victims.map((name) => ({ name, evidence: "" })),
        riskObjects: grouping.riskObjects.map((name) => ({ name, evidence: "" }))
      }
    : grouping;
  sendJson(res, 200, { ...normalizeGroups(normalizedGrouping, objects), model, mock: false });
}

async function scoreRisk(req, res) {
  const { apiKey: providedApiKey, riskDescription, victims = [], riskObjects = [], model: requestedModel, fast = false } = await readBody(req);
  const model = modelFrom(requestedModel);
  if (!victims.length) return sendJson(res, 200, { overallRiskScore: 0, victimResults: [], model, mock: false });
  const apiKey = String(providedApiKey || "").trim();
  if (!apiKey) return sendJson(res, 401, { error: "Enter an OpenAI API key." });

  const scoring = await callOpenAI({
    apiKey,
    model,
    reasoningEffort: fast ? fastReasoningEffort(model) : undefined,
    schema: fast ? fastScoringSchema(victims.length, riskObjects.length) : scoringSchema,
    system: fast
      ? "Return only a 0-to-1 risk score for each victim-object pair."
      : "Estimate risk for every supplied victim-object pair using only the stated risk and image-grounded entity evidence. Scores range from 0 to 1.",
    userText: fast
      ? `Risk: ${riskDescription}\nVictims: ${JSON.stringify(victims.map((item) => item.name))}\nObjects: ${JSON.stringify(riskObjects.map((item) => item.name))}\nReturn a score matrix in this exact order. No explanations.`
      : `Risk: ${riskDescription}\nVictims: ${JSON.stringify(victims)}\nObjects: ${JSON.stringify(riskObjects)}\nReturn every victim exactly once and score it against every object. Use exact names and brief rationales.`
  });
  const normalizedScoring = fast ? scoringFromMatrix(scoring.scores, victims, riskObjects) : scoring;
  sendJson(res, 200, { ...normalizeScores(normalizedScoring, victims, riskObjects), model, mock: false });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/extract-objects") return await extractObjects(req, res);
    if (req.method === "POST" && req.url === "/api/group-objects") return await groupObjects(req, res);
    if (req.method === "POST" && req.url === "/api/score-risk") return await scoreRisk(req, res);
    if (req.method === "GET") return await serveStatic(req, res);
    res.writeHead(405);
    res.end("Method not allowed");
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Object-centric risk demo running at http://127.0.0.1:${port}`);
  console.log(`Default model: ${defaultModel}`);
});
