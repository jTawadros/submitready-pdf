import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { jsPDF } from "jspdf";
import imageCompression from "browser-image-compression";
import heic2any from "heic2any";
import "./styles.css";

const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];
const ACCEPTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"];
const PRESETS = ["Homework", "Notes", "Receipts", "Forms"];
const QUALITY_OPTIONS = {
  High: { maxSizeMB: 2.5, quality: 0.92 },
  Medium: { maxSizeMB: 1.2, quality: 0.78 },
  "Small file": { maxSizeMB: 0.55, quality: 0.62 },
};

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function sanitizeFilenamePart(value, fallback) {
  const cleaned = value
    .trim()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function isAcceptedImage(file) {
  const lowerName = file.name.toLowerCase();
  return (
    ACCEPTED_TYPES.includes(file.type) ||
    ACCEPTED_EXTENSIONS.some((extension) => lowerName.endsWith(extension))
  );
}

function isHeicImage(file) {
  const lowerName = file.name.toLowerCase();
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    lowerName.endsWith(".heic") ||
    lowerName.endsWith(".heif")
  );
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function convertHeicToJpeg(file) {
  const converted = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.9,
  });
  const blob = Array.isArray(converted) ? converted[0] : converted;
  const outputName = file.name.replace(/\.(heic|heif)$/i, ".jpg");
  return new File([blob], outputName, {
    type: "image/jpeg",
    lastModified: file.lastModified,
  });
}

function createPageId(file, index) {
  const randomId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${index}`;
  return `${file.name}-${file.lastModified}-${randomId}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load one of the images."));
    image.src = src;
  });
}

async function createPageFromFile(file, index) {
  const processedFile = isHeicImage(file) ? await convertHeicToJpeg(file) : file;
  const dataUrl = await readFileAsDataUrl(processedFile);
  await loadImage(dataUrl);

  return {
    id: createPageId(file, index),
    file,
    processedFile,
    dataUrl,
    rotation: 0,
  };
}

async function normalizeImageDataUrl(dataUrl, degrees, quality = 0.95) {
  const normalized = ((degrees % 360) + 360) % 360;
  const image = await loadImage(dataUrl);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const swap = normalized === 90 || normalized === 270;
  canvas.width = swap ? image.naturalHeight : image.naturalWidth;
  canvas.height = swap ? image.naturalWidth : image.naturalHeight;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((normalized * Math.PI) / 180);
  ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);

  return {
    dataUrl: canvas.toDataURL("image/jpeg", quality),
    width: canvas.width,
    height: canvas.height,
  };
}

async function prepareImageForPdf(page, compressImages, quality) {
  let dataUrl = page.dataUrl;

  if (compressImages) {
    const compressed = await imageCompression(page.processedFile || page.file, {
      maxSizeMB: QUALITY_OPTIONS[quality].maxSizeMB,
      maxWidthOrHeight: 2200,
      initialQuality: QUALITY_OPTIONS[quality].quality,
      useWebWorker: true,
    });
    dataUrl = await readFileAsDataUrl(compressed);
  }

  const outputQuality = compressImages ? QUALITY_OPTIONS[quality].quality : 0.95;
  return normalizeImageDataUrl(dataUrl, page.rotation, outputQuality);
}

function getFilename(settings) {
  const lastName = sanitizeFilenamePart(settings.lastName, "Student");
  const className = sanitizeFilenamePart(settings.className, "Class");
  const assignment = sanitizeFilenamePart(settings.assignmentName, "Assignment");
  return `${lastName}_${className}_${assignment}.pdf`;
}

function estimatePdfSize(pages, settings) {
  if (!pages.length) return 0;
  const pageOverhead = pages.length * 80 * 1024;
  const sourceBytes = pages.reduce((sum, page) => sum + (page.processedFile || page.file).size, 0);

  if (!settings.compressImages) {
    return Math.round(sourceBytes * 1.05 + pageOverhead);
  }

  const presetLimit = QUALITY_OPTIONS[settings.quality].maxSizeMB * 1024 * 1024;
  const estimatedImages = pages.reduce(
    (sum, page) => sum + Math.min((page.processedFile || page.file).size, presetLimit),
    0,
  );
  return Math.round(estimatedImages * 0.9 + pageOverhead);
}

function App() {
  const inputRef = useRef(null);
  const [pages, setPages] = useState([]);
  const [errors, setErrors] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [draggedPageId, setDraggedPageId] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [lastExportSize, setLastExportSize] = useState(null);
  const [settings, setSettings] = useState({
    lastName: "",
    className: "",
    assignmentName: "",
    preset: "Homework",
    compressImages: true,
    quality: "Medium",
  });

  const totalSize = useMemo(
    () => pages.reduce((sum, page) => sum + page.file.size, 0),
    [pages],
  );
  const estimatedPdfSize = useMemo(
    () => estimatePdfSize(pages, settings),
    [pages, settings],
  );

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    const validFiles = files.filter(isAcceptedImage);
    const rejected = files.filter((file) => !isAcceptedImage(file));
    const uploadResults = await Promise.allSettled(
      validFiles.map((file, index) => createPageFromFile(file, index)),
    );
    const nextPages = uploadResults
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const unreadableFiles = validFiles.filter(
      (_, index) => uploadResults[index].status === "rejected",
    );
    const nextErrors = [
      ...rejected.map(
        (file) => `${file.name} is not supported. Please upload JPG, PNG, WEBP, HEIC, or HEIF images.`,
      ),
      ...unreadableFiles.map((file) => `${file.name} could not be loaded as an image.`),
    ];

    setErrors(nextErrors);
    if (nextPages.length) {
      setPages((current) => [...current, ...nextPages]);
      setLastExportSize(null);
    }
  }

  function reorderPages(fromIndex, targetIndex) {
    if (fromIndex === targetIndex || fromIndex < 0 || targetIndex < 0) return;
    setPages((current) => {
      if (fromIndex >= current.length || targetIndex >= current.length) return current;
      const copy = [...current];
      const [page] = copy.splice(fromIndex, 1);
      copy.splice(targetIndex, 0, page);
      return copy;
    });
    setLastExportSize(null);
  }

  function movePage(index, direction) {
    reorderPages(index, index + direction);
  }

  function dropPage(targetIndex) {
    const fromIndex = pages.findIndex((page) => page.id === draggedPageId);
    reorderPages(fromIndex, targetIndex);
    setDraggedPageId(null);
  }

  function rotatePage(id) {
    setPages((current) =>
      current.map((page) =>
        page.id === id ? { ...page, rotation: (page.rotation + 90) % 360 } : page,
      ),
    );
    setLastExportSize(null);
  }

  function removePage(id) {
    setPages((current) => current.filter((page) => page.id !== id));
    setLastExportSize(null);
  }

  function clearPages() {
    setPages([]);
    setErrors([]);
    setLastExportSize(null);
  }

  function updateSettings(nextSettings) {
    setSettings(nextSettings);
    setLastExportSize(null);
  }

  async function exportPdf() {
    if (!pages.length) return;
    setIsExporting(true);
    setErrors([]);

    try {
      const pdf = new jsPDF({ unit: "pt", format: "letter" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 36;
      const maxWidth = pageWidth - margin * 2;
      const maxHeight = pageHeight - margin * 2;

      for (const [index, page] of pages.entries()) {
        if (index > 0) pdf.addPage();

        const image = await prepareImageForPdf(
          page,
          settings.compressImages,
          settings.quality,
        );
        const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        const x = (pageWidth - width) / 2;
        const y = (pageHeight - height) / 2;

        pdf.addImage(image.dataUrl, "JPEG", x, y, width, height);
      }

      const pdfBlob = pdf.output("blob");
      setLastExportSize(pdfBlob.size);
      pdf.save(getFilename(settings));
    } catch (error) {
      setErrors([error.message || "Something went wrong while creating the PDF."]);
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">SubmitReady PDF</p>
          <h1>Turn homework photos into a clean PDF in 30 seconds.</h1>
          <p className="subheadline">
            Upload screenshots or phone photos, reorder them, rotate pages, compress the file,
            and download a submission-ready PDF. Your files never leave your browser.
          </p>
        </div>
        <div className="hero-visual" aria-hidden="true" />
        <div className="status-strip" aria-label="Current upload summary">
          <span>{pages.length} image{pages.length === 1 ? "" : "s"}</span>
          <span>{formatBytes(totalSize)} original size</span>
          <span>{formatBytes(estimatedPdfSize)} estimated PDF</span>
          <span>Processed locally</span>
        </div>
      </section>

      <section className="workspace" aria-label="PDF builder">
        <div className="builder-panel">
          <div
            className={`upload-zone ${isDragging ? "is-dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              addFiles(event.dataTransfer.files);
            }}
          >
            <input
              ref={inputRef}
              className="sr-only"
              type="file"
              accept=".jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif"
              multiple
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div>
              <h2>Upload homework images</h2>
              <p>Drag files here or choose JPG, PNG, WEBP, HEIC, or HEIF images from your device.</p>
            </div>
            <button type="button" onClick={() => inputRef.current?.click()}>
              Choose images
            </button>
          </div>
          <div className="builder-meta">
            <p className="trust-badge">Local-only: files never leave your browser.</p>
            <button type="button" className="clear-button" onClick={clearPages} disabled={!pages.length}>
              Clear all pages
            </button>
          </div>

          {errors.length > 0 && (
            <div className="error-list" role="alert">
              {errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
            </div>
          )}

          {pages.length > 10 && (
            <p className="warning-note" role="status">
              Large PDFs may take longer to generate.
            </p>
          )}

          <div className="thumbnail-list" aria-label="Uploaded pages">
            {pages.length === 0 ? (
              <div className="empty-state">
                <p>Your pages will appear here.</p>
              </div>
            ) : (
              pages.map((page, index) => (
                <article
                  className={`page-card ${draggedPageId === page.id ? "is-reordering" : ""}`}
                  key={page.id}
                  draggable
                  onDragStart={() => setDraggedPageId(page.id)}
                  onDragEnd={() => setDraggedPageId(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    dropPage(index);
                  }}
                >
                  <div className="thumb-frame">
                    <img
                      src={page.dataUrl}
                      alt={`Page ${index + 1} preview`}
                      style={{ transform: `rotate(${page.rotation}deg)` }}
                    />
                  </div>
                  <div className="page-info">
                    <strong>Page {index + 1}</strong>
                    <span>{page.file.name}</span>
                    <span>{formatBytes(page.file.size)}</span>
                    {isHeicImage(page.file) && <span>Converted locally for PDF export</span>}
                  </div>
                  <div className="page-actions">
                    <button type="button" onClick={() => movePage(index, -1)} disabled={index === 0}>
                      Up
                    </button>
                    <button
                      type="button"
                      onClick={() => movePage(index, 1)}
                      disabled={index === pages.length - 1}
                    >
                      Down
                    </button>
                    <button type="button" onClick={() => rotatePage(page.id)}>
                      Rotate
                    </button>
                    <button type="button" className="danger" onClick={() => removePage(page.id)}>
                      Remove
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </div>

        <aside className="settings-panel" aria-label="PDF settings">
          <div>
            <h2>PDF settings</h2>
            <p className="privacy-note">Files are processed locally in your browser.</p>
          </div>

          <label>
            Student last name
            <input
              type="text"
              value={settings.lastName}
              onChange={(event) => updateSettings({ ...settings, lastName: event.target.value })}
              placeholder="Garcia"
            />
          </label>
          <label>
            Class name
            <input
              type="text"
              value={settings.className}
              onChange={(event) => updateSettings({ ...settings, className: event.target.value })}
              placeholder="Biology"
            />
          </label>
          <label>
            Assignment name
            <input
              type="text"
              value={settings.assignmentName}
              onChange={(event) =>
                updateSettings({ ...settings, assignmentName: event.target.value })
              }
              placeholder="Lab 4"
            />
          </label>
          <label>
            Preset
            <select
              value={settings.preset}
              onChange={(event) => updateSettings({ ...settings, preset: event.target.value })}
            >
              {PRESETS.map((preset) => (
                <option key={preset}>{preset}</option>
              ))}
            </select>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.compressImages}
              onChange={(event) =>
                updateSettings({ ...settings, compressImages: event.target.checked })
              }
            />
            Compress images before export
          </label>
          <label>
            Quality
            <select
              value={settings.quality}
              onChange={(event) => updateSettings({ ...settings, quality: event.target.value })}
              disabled={!settings.compressImages}
            >
              {Object.keys(QUALITY_OPTIONS).map((quality) => (
                <option key={quality}>{quality}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="export-button"
            onClick={exportPdf}
            disabled={!pages.length || isExporting}
          >
            {isExporting ? "Generating PDF..." : "Download PDF"}
          </button>
          <p className="size-preview">
            Estimated PDF size: {formatBytes(estimatedPdfSize)}
            {lastExportSize ? ` | Last export: ${formatBytes(lastExportSize)}` : ""}
          </p>
          <p className="export-reminder">Open your PDF once before submitting.</p>
          <p className="filename-preview">{getFilename(settings)}</p>
        </aside>
      </section>

      <section className="info-section" aria-label="Sample workflow">
        <div className="section-heading">
          <p className="eyebrow">Sample workflow</p>
          <h2>From photos to a submission-ready PDF.</h2>
        </div>
        <div className="workflow-grid">
          <article className="info-card">Upload photos from your phone, screenshots, or desktop.</article>
          <article className="info-card">Drag pages into order, then rotate any sideways images.</article>
          <article className="info-card">Export one PDF with a clean assignment filename.</article>
          <article className="info-card">Open the PDF once before submitting it.</article>
        </div>
      </section>

      <section className="pricing-section" aria-label="Upgrade options">
        <div className="section-heading">
          <p className="eyebrow">Upgrade preview</p>
          <h2>Start free, upgrade when your submissions get bigger.</h2>
        </div>
        <div className="pricing-grid">
          <article className="pricing-card">
            <div>
              <h3>Free</h3>
              <p>Up to 5 images</p>
            </div>
            <span className="price">$0</span>
          </article>
          <article className="pricing-card pro-card">
            <div>
              <h3>Pro</h3>
              <p>Unlimited pages, compression presets, saved naming templates</p>
            </div>
            <span className="price">Soon</span>
          </article>
        </div>
      </section>

      <section className="info-section" aria-label="Who this is for">
        <div className="section-heading">
          <p className="eyebrow">Who this is for</p>
          <h2>Made for quick school and screenshot submissions.</h2>
        </div>
        <div className="info-grid">
          <article className="info-card">Students submitting homework photos</article>
          <article className="info-card">People combining screenshots into one PDF</article>
          <article className="info-card">Anyone who needs a clean upload-ready PDF fast</article>
        </div>
      </section>

      <section className="info-section" aria-label="Why use this instead of random PDF sites">
        <div className="section-heading">
          <p className="eyebrow">Why use this</p>
          <h2>A simpler option than random PDF sites.</h2>
        </div>
        <div className="info-grid">
          <article className="info-card">Files stay local in your browser</article>
          <article className="info-card">No account needed</article>
          <article className="info-card">Built for homework/photo submissions</article>
          <article className="info-card">Simple filename preview</article>
        </div>
      </section>

      <footer className="footer">
        <strong>SubmitReady PDF</strong>
        <span>Local-first image to PDF tool for students</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
