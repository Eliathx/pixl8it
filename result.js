import { downscale, fitWithin, quantize, toRgba } from "./pixelate.js";

const DEFAULTS = { size: 100, colors: 16 };
const MAX_SOURCE_SIDE = 2048; // huge images are pre-shrunk by the browser

const $ = (id) => document.getElementById(id);
const ui = {
  size: $("size"),
  sizeOut: $("sizeOut"),
  colors: $("colors"),
  colorsOut: $("colorsOut"),
  stage: $("stage"),
  canvas: $("canvas"),
  status: $("status"),
  palette: $("palette"),
};

let original = { width: 0, height: 0 };
let source = null;
let small = null; // cached downscale
let smallSize = 0;
let result = null;
let baseName = "image";
let renderQueued = false;

main().catch(showError);

async function main() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  ui.size.value = settings.size;
  ui.colors.value = settings.colors;

  const src = await takeSource();
  if (!src) throw new Error("No image to pixelate. Right-click an image and choose Pixelate.");
  baseName = fileBaseName(src);
  document.title = `pixl8it - ${baseName}`;

  source = readPixels(await loadImage(src));
  render();

  for (const input of [ui.size, ui.colors]) {
    input.addEventListener("input", scheduleRender);
    input.addEventListener("change", saveSettings);
  }
  window.addEventListener("resize", fitCanvas);
}

// keep a copy in sessionStorage so reloading the tab still works
async function takeSource() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return null;
  const key = `src:${id}`;
  try {
    const cached = sessionStorage.getItem(key);
    if (cached) return cached;
  } catch {}
  const { [key]: src } = await chrome.storage.session.get(key);
  if (!src) return null;
  await chrome.storage.session.remove(key);
  try {
    sessionStorage.setItem(key, src);
  } catch {} // too big to cache; only reload is affected
  return src;
}

// fetch as a blob so cross-origin images don't taint the canvas
async function loadImage(src) {
  let blob;
  try {
    const res = await fetch(src, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch (err) {
    throw new Error(`Couldn't download the image (${err.message}).`);
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error("Couldn't decode the image. The format may not be supported.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readPixels(img) {
  // SVGs without intrinsic size report 0x0
  const w = img.naturalWidth || 512;
  const h = img.naturalHeight || 512;
  original = { width: w, height: h };
  const { width, height } = fitWithin(w, h, MAX_SOURCE_SIDE);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const size = Number(ui.size.value);
  const colors = Number(ui.colors.value);
  ui.sizeOut.value = size;
  ui.colorsOut.value = colors;
  for (const input of [ui.size, ui.colors]) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty("--p", `${pct}%`);
  }

  if (!small || smallSize !== size) {
    const { width, height } = fitWithin(original.width, original.height, size);
    small = downscale(source, Math.min(width, source.width), Math.min(height, source.height));
    smallSize = size;
  }
  result = quantize(small, colors);

  ui.canvas.width = result.width;
  ui.canvas.height = result.height;
  ui.canvas.getContext("2d").putImageData(new ImageData(toRgba(result), result.width, result.height), 0, 0);
  ui.canvas.hidden = false;
  ui.status.hidden = true;

  // The palette can change the header's height (and so the stage's), so lay it
  // out before measuring the stage.
  renderPalette();
  fitCanvas();
}

function fitCanvas() {
  if (!result) return;
  const pad = 32;
  const availW = ui.stage.clientWidth - pad * 2;
  const availH = ui.stage.clientHeight - pad * 2;
  const zoom = Math.min(availW / result.width, availH / result.height);
  ui.canvas.style.width = `${result.width * zoom}px`;
  ui.canvas.style.height = `${result.height * zoom}px`;
}

function renderPalette() {
  const opaque = result.palette.filter((_, i) => i !== result.transparentIndex);
  ui.palette.replaceChildren(
    ...opaque.map((rgb) => {
      const hex = `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      const swatch = document.createElement("div");
      swatch.className = "swatch";
      swatch.style.background = hex;
      swatch.title = hex;
      return swatch;
    }),
  );
}

function saveSettings() {
  chrome.storage.sync.set({
    size: Number(ui.size.value),
    colors: Number(ui.colors.value),
  });
}

function fileBaseName(src) {
  if (src.startsWith("data:")) return "image";
  try {
    const last = decodeURIComponent(new URL(src).pathname.split("/").pop() || "");
    const name = last.replace(/\.[a-z0-9]+$/i, "").replace(/[^\w.-]+/g, "_").slice(0, 60);
    return name || "image";
  } catch {
    return "image";
  }
}

function showError(err) {
  console.error(err);
  ui.canvas.hidden = true;
  ui.status.hidden = false;
  ui.status.textContent = err.message || String(err);
  ui.status.classList.add("error");
}
