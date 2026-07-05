const state = {
  videoUrl: "assets/baby.MP4",
  videoName: "baby.MP4",
  frameResults: [],
  annotatedUrl: null,
  annotatedMime: "",
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
  showFrameDetails: document.querySelector("#showFrameDetails"),
  riskThreshold: document.querySelector("#riskThreshold"),
  riskThresholdValue: document.querySelector("#riskThresholdValue"),
  thresholdRow: document.querySelector("#thresholdRow"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  videoInput: document.querySelector("#videoInput"),
  previewVideo: document.querySelector("#previewVideo"),
  annotatedVideo: document.querySelector("#annotatedVideo"),
  downloadLink: document.querySelector("#downloadLink"),
  status: document.querySelector("#status"),
  runningIndicator: document.querySelector("#runningIndicator"),
  outputStage: document.querySelector("#outputStage"),
  framePanel: document.querySelector("#framePanel"),
  framesView: document.querySelector("#framesView"),
  overallScore: document.querySelector("#overallScore")
};

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
  els.videoInput.disabled = isRunning;
  els.analyzeBtn.textContent = isRunning ? "running..." : "Analyze Video";
}

function show(element, visible) {
  element.hidden = !visible;
  element.classList.toggle("hidden", !visible);
}

function updateFastControls() {
  show(els.objectCountRow, !els.fastMode.checked);
  show(els.fastCandidatesRow, els.fastMode.checked);
}

function candidateObjects() {
  return [...new Set(
    els.fastObjectCandidates.value
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  )].slice(0, 50);
}

function loadingState(message) {
  return `<div class="stage-loading"><span class="loading-dot"></span>${escapeHtml(message)}</div>`;
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

function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not read the selected video."));
    };
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

async function loadVideoElement(src, muted = true) {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = muted;
  video.playsInline = true;
  video.preload = "auto";
  video.src = src;
  await waitForEvent(video, "loadedmetadata");
  return video;
}

async function seekVideo(video, time) {
  const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.02));
  if (Math.abs(video.currentTime - target) < 0.02) return;
  video.currentTime = target;
  await waitForEvent(video, "seeked");
}

function canvasToDataUrl(canvas) {
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function extractFrameDataUrls(videoUrl) {
  const video = await loadVideoElement(videoUrl);
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  const duration = Math.max(1, Math.ceil(video.duration || 1));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const frames = [];

  for (let second = 0; second < duration; second += 1) {
    await seekVideo(video, second);
    context.drawImage(video, 0, 0, width, height);
    frames.push({ second, imageDataUrl: canvasToDataUrl(canvas) });
  }
  return { frames, width, height, duration: video.duration || duration };
}

function riskLevel(score) {
  if (score >= 0.67) return "high";
  if (score >= 0.34) return "medium";
  return "low";
}

function topRiskPair(victimResults) {
  let top = null;
  for (const result of victimResults || []) {
    for (const pair of result.objectRisks || []) {
      if (!top || pair.riskScore > top.riskScore) {
        top = {
          victim: result.victim,
          object: pair.object,
          riskScore: Number(pair.riskScore || 0),
          rationale: pair.rationale || result.rationale || ""
        };
      }
    }
  }
  return top;
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

function drawRiskBanner(context, width, height, frameResult, threshold) {
  const top = frameResult?.topRisk || null;
  const isRisk = Boolean(top && top.riskScore >= threshold);
  const margin = Math.max(20, Math.round(width * 0.025));
  const boxHeight = Math.max(78, Math.round(height * 0.15));
  const boxY = margin;
  roundedRect(context, margin, boxY, width - margin * 2, boxHeight, Math.max(14, width * 0.012));
  context.fillStyle = isRisk ? "rgba(153, 27, 27, 0.93)" : "rgba(21, 128, 61, 0.93)";
  context.fill();

  const headingSize = Math.max(22, Math.round(width * 0.024));
  const detailSize = Math.max(16, Math.round(width * 0.015));
  const textX = margin + Math.max(20, Math.round(width * 0.018));
  const textWidth = width - textX - margin - 24;
  context.fillStyle = "#ffffff";
  context.font = `800 ${headingSize}px Inter, Arial, sans-serif`;
  context.textBaseline = "top";

  if (isRisk) {
    context.fillText(`TOP RISK  ${percent(top.riskScore)}`, textX, boxY + boxHeight * 0.18);
    context.font = `600 ${detailSize}px Inter, Arial, sans-serif`;
    const detail = `Victim: ${top.victim}   |   Risk object: ${top.object}`;
    context.fillText(fitText(context, detail, textWidth), textX, boxY + boxHeight * 0.58);
  } else {
    context.fillText("NO RISK", textX, boxY + boxHeight * 0.32);
  }
}

function resultAtTime(time) {
  if (!state.frameResults.length) return null;
  const second = Math.max(0, Math.floor(time));
  return state.frameResults.find((result) => result.second === second) || state.frameResults.at(-1);
}

function chooseRecordingMime() {
  const options = [
    "video/mp4;codecs=h264",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  return options.find((type) => window.MediaRecorder?.isTypeSupported(type)) || "";
}

async function renderAnnotatedVideo({ width, height }) {
  if (!window.MediaRecorder) throw new Error("This browser cannot record the annotated video.");

  const source = await loadVideoElement(state.videoUrl, true);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const stream = canvas.captureStream(30);
  const sourceStream = typeof source.captureStream === "function" ? source.captureStream() : null;
  for (const track of sourceStream?.getAudioTracks() || []) stream.addTrack(track);
  const mimeType = chooseRecordingMime();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  const threshold = Number(els.riskThreshold.value);
  let rafId = 0;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });

  const stopped = new Promise((resolve) => {
    recorder.addEventListener("stop", resolve, { once: true });
  });

  const draw = () => {
    context.drawImage(source, 0, 0, width, height);
    drawRiskBanner(context, width, height, resultAtTime(source.currentTime), threshold);
    rafId = requestAnimationFrame(draw);
  };

  await seekVideo(source, 0);
  recorder.start(500);
  draw();
  await source.play();
  await waitForEvent(source, "ended");
  cancelAnimationFrame(rafId);
  recorder.stop();
  await stopped;

  const type = mimeType.split(";")[0] || "video/webm";
  const blob = new Blob(chunks, { type });
  return { url: URL.createObjectURL(blob), type };
}

function renderFrameResults() {
  const threshold = Number(els.riskThreshold.value);
  const overall = Math.max(...state.frameResults.map((result) => result.overallRiskScore), 0);
  els.overallScore.textContent = `Overall risk: ${percent(overall)}`;

  if (!state.frameResults.length) {
    els.framesView.innerHTML = `<div class="empty-state">No sampled frames analyzed.</div>`;
    return;
  }

  els.framesView.innerHTML = state.frameResults
    .map((result) => {
      const top = result.topRisk;
      const score = Number(top?.riskScore || 0);
      const label = top && score >= threshold ? `${escapeHtml(top.victim)} / ${escapeHtml(top.object)}` : "No risk";
      return `
        <section class="score-card">
          <div class="score-head">
            <div>
              <span class="victim-label">${result.second}s</span>
              <h3>${label}</h3>
            </div>
            <div class="score-badge ${riskLevel(score)}">${percent(score)}</div>
          </div>
          <div class="meter" aria-label="Risk score ${percent(score)}"><span style="width: ${percent(score)}"></span></div>
          ${els.fastMode.checked || !top ? "" : `<p class="rationale">${escapeHtml(top.rationale || "")}</p>`}
        </section>`;
    })
    .join("");
}

function resetOutput() {
  state.frameResults = [];
  state.complete = false;
  if (state.annotatedUrl) URL.revokeObjectURL(state.annotatedUrl);
  state.annotatedUrl = null;
  state.annotatedMime = "";
  els.annotatedVideo.removeAttribute("src");
  els.annotatedVideo.load();
  els.downloadLink.removeAttribute("href");
  show(els.downloadLink, false);
  show(els.outputStage, false);
}

async function analyzeFrame(frame, shared, index, total) {
  setProgress(`running: analyzing frame ${index + 1} of ${total} (${frame.second}s)...`);
  const extraction = await postJson("/api/extract-objects", {
    imageDataUrl: frame.imageDataUrl,
    objectCount: Number(els.objectCount.value),
    candidates: candidateObjects(),
    model: shared.model,
    fast: shared.fast,
    apiKey: shared.apiKey
  });
  const grouping = await postJson("/api/group-objects", {
    ...shared,
    objects: extraction.objects
  });
  const scoring = await postJson("/api/score-risk", {
    ...shared,
    victims: grouping.victims,
    riskObjects: grouping.riskObjects
  });
  const topRisk = topRiskPair(scoring.victimResults);
  return {
    second: frame.second,
    objects: extraction.objects,
    victims: grouping.victims,
    riskObjects: grouping.riskObjects,
    overallRiskScore: scoring.overallRiskScore,
    victimResults: scoring.victimResults,
    topRisk
  };
}

async function analyzeVideo() {
  const apiKey = els.apiKey.value.trim();
  const riskDescription = els.riskDescription.value.trim();
  const candidates = candidateObjects();

  if (!apiKey) {
    setStatus("Enter an OpenAI API key above before analyzing.", true);
    els.apiKey.focus();
    return;
  }
  if (!riskDescription) {
    setStatus("Enter a risk description before analyzing.", true);
    els.riskDescription.focus();
    return;
  }
  if (els.fastMode.checked && !candidates.length) {
    setStatus("Enter at least one candidate object for Fast mode.", true);
    return;
  }

  resetOutput();
  setRunning(true);
  show(els.outputStage, true);
  show(els.framePanel, els.showFrameDetails.checked);
  els.framesView.innerHTML = loadingState("Sampling one frame per second...");

  const shared = {
    apiKey,
    riskDescription,
    model: els.modelSelect.value,
    fast: els.fastMode.checked
  };

  try {
    const sampled = await extractFrameDataUrls(state.videoUrl);
    els.framesView.innerHTML = loadingState(`Analyzing ${sampled.frames.length} sampled frames...`);
    const results = [];
    for (let index = 0; index < sampled.frames.length; index += 1) {
      results.push(await analyzeFrame(sampled.frames[index], shared, index, sampled.frames.length));
      state.frameResults = results;
      renderFrameResults();
    }

    setProgress("rendering annotated video...");
    const annotated = await renderAnnotatedVideo(sampled);
    state.annotatedUrl = annotated.url;
    state.annotatedMime = annotated.type;
    els.annotatedVideo.src = annotated.url;
    const extension = annotated.type.includes("mp4") ? "mp4" : "webm";
    els.downloadLink.href = annotated.url;
    els.downloadLink.download = `${state.videoName.replace(/\.[^.]+$/, "")}-risk-banner.${extension}`;
    els.downloadLink.textContent = `Download ${extension.toUpperCase()}`;
    show(els.downloadLink, true);
    state.complete = true;
    setStatus(`Annotated ${state.videoName} from ${sampled.frames.length} sampled frames.`);
    setProgress("");
  } catch (error) {
    setProgress(`Analysis stopped: ${error.message}`, true);
    setStatus(error.message, true);
  } finally {
    setRunning(false);
  }
}

function bindControls() {
  els.objectCount.addEventListener("input", () => {
    els.objectCountValue.textContent = els.objectCount.value;
  });
  els.fastMode.addEventListener("change", updateFastControls);
  els.riskThreshold.addEventListener("input", () => {
    els.riskThresholdValue.textContent = Number(els.riskThreshold.value).toFixed(2);
    if (state.frameResults.length) renderFrameResults();
  });
  els.showFrameDetails.addEventListener("change", () => {
    show(els.framePanel, els.showFrameDetails.checked);
  });
  els.analyzeBtn.addEventListener("click", analyzeVideo);
  els.videoInput.addEventListener("change", () => {
    const file = els.videoInput.files?.[0];
    if (!file) return;
    if (state.videoUrl.startsWith("blob:")) URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = URL.createObjectURL(file);
    state.videoName = file.name;
    els.previewVideo.src = state.videoUrl;
    els.previewVideo.load();
    resetOutput();
    setStatus(`Loaded ${file.name}.`);
  });
}

bindControls();
updateFastControls();
setStatus("Ready with assets/baby.MP4. Upload another MP4 or click Analyze Video.");
