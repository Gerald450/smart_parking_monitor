const setupView = document.getElementById("setup-view");
const liveView = document.getElementById("live-view");
const canvas = document.getElementById("setup-canvas");
const context = canvas.getContext("2d");
const setupTitle = document.getElementById("setup-title");
const setupHelp = document.getElementById("setup-help");
const setupSteps = [...document.querySelectorAll("#setup-steps li")];
const drawHint = document.getElementById("draw-hint");
const nextBtn = document.getElementById("next-btn");
const backBtn = document.getElementById("back-btn");
const undoBtn = document.getElementById("undo-btn");
const autoBtn = document.getElementById("auto-btn");
const autoLiveBtn = document.getElementById("auto-live-btn");
const deleteBtn = document.getElementById("delete-btn");
const editLiveBtn = document.getElementById("edit-live-btn");
const resetBtn = document.getElementById("reset-btn");
const lotImage = document.getElementById("lot-image");
const lotOverlay = document.getElementById("lot-overlay");
const availableCount = document.getElementById("available-count");
const totalCount = document.getElementById("total-count");
const suggestion = document.getElementById("suggestion");
const updatedAt = document.getElementById("updated-at");
const livePill = document.getElementById("live-pill");
const clock = document.getElementById("clock");
const stallBoard = document.getElementById("stall-board");
const ringFill = document.getElementById("ring-fill");

const RING_LENGTH = 2 * Math.PI * 40;

const STEP_COPY = [
  {
    title: "Find the parking stalls",
    help: "Parkline can scan the lot photo for painted stall rows. Or draw one typical space yourself, then box each row.",
    hint: "Auto-detect, or drag a box around one stall",
    next: "Next",
  },
  {
    title: "Box each parking row",
    help: "Draw one long rectangle around every row of stalls. Press Next when all rows are marked.",
    hint: "Drag a box around a whole row",
    next: "Preview stalls",
  },
  {
    title: "Adjust the stalls",
    help: "Drag a box to move it. Pull a corner to resize. Draw on empty asphalt to add a stall. Select one and press Delete to remove it.",
    hint: "Click a stall to edit it",
    next: "Start monitoring",
  },
];

let lotPhoto = null;
let step = 0;
let drawing = null;
let drawStart = null;
let reference = null;
let rows = [];
let previewSpaces = [];
let currentFilter = "all";
let selectedStall = null;
let lastStatus = null;
let pollTimer = null;
let selectedEditIndex = null;
let editAction = null;
let editStart = null;
let editOrigin = null;
let editingExisting = false;

const HANDLE_SIZE = 18;

function show(view) {
  const isSetup = view === "setup";
  setupView.hidden = !isSetup;
  liveView.hidden = isSetup;
  setupView.classList.toggle("hidden", !isSetup);
  liveView.classList.toggle("hidden", isSetup);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function tickClock() {
  const now = new Date();
  clock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
    now.getSeconds()
  )}`;
}

async function fetchJSON(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload.error) message = payload.error;
    } catch (error) {
      // Keep the generic message when the body is not JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

function loadLotPhoto() {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load the lot photo."));
    image.src = `/lot_frame.jpg?t=${Date.now()}`;
  });
}

function canvasPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  const scaleX = canvas.width / bounds.width;
  const scaleY = canvas.height / bounds.height;
  return {
    x: Math.round((event.clientX - bounds.left) * scaleX),
    y: Math.round((event.clientY - bounds.top) * scaleY),
  };
}

function normalizeBox(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return [
    Math.max(0, x),
    Math.max(0, y),
    Math.max(1, Math.abs(end.x - start.x)),
    Math.max(1, Math.abs(end.y - start.y)),
  ];
}

function clampBox(box) {
  let [x, y, width, height] = box;
  const maxWidth = canvas.width || 1;
  const maxHeight = canvas.height || 1;
  width = Math.max(16, width);
  height = Math.max(16, height);
  x = Math.min(Math.max(0, x), maxWidth - width);
  y = Math.min(Math.max(0, y), maxHeight - height);
  width = Math.min(width, maxWidth - x);
  height = Math.min(height, maxHeight - y);
  return [Math.round(x), Math.round(y), Math.round(width), Math.round(height)];
}

function stallContains(box, point, pad = 0) {
  const [x, y, width, height] = box;
  return (
    point.x >= x - pad &&
    point.x <= x + width + pad &&
    point.y >= y - pad &&
    point.y <= y + height + pad
  );
}

function handleAt(box, point) {
  const [x, y, width, height] = box;
  const handles = {
    nw: [x, y],
    ne: [x + width, y],
    sw: [x, y + height],
    se: [x + width, y + height],
  };

  for (const [name, [handleX, handleY]] of Object.entries(handles)) {
    if (
      Math.abs(point.x - handleX) <= HANDLE_SIZE &&
      Math.abs(point.y - handleY) <= HANDLE_SIZE
    ) {
      return name;
    }
  }

  if (stallContains(box, point)) return "move";
  return null;
}

function hitTestStall(point) {
  if (selectedEditIndex != null && previewSpaces[selectedEditIndex]) {
    const handle = handleAt(previewSpaces[selectedEditIndex], point);
    if (handle) return { index: selectedEditIndex, handle };
  }

  for (let index = previewSpaces.length - 1; index >= 0; index -= 1) {
    const handle = handleAt(previewSpaces[index], point);
    if (handle) return { index, handle };
  }

  return null;
}

function resizedBox(origin, handle, point) {
  const [x, y, width, height] = origin;
  const right = x + width;
  const bottom = y + height;
  const left = handle.includes("w") ? point.x : x;
  const top = handle.includes("n") ? point.y : y;
  const newRight = handle.includes("e") ? point.x : right;
  const newBottom = handle.includes("s") ? point.y : bottom;
  return clampBox(normalizeBox({ x: left, y: top }, { x: newRight, y: newBottom }));
}

function cursorForHandle(handle) {
  if (handle === "nw" || handle === "se") return "nwse-resize";
  if (handle === "ne" || handle === "sw") return "nesw-resize";
  if (handle === "move") return "grab";
  return "crosshair";
}

function drawHandle(x, y) {
  const size = 12;
  context.fillStyle = "#ffbf1f";
  context.strokeStyle = "#0f130e";
  context.lineWidth = 2;
  context.fillRect(x - size / 2, y - size / 2, size, size);
  context.strokeRect(x - size / 2, y - size / 2, size, size);
}

function updateEditorChrome() {
  const editing = step === 2;
  deleteBtn.hidden = !editing || selectedEditIndex == null;

  if (!editing) return;

  if (selectedEditIndex != null) {
    drawHint.textContent = `Stall ${selectedEditIndex + 1} selected · drag to move · Delete to remove`;
  } else {
    drawHint.textContent = `Drag a stall to move it, or draw a new box · ${previewSpaces.length} stalls`;
  }
}

function drawBox(box, color, label) {
  const [x, y, width, height] = box;
  context.strokeStyle = color;
  context.fillStyle = color.replace(")", ", 0.18)").replace("rgb", "rgba");
  context.lineWidth = 3;
  context.fillRect(x, y, width, height);
  context.strokeRect(x, y, width, height);

  if (label) {
    context.fillStyle = "#f3efe4";
    context.font = "20px 'IBM Plex Mono', monospace";
    context.fillText(label, x + 8, y + 24);
  }
}

function redrawSetup() {
  if (!lotPhoto) return;

  canvas.width = lotPhoto.naturalWidth;
  canvas.height = lotPhoto.naturalHeight;
  context.drawImage(lotPhoto, 0, 0);

  if (reference) drawBox(reference, "rgb(255, 191, 31)", "STALL");
  rows.forEach((row, index) => {
    drawBox(row, "rgb(110, 176, 255)", `ROW ${index + 1}`);
  });
  previewSpaces.forEach((space, index) => {
    const selected = step === 2 && index === selectedEditIndex;
    drawBox(
      space,
      selected ? "rgb(255, 191, 31)" : "rgb(62, 224, 160)",
      String(index + 1)
    );

    if (selected) {
      const [x, y, width, height] = space;
      drawHandle(x, y);
      drawHandle(x + width, y);
      drawHandle(x, y + height);
      drawHandle(x + width, y + height);
    }
  });
  if (drawing) drawBox(drawing, "rgb(243, 239, 228)");
  updateEditorChrome();
}

function setStep(nextStep) {
  step = nextStep;
  const copy = STEP_COPY[step];
  setupTitle.textContent = copy.title;
  setupHelp.textContent = copy.help;
  drawHint.textContent = copy.hint;
  nextBtn.textContent = copy.next;
  setupSteps.forEach((item, index) => {
    item.classList.toggle("is-active", index === step);
  });
  backBtn.disabled = step === 0 && !editingExisting;
  undoBtn.hidden = step !== 1;
  autoBtn.hidden = step !== 0;
  nextBtn.classList.toggle("solid", step !== 0);
  nextBtn.classList.toggle("ghost", step === 0);
  canvas.style.pointerEvents = "auto";
  if (step !== 2) selectedEditIndex = null;
  redrawSetup();
}

function beginDraw(event) {
  if (step === 2) {
    beginEdit(event);
    return;
  }

  canvas.setPointerCapture(event.pointerId);
  drawStart = canvasPoint(event);
  drawing = [drawStart.x, drawStart.y, 1, 1];
  redrawSetup();
}

function beginEdit(event) {
  const point = canvasPoint(event);
  const hit = hitTestStall(point);

  canvas.setPointerCapture(event.pointerId);

  if (hit) {
    selectedEditIndex = hit.index;
    editAction = hit.handle;
    editStart = point;
    editOrigin = previewSpaces[hit.index].slice();
    drawing = null;
    drawStart = null;
    canvas.style.cursor = editAction === "move" ? "grabbing" : cursorForHandle(editAction);
    redrawSetup();
    return;
  }

  selectedEditIndex = null;
  editAction = null;
  drawStart = point;
  drawing = [point.x, point.y, 1, 1];
  canvas.style.cursor = "crosshair";
  redrawSetup();
}

function moveDraw(event) {
  const point = canvasPoint(event);

  if (step === 2 && !drawStart && !editAction) {
    const hover = hitTestStall(point);
    canvas.style.cursor = hover ? cursorForHandle(hover.handle) : "crosshair";
  }

  if (step === 2 && editAction && editOrigin) {
    if (editAction === "move") {
      const moved = clampBox([
        editOrigin[0] + (point.x - editStart.x),
        editOrigin[1] + (point.y - editStart.y),
        editOrigin[2],
        editOrigin[3],
      ]);
      previewSpaces[selectedEditIndex] = moved;
    } else {
      previewSpaces[selectedEditIndex] = resizedBox(editOrigin, editAction, point);
    }
    redrawSetup();
    return;
  }

  if (!drawStart) return;
  drawing = normalizeBox(drawStart, point);
  redrawSetup();
}

function endDraw(event) {
  if (step === 2 && editAction) {
    editAction = null;
    editStart = null;
    editOrigin = null;
    canvas.style.cursor = "grab";
    redrawSetup();
    return;
  }

  if (!drawStart) return;
  const box = normalizeBox(drawStart, canvasPoint(event));
  drawStart = null;
  drawing = null;

  if (box[2] < 12 || box[3] < 12) {
    redrawSetup();
    return;
  }

  if (step === 0) {
    reference = box;
    previewSpaces = [];
  } else if (step === 1) {
    rows.push(box);
    previewSpaces = [];
  } else if (step === 2) {
    previewSpaces.push(clampBox(box));
    selectedEditIndex = previewSpaces.length - 1;
  }

  redrawSetup();
}

async function goNext() {
  try {
    nextBtn.disabled = true;

    if (step === 0) {
      if (!reference) throw new Error("Draw one parking stall first.");
      setStep(1);
      return;
    }

    if (step === 1) {
      if (!rows.length) throw new Error("Draw at least one parking row.");
      const payload = await fetchJSON("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference, rows }),
      });
      previewSpaces = payload.spaces;
      setStep(2);
      return;
    }

    if (step === 2) {
      if (!previewSpaces.length) {
        throw new Error("Add at least one stall first.");
      }

      await fetchJSON("/api/spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spaces: previewSpaces,
          reference,
          rows,
        }),
      });

      editingExisting = false;
      selectedEditIndex = null;
      show("live");
      livePill.textContent = "Starting";
      livePill.className = "pill waiting";
      await refreshLive();
      return;
    }
  } catch (error) {
    setupHelp.textContent = error.message;
  } finally {
    nextBtn.disabled = false;
  }
}

function goBack() {
  if (step === 1) {
    rows = [];
    previewSpaces = [];
    setStep(0);
    return;
  }

  if (step === 2) {
    selectedEditIndex = null;
    previewSpaces = [];
    if (editingExisting) {
      editingExisting = false;
      show("live");
      refreshLive();
      return;
    }
    setStep(rows.length ? 1 : 0);
  }
}

function deleteSelectedStall() {
  if (step !== 2 || selectedEditIndex == null) return;
  previewSpaces.splice(selectedEditIndex, 1);
  selectedEditIndex = null;
  redrawSetup();
}

function nudgeSelected(dx, dy) {
  if (step !== 2 || selectedEditIndex == null) return;
  const box = previewSpaces[selectedEditIndex];
  previewSpaces[selectedEditIndex] = clampBox([
    box[0] + dx,
    box[1] + dy,
    box[2],
    box[3],
  ]);
  redrawSetup();
}

async function editCurrentStalls() {
  try {
    const payload = await fetchJSON("/api/spaces");
    if (!payload.spaces || !payload.spaces.length) {
      throw new Error("No saved stalls to edit yet.");
    }

    previewSpaces = payload.spaces;
    reference = null;
    rows = [];
    selectedEditIndex = null;
    editingExisting = true;
    show("setup");
    setStep(2);
    setupHelp.textContent = `Editing ${payload.count} stalls. Drag to move, pull a corner to resize, then start monitoring.`;
  } catch (error) {
    suggestion.textContent = error.message;
  }
}

function undoRow() {
  rows.pop();
  previewSpaces = [];
  redrawSetup();
}

async function autoDetect() {
  const fromLive = liveView.hidden === false;
  try {
    autoBtn.disabled = true;
    autoLiveBtn.disabled = true;
    show("setup");
    setStep(0);
    setupHelp.textContent = "Scanning the lot photo for painted stalls…";

    const payload = await fetchJSON("/api/autodetect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    previewSpaces = payload.spaces;
    reference = null;
    rows = [];
    selectedEditIndex = null;
    editingExisting = fromLive;
    show("setup");
    setStep(2);
    setupHelp.textContent = `Found ${payload.count} stalls. Drag to move, pull a corner to resize, or draw a new box.`;
  } catch (error) {
    show("setup");
    setStep(0);
    setupHelp.textContent = error.message;
  } finally {
    autoBtn.disabled = false;
    autoLiveBtn.disabled = false;
  }
}

function setLiveStatus(kind, label) {
  livePill.className = `pill ${kind}`;
  livePill.textContent = label;
}

function formatTime(iso) {
  if (!iso) return "Waiting for the first scan";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Updated just now";
  return `Updated ${date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}

function firstOpenStall(spaces) {
  return spaces.find((space) => space.status === "Open") || null;
}

function renderOverlay(status) {
  const width = status.frame_width || 1100;
  const height = status.frame_height || 720;
  const suggested = firstOpenStall(status.spaces || []);
  lotOverlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
  lotOverlay.innerHTML = (status.spaces || [])
    .map((space) => {
      const kind = (space.status || "unknown").toLowerCase();
      const isSuggested = suggested && suggested.id === space.id;
      return `
        <g class="${isSuggested ? "is-suggested" : ""}" data-space="${space.id}">
          <rect
            class="stall-hit ${kind}${isSuggested ? " is-suggested" : ""}"
            x="${space.x}" y="${space.y}" width="${space.w}" height="${space.h}"
            rx="6"
          ></rect>
          <text class="stall-label" x="${space.x + 8}" y="${space.y + 22}">${
            space.id
          }</text>
        </g>
      `;
    })
    .join("");

  lotOverlay.querySelectorAll("[data-space]").forEach((node) => {
    node.addEventListener("click", () => {
      selectedStall = Number(node.getAttribute("data-space"));
      renderBoard(lastStatus);
    });
  });
}

function renderBoard(status) {
  if (!status) return;

  const suggested = firstOpenStall(status.spaces || []);
  const spaces = (status.spaces || []).filter((space) => {
    if (currentFilter === "all") return true;
    return space.status === currentFilter;
  });

  stallBoard.innerHTML = spaces
    .map((space) => {
      const isSuggested = suggested && suggested.id === space.id;
      const hint = isSuggested ? "closest open" : space.status === "Open" ? "pull in" : "in use";
      const selected = selectedStall === space.id ? " is-suggested" : "";
      return `
        <li class="${isSuggested ? "is-suggested" : ""}${selected}" data-space="${space.id}">
          <span class="stall-no">${pad(space.id)}</span>
          <span class="stall-state ${space.status.toLowerCase()}">${space.status}</span>
          <span class="stall-hint">${hint}</span>
        </li>
      `;
    })
    .join("");
}

function renderLive(status, state) {
  lastStatus = status;
  const available = status?.available ?? 0;
  const total = status?.total ?? 0;
  const ratio = total ? available / total : 0;

  availableCount.textContent = available;
  totalCount.textContent = total;
  ringFill.style.strokeDasharray = String(RING_LENGTH);
  ringFill.style.strokeDashoffset = String(RING_LENGTH * (1 - ratio));
  updatedAt.textContent = formatTime(status?.updated_at);

  const openStall = firstOpenStall(status?.spaces || []);
  if (!state?.detector_running) {
    suggestion.textContent = "The camera feed is starting. Stall lights appear after the first scan.";
    setLiveStatus("waiting", "Starting");
  } else if (openStall) {
    suggestion.textContent = `Try stall ${pad(openStall.id)} — closest open space.`;
    setLiveStatus("live", "Live");
  } else if (total) {
    suggestion.textContent = "Lot is full right now. Watch the board for the next opening.";
    setLiveStatus("live", "Live");
  } else {
    suggestion.textContent = "Waiting for the first scan.";
    setLiveStatus("waiting", "Scanning");
  }

  const imageStamp = status?.updated_at || Date.now();
  const liveSrc = state?.has_live_image
    ? `/lot_live.jpg?t=${encodeURIComponent(imageStamp)}`
    : `/lot_frame.jpg?t=${encodeURIComponent(imageStamp)}`;

  if (!lotImage.src.includes(String(imageStamp))) {
    lotImage.src = liveSrc;
  }

  if (status) renderOverlay(status);
  renderBoard(status);
}

async function refreshLive() {
  try {
    const state = await fetchJSON("/api/state");
    if (!setupView.hidden) {
      return;
    }
    if (!state.has_video) {
      setLiveStatus("offline", "No video");
      suggestion.textContent = "parking_video.mp4 is missing from the data folder.";
      return;
    }

    if (!state.has_spaces) {
      show("setup");
      return;
    }

    show("live");
    let status = null;
    if (state.has_status) {
      status = await fetchJSON("/status.json");
    }
    renderLive(status, state);
  } catch (error) {
    setLiveStatus("offline", "Offline");
    suggestion.textContent = error.message;
  }
}

async function resetLot() {
  const confirmed = window.confirm(
    "Recalibrate the lot? This clears saved stall boxes so you can mark them again."
  );
  if (!confirmed) return;

  await fetchJSON("/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  reference = null;
  rows = [];
  previewSpaces = [];
  selectedEditIndex = null;
  editingExisting = false;
  lastStatus = null;
  stallBoard.innerHTML = "";
  lotOverlay.innerHTML = "";
  show("setup");
  setStep(0);
  redrawSetup();
}

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll(".filter").forEach((item) => {
      item.classList.toggle("is-active", item === button);
    });
    renderBoard(lastStatus);
  });
});

canvas.addEventListener("pointerdown", beginDraw);
canvas.addEventListener("pointermove", moveDraw);
canvas.addEventListener("pointerup", endDraw);
canvas.addEventListener("pointercancel", endDraw);
nextBtn.addEventListener("click", goNext);
backBtn.addEventListener("click", goBack);
undoBtn.addEventListener("click", undoRow);
deleteBtn.addEventListener("click", deleteSelectedStall);
autoBtn.addEventListener("click", autoDetect);
autoLiveBtn.addEventListener("click", autoDetect);
editLiveBtn.addEventListener("click", editCurrentStalls);
resetBtn.addEventListener("click", resetLot);

document.addEventListener("keydown", (event) => {
  if (step !== 2) return;
  if (event.key === "Backspace" || event.key === "Delete") {
    event.preventDefault();
    deleteSelectedStall();
    return;
  }

  const amount = event.shiftKey ? 8 : 1;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    nudgeSelected(-amount, 0);
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    nudgeSelected(amount, 0);
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    nudgeSelected(0, -amount);
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    nudgeSelected(0, amount);
  }
});

async function start() {
  tickClock();
  setInterval(tickClock, 1000);
  show("setup");
  setStep(0);

  try {
    lotPhoto = await loadLotPhoto();
    redrawSetup();

    const state = await fetchJSON("/api/state");
    if (state.has_spaces) {
      show("live");
      await refreshLive();
    }

    pollTimer = setInterval(refreshLive, 900);
  } catch (error) {
    setupHelp.textContent = error.message;
  }
}

start();
