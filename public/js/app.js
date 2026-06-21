const state = {
  imageDataUrl: null,
  objects: [],
  victims: [],
  riskObjects: [],
  overallRiskScore: 0,
  victimResults: [],
  complete: false
};

const els = {
  apiKey: document.querySelector("#apiKey"),
  riskDescription: document.querySelector("#riskDescription"),
  objectCount: document.querySelector("#objectCount"),
  objectCountValue: document.querySelector("#objectCountValue"),
  objectCountRow: document.querySelector("#objectCountRow"),
  fastCandidatesRow: document.querySelector("#fastCandidatesRow"),
  fastObjectCandidates: document.querySelector("#fastObjectCandidates"),
  modelSelect: document.querySelector("#modelSelect"),
  fastMode: document.querySelector("#fastMode"),
  showFinalImage: document.querySelector("#showFinalImage"),
  riskThreshold: document.querySelector("#riskThreshold"),
  riskThresholdValue: document.querySelector("#riskThresholdValue"),
  thresholdRow: document.querySelector("#thresholdRow"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  backBtn: document.querySelector("#backBtn"),
  imageInput: document.querySelector("#imageInput"),
  previewImage: document.querySelector("#previewImage"),
  status: document.querySelector("#status"),
  runningIndicator: document.querySelector("#runningIndicator"),
  inputStage: document.querySelector("#inputStage"),
  analysisStage: document.querySelector("#analysisStage"),
  extractPanel: document.querySelector("#extractPanel"),
  groupPanel: document.querySelector("#groupPanel"),
  riskPanel: document.querySelector("#riskPanel"),
  finalImagePanel: document.querySelector("#finalImagePanel"),
  annotatedImage: document.querySelector("#annotatedImage"),
  stepPills: ["One", "Two", "Three", "Four"].map((name) => document.querySelector(`#step${name}Pill`)),
  objectsView: document.querySelector("#objectsView"),
  victimsView: document.querySelector("#victimsView"),
  riskObjectsView: document.querySelector("#riskObjectsView"),
  scoresView: document.querySelector("#scoresView"),
  overallScore: document.querySelector("#overallScore")
};

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("Could not read the image.")));
    reader.readAsDataURL(file);
  });
}

async function loadDefaultImage() {
  const response = await fetch("assets/baby.png");
  if (!response.ok) throw new Error("Could not load assets/baby.png.");
  state.imageDataUrl = await fileToDataUrl(await response.blob());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function percent(value) {
  return `${Math.round(Math.max(0, Math.min(1, Number(value || 0))) * 100)}%`;
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.style.color = isError ? "#b91c1c" : "";
}

function setProgress(message = "", isError = false) {
  const visible = Boolean(message);
  els.runningIndicator.hidden = !visible;
  els.runningIndicator.classList.toggle("hidden", !visible);
  els.runningIndicator.classList.toggle("error", isError);
  els.runningIndicator.textContent = message;
}

function setRunning(isRunning) {
  els.analyzeBtn.disabled = isRunning;
  els.backBtn.disabled = isRunning;
  els.analyzeBtn.textContent = isRunning ? "running..." : "Analyze";
}

function show(element, visible) {
  element.hidden = !visible;
  element.classList.toggle("hidden", !visible);
}

function setStep(step) {
  show(els.inputStage, step === 1);
  show(els.analysisStage, step > 1);
  show(els.extractPanel, step >= 2);
  show(els.groupPanel, step >= 3);
  show(els.riskPanel, step >= 4);
  show(els.finalImagePanel, step >= 4 && state.complete && els.showFinalImage.checked);
  els.stepPills.forEach((pill, index) => {
    pill.classList.toggle("active", index + 1 === step);
    pill.classList.toggle("complete", index + 1 < step);
  });
}

function loadingState(message) {
  return `<div class="stage-loading"><span class="loading-dot"></span>${escapeHtml(message)}</div>`;
}

function candidateObjects() {
  return [...new Set(
    els.fastObjectCandidates.value
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  )].slice(0, 50);
}

function updateFastControls() {
  show(els.objectCountRow, !els.fastMode.checked);
  show(els.fastCandidatesRow, els.fastMode.checked);
}

function renderEntityList(container, entities, emptyMessage) {
  if (!entities?.length) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
    return;
  }
  container.innerHTML = entities
    .map(
      (entity) => `
        <div class="object-card">
          <strong>${escapeHtml(entity.name)}</strong>
          ${entity.evidence ? `<span>${escapeHtml(entity.evidence)}</span>` : ""}
        </div>`
    )
    .join("");
}

function renderScores() {
  els.overallScore.textContent = `Overall risk: ${percent(state.overallRiskScore)}`;
  if (!state.victimResults.length) {
    els.scoresView.innerHTML = `
      <div class="zero-risk-state">
        <strong>No victims detected</strong>
        <span>Risk is 0 because the image contains no entity that can be harmed by this risk.</span>
      </div>`;
    return;
  }

  els.scoresView.innerHTML = state.victimResults
    .map(
      (result) => `
        <section class="score-card">
          <div class="score-head">
            <div>
              <span class="victim-label">Victim</span>
              <h3>${escapeHtml(result.victim)}</h3>
            </div>
            <div class="score-badge ${escapeHtml(result.riskLevel)}">${escapeHtml(result.riskLevel)} · ${percent(result.riskScore)}</div>
          </div>
          <div class="meter" aria-label="Risk score ${percent(result.riskScore)}"><span style="width: ${percent(result.riskScore)}"></span></div>
          ${els.fastMode.checked ? "" : `<p class="rationale">${escapeHtml(result.rationale)}</p>`}
          <div class="object-score-table">
            ${(result.objectRisks || [])
              .map(
                (pair) => `
                  <div class="pair-score-row">
                    <div>
                      <strong>${escapeHtml(pair.object)}</strong>
                      ${els.fastMode.checked || !pair.rationale ? "" : `<span>${escapeHtml(pair.rationale)}</span>`}
                    </div>
                    <div class="pair-score ${escapeHtml(pair.riskLevel)}">${percent(pair.riskScore)}</div>
                  </div>`
              )
              .join("")}
          </div>
        </section>`
    )
    .join("");
}

function topRiskPair() {
  let top = null;
  for (const result of state.victimResults) {
    for (const pair of result.objectRisks || []) {
      if (!top || pair.riskScore > top.riskScore) {
        top = { victim: result.victim, object: pair.object, riskScore: Number(pair.riskScore || 0) };
      }
    }
  }
  return top;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not render the final image."));
    image.src = src;
  });
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function fitText(context, text, maxWidth) {
  if (context.measureText(text).width <= maxWidth) return text;
  let shortened = text;
  while (shortened.length > 3 && context.measureText(`${shortened}...`).width > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened}...`;
}

async function renderFinalImage() {
  if (!els.showFinalImage.checked || !state.complete) {
    show(els.finalImagePanel, false);
    return;
  }

  const source = await loadImage(state.imageDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0);

  const top = topRiskPair();
  const threshold = Number(els.riskThreshold.value);
  const isRisk = Boolean(top && top.riskScore >= threshold);
  const margin = Math.max(20, Math.round(canvas.width * 0.025));
  const boxHeight = Math.max(105, Math.round(canvas.height * 0.16));
  const boxY = margin;
  roundedRect(context, margin, boxY, canvas.width - margin * 2, boxHeight, Math.max(14, canvas.width * 0.012));
  context.fillStyle = isRisk ? "rgba(153, 27, 27, 0.93)" : "rgba(21, 128, 61, 0.93)";
  context.fill();

  const headingSize = Math.max(24, Math.round(canvas.width * 0.025));
  const detailSize = Math.max(18, Math.round(canvas.width * 0.016));
  const textX = margin + Math.max(22, Math.round(canvas.width * 0.018));
  const textWidth = canvas.width - textX - margin - 24;
  context.fillStyle = "#ffffff";
  context.font = `800 ${headingSize}px Inter, Arial, sans-serif`;
  context.textBaseline = "top";

  if (isRisk) {
    context.fillText(`TOP RISK  ${percent(top.riskScore)}`, textX, boxY + boxHeight * 0.2);
    context.font = `600 ${detailSize}px Inter, Arial, sans-serif`;
    const detail = `Victim: ${top.victim}   |   Risk object: ${top.object}`;
    context.fillText(fitText(context, detail, textWidth), textX, boxY + boxHeight * 0.6);
  } else {
    context.fillText("NO RISK", textX, boxY + boxHeight * 0.34);
  }

  els.annotatedImage.src = canvas.toDataURL("image/png");
  show(els.finalImagePanel, true);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function resetResults() {
  state.objects = [];
  state.victims = [];
  state.riskObjects = [];
  state.overallRiskScore = 0;
  state.victimResults = [];
  state.complete = false;
  els.objectsView.innerHTML = loadingState("Extracting visible objects...");
  els.victimsView.innerHTML = "";
  els.riskObjectsView.innerHTML = "";
  els.scoresView.innerHTML = "";
  els.annotatedImage.removeAttribute("src");
  show(els.finalImagePanel, false);
}

async function analyzeImage() {
  if (!state.imageDataUrl) {
    setStatus("Please wait for the image to load or upload it again.", true);
    return;
  }

  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setStatus("Enter an OpenAI API key above before analyzing.", true);
    els.apiKey.focus();
    return;
  }

  const shared = {
    apiKey,
    riskDescription: els.riskDescription.value.trim(),
    model: els.modelSelect.value,
    fast: els.fastMode.checked
  };
  const candidates = candidateObjects();
  if (shared.fast && !candidates.length) {
    setStatus("Enter at least one candidate object for Fast mode.", true);
    return;
  }
  resetResults();
  setRunning(true);
  setStep(2);
  setProgress("running: extracting objects...");

  try {
    const extraction = await postJson("/api/extract-objects", {
      imageDataUrl: state.imageDataUrl,
      objectCount: Number(els.objectCount.value),
      candidates,
      model: shared.model,
      fast: shared.fast,
      apiKey: shared.apiKey
    });
    state.objects = extraction.objects;
    renderEntityList(els.objectsView, state.objects, "No objects extracted.");

    setStep(3);
    setProgress("running: grouping victims and objects...");
    els.victimsView.innerHTML = loadingState("Identifying victims...");
    els.riskObjectsView.innerHTML = loadingState("Grouping remaining objects...");
    const grouping = await postJson("/api/group-objects", {
      ...shared,
      objects: state.objects
    });
    state.victims = grouping.victims;
    state.riskObjects = grouping.riskObjects;
    renderEntityList(els.victimsView, state.victims, "No victims detected.");
    renderEntityList(els.riskObjectsView, state.riskObjects, "No objects detected.");

    setStep(4);
    setProgress("running: scoring victim-object pairs...");
    els.scoresView.innerHTML = loadingState("Computing pairwise risk scores...");
    const scoring = await postJson("/api/score-risk", {
      ...shared,
      victims: state.victims,
      riskObjects: state.riskObjects
    });
    state.overallRiskScore = scoring.overallRiskScore;
    state.victimResults = scoring.victimResults;
    renderScores();
    state.complete = true;
    if (els.showFinalImage.checked) {
      setProgress("rendering final image...");
      await renderFinalImage();
    }
    setStep(4);
    setProgress("");
  } catch (error) {
    setProgress(`Analysis stopped: ${error.message}`, true);
  } finally {
    setRunning(false);
  }
}

function bindControls() {
  els.objectCount.addEventListener("input", () => {
    els.objectCountValue.textContent = els.objectCount.value;
  });
  els.fastMode.addEventListener("change", updateFastControls);
  els.riskThreshold.addEventListener("input", async () => {
    els.riskThresholdValue.textContent = Number(els.riskThreshold.value).toFixed(2);
    if (state.complete && els.showFinalImage.checked) await renderFinalImage();
  });
  els.showFinalImage.addEventListener("change", async () => {
    els.riskThreshold.disabled = !els.showFinalImage.checked;
    els.thresholdRow.classList.toggle("disabled", !els.showFinalImage.checked);
    if (state.complete && els.showFinalImage.checked) await renderFinalImage();
    else show(els.finalImagePanel, false);
  });
  els.analyzeBtn.addEventListener("click", analyzeImage);
  els.backBtn.addEventListener("click", () => {
    setProgress("");
    setStep(1);
    setStatus("Adjust the inputs, then analyze again.");
  });
  els.imageInput.addEventListener("change", async () => {
    const file = els.imageInput.files?.[0];
    if (!file) return;
    try {
      state.imageDataUrl = await fileToDataUrl(file);
      els.previewImage.src = state.imageDataUrl;
      state.complete = false;
      show(els.finalImagePanel, false);
      setStatus(`Loaded ${file.name} at its original resolution.`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });
}

try {
  await loadDefaultImage();
  setStatus("Ready with assets/baby.png. Upload another image or click Analyze.");
} catch (error) {
  setStatus(error.message, true);
}
bindControls();
updateFastControls();
els.riskThreshold.disabled = !els.showFinalImage.checked;
els.thresholdRow.classList.toggle("disabled", !els.showFinalImage.checked);
setStep(1);
