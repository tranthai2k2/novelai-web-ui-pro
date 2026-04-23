import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import { decode } from "@msgpack/msgpack";
import dotenv from "dotenv";
import fs from "fs";
import JSZip from "jszip";
import crypto from "crypto";
import sharp from "sharp";
import { exec, execFile, spawn } from "child_process";
import { promisify } from "util";

dotenv.config();

const HARDCODED_KEY = "pst-oSRBwwBcAQqZbmZzHdVxsBTJlRQI2T7x4IehlrtWB28B2hPpIIEtFo9VeIevwYeK";
const DEFAULT_LORA_PROCESSOR_PATH = "D:\\no\\lora_processor.py";
const TEMP_CHARACTER_PROMPTS_DIR = path.join(process.cwd(), "temp_character_prompts");
const LORA_BRIDGE_SCRIPT = path.join(process.cwd(), "tools", "lora_processor_bridge.py");
const DATA_DIR = path.join(process.cwd(), "data");
const TEMPLATES_FILE = path.join(DATA_DIR, "prompt-templates.json");
const QUEUE_FILE = path.join(DATA_DIR, "generation-queue.json");
const QUEUE_WORKER_FILE = path.join(process.cwd(), "queue-worker.ts");
const execFileAsync = promisify(execFile);

interface BatchJob {
  status: 'running' | 'done' | 'error' | 'cancelled';
  done: number;
  total: number;
  images: { data: string; seed: number; mimeType: string }[];
  error?: string;
}

interface GeneratedImage {
  buffer: Buffer;
  extension: string;
  mimeType: string;
  id: string;
}

interface BuiltNovelAiRequest {
  body: FormData | unknown;
  endpoint: string;
  usesMsgpack: boolean;
}

interface NovelAiGenerationResult {
  status: number;
  images: GeneratedImage[];
  errorText?: string;
}

interface PromptTemplate {
  id: string;
  name: string;
  basePrompt: string;
  negativePrompt: string;
}

interface NovelAiAccountStatus {
  priorityActions: number;
  nextRefillAt: number | null;
  taskPriority: number;
  trainingStepsFixed: number;
  trainingStepsPurchased: number;
  trainingStepsTotal: number;
}

interface GenerationQueue {
  id: string;
  status: 'idle' | 'running' | 'paused' | 'done' | 'cancelled';
  createdAt: string;
  settings: any;
  basePrompt: string;
  negativePrompt: string;
  characters: any[];
  progress: {
    currentCharacterIndex: number;
    currentLineIndex: number;
    currentBatchDone: number;
    totalImages: number;
    doneImages: number;
  };
  error?: string;
}
const batchJobs = new Map<string, BatchJob>();
let generationQueue: Promise<void> = Promise.resolve();
const NOVELAI_IMAGE_ENDPOINT = "https://image.novelai.net/ai/generate-image";
const NOVELAI_IMAGE_STREAM_ENDPOINT = "https://image.novelai.net/ai/generate-image-stream";
const LOCK_RETRY_DELAYS_MS = [1500, 2500, 4000, 6000];

async function runGenerationExclusive<T>(task: () => Promise<T>): Promise<T> {
  const previous = generationQueue;
  let release!: () => void;
  generationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await task();
  } finally {
    release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeErrorData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder("utf-8").decode(data);
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf-8");
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data ?? '');
  }
}

function isConcurrentGenerationLocked(status: number, data: unknown): boolean {
  if (status !== 429) return false;
  const text = decodeErrorData(data).toLowerCase();
  return text.includes("concurrent generation is locked");
}

function stripDataUrlPrefix(data: string): string {
  const commaIndex = data.indexOf(',');
  return commaIndex === -1 ? data : data.slice(commaIndex + 1);
}

function getDataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1] || 'image/png';
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  return Buffer.from(stripDataUrlPrefix(dataUrl), 'base64');
}

function computeReferenceCacheKey(dataUrl: string): string {
  return crypto.createHash('sha256').update(dataUrlToBuffer(dataUrl)).digest('hex');
}

function getImageMetaFromBuffer(buffer: Buffer): { extension: string; mimeType: string } {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { extension: 'png', mimeType: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: 'webp', mimeType: 'image/webp' };
  }

  return { extension: 'bin', mimeType: 'application/octet-stream' };
}

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function extractImagesFromZipBuffer(data: Buffer | ArrayBuffer): Promise<GeneratedImage[]> {
  const zip = new JSZip();
  const zipData = await zip.loadAsync(data);
  const images: GeneratedImage[] = [];

  for (const [filename, file] of Object.entries(zipData.files)) {
    if (file.dir) continue;
    if (!/\.(png|jpe?g|webp)$/i.test(filename)) continue;

    const buffer = await file.async('nodebuffer');
    const ext = path.extname(filename).slice(1).toLowerCase() || getImageMetaFromBuffer(buffer).extension;
    const mimeType = ext === 'png'
      ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : 'application/octet-stream';

    images.push({
      buffer,
      extension: ext,
      mimeType,
      id: path.basename(filename, path.extname(filename))
    });
  }

  return images;
}

function extractImagesFromMsgpackBuffer(buffer: Buffer): GeneratedImage[] {
  const images = new Map<string, GeneratedImage>();
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const messageLength = buffer.readUInt32BE(offset);
    offset += 4;

    if (offset + messageLength > buffer.length) {
      break;
    }

    const frame = buffer.subarray(offset, offset + messageLength);
    offset += messageLength;

    let message: any;
    try {
      message = decode(frame);
    } catch {
      continue;
    }

    if (!message || typeof message !== 'object' || !('image' in message)) {
      continue;
    }

    const imageBuffer = Buffer.from(message.image as Uint8Array);
    const { extension, mimeType } = getImageMetaFromBuffer(imageBuffer);
    const id = String(message.gen_id ?? images.size);

    images.set(id, {
      buffer: imageBuffer,
      extension,
      mimeType,
      id
    });
  }

  return [...images.values()];
}

function buildNovelAiRequest(payload: any): BuiltNovelAiRequest {
  const referenceFiles = Array.isArray(payload?.referenceFiles) ? payload.referenceFiles : [];
  const referenceEntries = Array.isArray(payload?.parameters?.director_reference_images_cached)
    ? payload.parameters.director_reference_images_cached
    : [];
  const shouldUseMultipart = referenceFiles.length > 0 && referenceEntries.length > 0;

  if (!shouldUseMultipart) {
    const clonedPayload = JSON.parse(JSON.stringify(payload));
    delete clonedPayload.referenceFiles;
    return {
      body: clonedPayload,
      endpoint: NOVELAI_IMAGE_ENDPOINT,
      usesMsgpack: false
    };
  }

  const clonedPayload = JSON.parse(JSON.stringify(payload));
  delete clonedPayload.referenceFiles;
  clonedPayload.parameters.stream = 'msgpack';

  const form = new FormData();

  for (const [index, entry] of clonedPayload.parameters.director_reference_images_cached.entries()) {
    const fieldName = entry.data || `director_ref_${index}`;
    const referenceFile = referenceFiles.find((file: any) => file.fieldName === fieldName) || referenceFiles[index];

    if (!referenceFile?.data) {
      throw new Error(`Missing reference file data for ${fieldName}`);
    }

    const mimeType = getDataUrlMimeType(referenceFile.data);
    const buffer = dataUrlToBuffer(referenceFile.data);
    entry.cache_secret_key = computeReferenceCacheKey(referenceFile.data);
    entry.data = fieldName;

    form.append(fieldName, new Blob([buffer], { type: mimeType }), 'blob');
  }

  form.append('request', new Blob([JSON.stringify(clonedPayload)], { type: 'application/json' }), 'blob');

  return {
    body: form,
    endpoint: NOVELAI_IMAGE_STREAM_ENDPOINT,
    usesMsgpack: true
  };
}

async function createZipFromImages(images: GeneratedImage[]): Promise<Buffer> {
  const zip = new JSZip();

  images.forEach((image, index) => {
    const safeExtension = image.extension || 'png';
    zip.file(`${index}.${safeExtension}`, image.buffer);
  });

  return zip.generateAsync({ type: 'nodebuffer' });
}

async function stripImageMetadata(image: GeneratedImage): Promise<GeneratedImage> {
  const base = sharp(image.buffer, { failOn: 'none' });

  if (image.extension === 'png') {
    return {
      ...image,
      buffer: await base.png({ compressionLevel: 9 }).toBuffer()
    };
  }

  if (image.extension === 'jpg' || image.extension === 'jpeg') {
    return {
      ...image,
      extension: 'jpg',
      mimeType: 'image/jpeg',
      buffer: await base.jpeg({ quality: 100, mozjpeg: true }).toBuffer()
    };
  }

  if (image.extension === 'webp') {
    return {
      ...image,
      buffer: await base.webp({ quality: 100 }).toBuffer()
    };
  }

  const meta = getImageMetaFromBuffer(image.buffer);
  return {
    ...image,
    extension: meta.extension,
    mimeType: meta.mimeType,
    buffer: await sharp(image.buffer, { failOn: 'none' }).toBuffer()
  };
}

async function stripMetadataFromImages(images: GeneratedImage[]): Promise<GeneratedImage[]> {
  return Promise.all(images.map(stripImageMetadata));
}

async function postNovelAiGenerate(payload: unknown, authHeader: string): Promise<NovelAiGenerationResult> {
  let lastResult: NovelAiGenerationResult | null = null;

  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt++) {
    const request = buildNovelAiRequest(payload);
    const response = await axios.post(request.endpoint, request.body, {
      headers: {
        'Authorization': authHeader,
        ...(request.usesMsgpack
          ? { 'Accept': 'application/msgpack' }
          : {
              'Content-Type': 'application/json',
              'Accept': 'application/x-zip-compressed'
            })
      },
      maxBodyLength: Infinity,
      responseType: request.usesMsgpack ? 'stream' : 'arraybuffer',
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      const errorData = request.usesMsgpack
        ? await readStreamToBuffer(response.data as NodeJS.ReadableStream)
        : response.data;
      const errorText = decodeErrorData(errorData);
      lastResult = { status: response.status, images: [], errorText };

      if (!isConcurrentGenerationLocked(response.status, errorText)) {
        return lastResult;
      }
    } else {
      const rawImages = request.usesMsgpack
        ? extractImagesFromMsgpackBuffer(await readStreamToBuffer(response.data as NodeJS.ReadableStream))
        : await extractImagesFromZipBuffer(response.data);

      if (rawImages.length === 0) {
        return {
          status: 500,
          images: [],
          errorText: request.usesMsgpack
            ? 'NovelAI stream returned no decodable images'
            : 'NovelAI zip response contained no images'
        };
      }

      const images = await stripMetadataFromImages(rawImages);
      return { status: response.status, images };
    }

    if (attempt < LOCK_RETRY_DELAYS_MS.length) {
      const retryDelay = LOCK_RETRY_DELAYS_MS[attempt];
      console.warn(`NovelAI lock detected, retrying in ${retryDelay}ms (attempt ${attempt + 1}/${LOCK_RETRY_DELAYS_MS.length + 1})`);
      await sleep(retryDelay);
    }
  }

  return lastResult || { status: 500, images: [], errorText: 'Unknown generation failure' };
}

// Sanitize folder name - remove invalid Windows filename characters
function sanitizeFolderName(name: string): string {
  return name
    .replace(/[<>:"|?*]/g, '') // Remove invalid Windows characters
    .replace(/[\\/]/g, '_')     // Replace slashes with underscore
    .trim()
    .slice(0, 200);             // Limit length
}

function ensureDirectoryExists(directory: string) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function saveGeneratedImages(images: GeneratedImage[], targetDirectory: string) {
  ensureDirectoryExists(targetDirectory);

  images.forEach((image, index) => {
    const timestamp = Date.now();
    const savePath = path.join(targetDirectory, `${timestamp}_${index}.${image.extension}`);
    fs.writeFileSync(savePath, image.buffer);
    console.log(`Saved image to: ${savePath}`);
  });
}

function ensureCleanTempCharacterPromptsDir() {
  try {
    if (fs.existsSync(TEMP_CHARACTER_PROMPTS_DIR)) {
      fs.rmSync(TEMP_CHARACTER_PROMPTS_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEMP_CHARACTER_PROMPTS_DIR, { recursive: true });
  } catch (error) {
    console.error("Failed to reset temp character prompt directory:", error);
  }
}

async function fetchNovelAiAccountStatus(authHeader: string): Promise<NovelAiAccountStatus> {
  const response = await axios.get('https://api.novelai.net/user/data', {
    headers: { Authorization: authHeader },
    validateStatus: () => true
  });

  if (response.status !== 200 || !response.data) {
    throw new Error(`NovelAI account API error ${response.status}`);
  }

  const priority = response.data?.priority ?? {};
  const trainingStepsLeft = response.data?.subscription?.trainingStepsLeft ?? {};
  const fixed = Number(trainingStepsLeft.fixedTrainingStepsLeft ?? 0);
  const purchased = Number(trainingStepsLeft.purchasedTrainingSteps ?? 0);

  return {
    priorityActions: Number(priority.maxPriorityActions ?? 0),
    nextRefillAt: priority.nextRefillAt ? Number(priority.nextRefillAt) : null,
    taskPriority: Number(priority.taskPriority ?? 0),
    trainingStepsFixed: fixed,
    trainingStepsPurchased: purchased,
    trainingStepsTotal: fixed + purchased
  };
}

function runPythonScript(filePath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(filePath, args, {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
}

async function processCharacterPromptToTempFile(
  folderPath: string,
  characterName: string,
  characterPrompt: string,
  processorPath: string,
) {
  const normalizedProcessorPath = (processorPath || DEFAULT_LORA_PROCESSOR_PATH).trim();
  const normalizedFolderPath = folderPath.trim();
  const normalizedPrompt = characterPrompt.trim();

  if (!normalizedFolderPath) {
    throw new Error("Folder path is required");
  }
  if (!normalizedPrompt) {
    throw new Error("Character Tags (Dynamic) is empty");
  }
  if (!fs.existsSync(LORA_BRIDGE_SCRIPT)) {
    throw new Error(`Bridge script not found: ${LORA_BRIDGE_SCRIPT}`);
  }

  const pythonCandidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  let lastError: unknown;

  for (const candidate of pythonCandidates) {
    try {
      const { stdout, stderr } = await runPythonScript(candidate, [
        LORA_BRIDGE_SCRIPT,
        normalizedProcessorPath,
        normalizedFolderPath,
        characterName || "character",
        normalizedPrompt,
        TEMP_CHARACTER_PROMPTS_DIR,
      ]);

      const trimmed = stdout.trim();
      if (!trimmed) {
        throw new Error(stderr.trim() || "Bridge returned empty output");
      }

      return JSON.parse(trimmed) as {
        message: string;
        characterFile: string;
        tempFile: string;
        prompts: string[];
      };
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to run lora processor bridge: ${message}`);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readTemplates(): PromptTemplate[] {
  ensureDataDir();
  if (!fs.existsSync(TEMPLATES_FILE)) {
    return [];
  }
  try {
    const content = fs.readFileSync(TEMPLATES_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

function writeTemplates(templates: PromptTemplate[]): void {
  ensureDataDir();
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf-8');
}

function readQueue(): GenerationQueue | null {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return null;
    const content = fs.readFileSync(QUEUE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function writeQueue(queue: GenerationQueue): void {
  ensureDataDir();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
}

let queueWorkerProcess: any = null;
let queueWorkerPid: number | null = null;

function killWorkerProcess(): void {
  if (!queueWorkerPid && !queueWorkerProcess) return;

  try {
    if (process.platform === 'win32' && queueWorkerPid) {
      // On Windows with shell: true, .kill() only kills cmd.exe wrapper.
      // Use taskkill /T /F to kill the entire process tree.
      exec(`taskkill /pid ${queueWorkerPid} /T /F`, (err) => {
        if (err) console.log('[Queue] taskkill warning:', err.message);
      });
    } else if (queueWorkerProcess) {
      queueWorkerProcess.kill('SIGTERM');
    }
  } catch {
    // ignore
  }

  queueWorkerProcess = null;
  queueWorkerPid = null;
}

async function startQueueWorker() {
  if (queueWorkerProcess) {
    killWorkerProcess();
    await new Promise(r => setTimeout(r, 500));
  }

  try {
    console.log('[Queue] Spawning queue worker...');

    // Use npx tsx to run TypeScript directly
    queueWorkerProcess = spawn('npx', ['tsx', QUEUE_WORKER_FILE], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      shell: process.platform === 'win32'
    });

    queueWorkerPid = queueWorkerProcess.pid || null;

    queueWorkerProcess.stdout.on('data', (data: Buffer) => {
      console.log(`[Queue Worker] ${data.toString().trim()}`);
    });

    queueWorkerProcess.stderr.on('data', (data: Buffer) => {
      console.error(`[Queue Worker Error] ${data.toString().trim()}`);
    });

    queueWorkerProcess.on('error', (err: any) => {
      console.error('[Queue Worker] Spawn error:', err.message);
    });

    queueWorkerProcess.on('exit', (code: number) => {
      console.log(`[Queue Worker] Exited with code ${code}`);
      queueWorkerProcess = null;
      queueWorkerPid = null;
    });

    console.log('[Queue] Worker spawned with PID:', queueWorkerPid);
  } catch (error: any) {
    console.error('Failed to start queue worker:', error.message);
    queueWorkerProcess = null;
    queueWorkerPid = null;
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  ensureCleanTempCharacterPromptsDir();
  app.use(express.json({ limit: '50mb' }));

  // Open Output Folder
  app.get("/api/open-output-folder", (req, res) => {
    try {
      const outputDir = path.join(process.cwd(), 'output');

      // Create output dir if it doesn't exist
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      if (process.platform === 'win32') {
        // Windows: use explorer.exe directly
        execFile('explorer.exe', [outputDir], (error) => {
          if (error) {
            console.error('Error opening folder:', error.message);
          }
        });
      } else if (process.platform === 'darwin') {
        // macOS: use open command
        exec(`open "${outputDir}"`, (error) => {
          if (error) {
            console.error('Error opening folder:', error.message);
          }
        });
      } else {
        // Linux: use xdg-open command
        exec(`xdg-open "${outputDir}"`, (error) => {
          if (error) {
            console.error('Error opening folder:', error.message);
          }
        });
      }

      res.json({ success: true, path: outputDir });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Prompt Templates CRUD
  app.get("/api/templates", (_req, res) => {
    try {
      const templates = readTemplates();
      res.json(templates);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/templates", (req, res) => {
    try {
      const { name, basePrompt, negativePrompt } = req.body;
      if (!name) {
        return res.status(400).json({ error: "Template name is required" });
      }

      ensureDataDir();
      const templates = readTemplates();
      const templateId = `template_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

      const newTemplate: PromptTemplate = {
        id: templateId,
        name,
        basePrompt: basePrompt || "",
        negativePrompt: negativePrompt || ""
      };
      templates.push(newTemplate);
      writeTemplates(templates);

      res.json(newTemplate);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/templates/:id", (req, res) => {
    try {
      const { id } = req.params;
      const { name, basePrompt, negativePrompt } = req.body;

      const templates = readTemplates();
      const template = templates.find(t => t.id === id);
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }

      if (name !== undefined) template.name = name;
      if (basePrompt !== undefined) template.basePrompt = basePrompt;
      if (negativePrompt !== undefined) template.negativePrompt = negativePrompt;

      writeTemplates(templates);
      res.json(template);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/templates/:id", (req, res) => {
    try {
      const { id } = req.params;
      let templates = readTemplates();
      const initialLength = templates.length;
      templates = templates.filter(t => t.id !== id);

      if (templates.length === initialLength) {
        return res.status(404).json({ error: "Template not found" });
      }

      writeTemplates(templates);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Generation Queue Endpoints
  app.post("/api/queue/start", (req, res) => {
    try {
      const {
        basePrompt,
        negativePrompt,
        characters,
        settings
      } = req.body;

      if (!characters || !Array.isArray(characters) || characters.length === 0) {
        return res.status(400).json({ error: "Characters array is required" });
      }

      // Prevent duplicate queue — if one is already running, reject
      const existingQueue = readQueue();
      if (existingQueue && existingQueue.status === 'running') {
        return res.status(409).json({ error: "A queue is already running. Stop it first." });
      }

      // Calculate total images (fallback to 1 line if no promptsFromFile)
      let totalImages = 0;
      for (const char of characters) {
        const lines = char.promptsFromFile || [];
        const lineCount = lines.length > 0 ? lines.length : 1; // Worker falls back to char.prompt
        totalImages += lineCount * (settings?.batchCount || 1);
      }

      const queue: GenerationQueue = {
        id: `queue_${Date.now()}`,
        status: 'running',
        createdAt: new Date().toISOString(),
        settings: settings || {},
        basePrompt: basePrompt || '',
        negativePrompt: negativePrompt || '',
        characters: characters,
        progress: {
          currentCharacterIndex: 0,
          currentLineIndex: 0,
          currentBatchDone: 0,
          totalImages: totalImages,
          doneImages: 0
        }
      };

      writeQueue(queue);
      res.json({ queueId: queue.id, totalImages });

      // Start worker in background
      (async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        await startQueueWorker();
      })();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/queue/status", (_req, res) => {
    try {
      const queue = readQueue();
      if (!queue) {
        return res.json({ status: 'idle', queue: null });
      }
      res.json({
        status: queue.status,
        queue: {
          id: queue.id,
          status: queue.status,
          progress: queue.progress,
          currentChar: queue.characters[queue.progress.currentCharacterIndex]?.name || 'N/A',
          currentLine: queue.progress.currentLineIndex + 1,
          totalLines: queue.characters[queue.progress.currentCharacterIndex]?.promptsFromFile?.length || 0,
          error: queue.error
        }
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/queue/resume", (req, res) => {
    try {
      const queue = readQueue();
      if (!queue) {
        return res.status(404).json({ error: "No queue found" });
      }

      if (queue.status !== 'paused') {
        return res.status(400).json({ error: `Queue status is ${queue.status}, cannot resume` });
      }

      queue.status = 'running';
      queue.error = undefined;
      writeQueue(queue);
      res.json({ ok: true });

      // Start worker in background
      (async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        await startQueueWorker();
      })();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/queue/cancel", (_req, res) => {
    try {
      const queue = readQueue();
      if (!queue) {
        return res.status(404).json({ error: "No queue found" });
      }

      queue.status = 'cancelled';
      writeQueue(queue);

      // Kill the entire worker process tree
      killWorkerProcess();

      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/queue", (_req, res) => {
    try {
      if (fs.existsSync(QUEUE_FILE)) {
        fs.unlinkSync(QUEUE_FILE);
      }
      killWorkerProcess();
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Check for interrupted queue on startup
  const checkInterruptedQueue = () => {
    const queue = readQueue();
    if (queue && queue.status === 'running') {
      console.log('Found interrupted queue, marking as paused');
      queue.status = 'paused';
      writeQueue(queue);
    }
  };

  // Read Prompts from Local Path
  app.post("/api/read-prompts", (req, res) => {
    try {
      const { folderPath } = req.body;
      if (!folderPath) return res.status(400).send("Folder path is required");

      const possiblePaths = [
        path.join(folderPath, 'addfaceless.txt'),
        path.join(folderPath, 'out_tags', 'addfaceless.txt'),
        folderPath // If the path itself is the file
      ];

      let filePath = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p) && fs.lstatSync(p).isFile()) {
          filePath = p;
          break;
        }
      }

      if (!filePath) {
        return res.status(404).send("addfaceless.txt not found in the specified path");
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      res.json({ prompts: lines });
    } catch (error: any) {
      res.status(500).send(error.message);
    }
  });

  app.post("/api/process-character-prompts", async (req, res) => {
    try {
      const { folderPath, characterName, characterPrompt, processorPath } = req.body ?? {};
      const result = await processCharacterPromptToTempFile(
        String(folderPath ?? ""),
        String(characterName ?? "character"),
        String(characterPrompt ?? ""),
        String(processorPath ?? DEFAULT_LORA_PROCESSOR_PATH),
      );
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/novelai/account-status", async (_req, res) => {
    try {
      const authHeader = `Bearer ${HARDCODED_KEY}`;
      const status = await fetchNovelAiAccountStatus(authHeader);
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to load NovelAI account status' });
    }
  });

  // Server-side batch generation - runs independently even if browser closes
  app.post("/api/generate-batch", async (req, res) => {
    const { seeds, basePayload } = req.body;
    if (!Array.isArray(seeds) || seeds.length === 0 || !basePayload) {
      return res.status(400).json({ error: 'seeds and basePayload are required' });
    }

    const batchId = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const total = seeds.length;
    const job: BatchJob = { status: 'running', done: 0, total, images: [] };
    batchJobs.set(batchId, job);

    res.json({ batchId, total });

    // Process in background - continues even if browser disconnects
    (async () => {
      const { folderName, ...novelaiPayload } = basePayload as any;
      const outputDir = path.join(process.cwd(), 'output');
      const sanitizedFolder = sanitizeFolderName(folderName || 'default');
      const charDir = path.join(outputDir, sanitizedFolder);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
      if (!fs.existsSync(charDir)) fs.mkdirSync(charDir);

      for (let i = 0; i < seeds.length; i++) {
        if (job.status !== 'running') break;

        const payload = {
          ...novelaiPayload,
          parameters: { ...novelaiPayload.parameters, seed: seeds[i] }
        };

        try {
          const result = await runGenerationExclusive(() =>
            postNovelAiGenerate(payload, `Bearer ${HARDCODED_KEY}`)
          );

          if (result.status !== 200) {
            job.status = 'error';
            job.error = `NovelAI API error ${result.status}: ${result.errorText || 'Unknown error'}`;
            break;
          }

          saveGeneratedImages(result.images, charDir);
          result.images.forEach((image) => {
            job.images.push({ data: image.buffer.toString('base64'), seed: seeds[i], mimeType: image.mimeType });
          });
          job.done++;
        } catch (error: any) {
          job.status = 'error';
          job.error = error.message;
          break;
        }
      }

      if (job.status === 'running') job.status = 'done';
      // Clean up memory after 10 minutes
      setTimeout(() => batchJobs.delete(batchId), 10 * 60 * 1000);
    })();
  });

  app.get("/api/batch-status/:id", (req, res) => {
    const job = batchJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Batch not found or expired' });

    const offset = parseInt((req.query.offset as string) || '0', 10);
    const newImages = job.images.slice(offset);

    res.json({
      status: job.status,
      done: job.done,
      total: job.total,
      error: job.error,
      newImages,
      nextOffset: job.images.length,
    });
  });

  app.post("/api/batch-cancel/:id", (req, res) => {
    const job = batchJobs.get(req.params.id);
    if (job && job.status === 'running') job.status = 'cancelled';
    res.json({ ok: true });
  });

  // NovelAI Proxy Route
  app.post("/api/generate", async (req, res) => {
    try {
      const { folderName, ...payload } = req.body as any;

      const authHeader = `Bearer ${HARDCODED_KEY}`;
      
      const result = await runGenerationExclusive(() =>
        postNovelAiGenerate(payload, authHeader)
      );
      
      if (result.status !== 200) {
        console.error('NovelAI API Error:', result.errorText);
        return res.status(result.status).send(result.errorText);
      }

      // Lưu ảnh vào folder output
      const outputDir = path.join(process.cwd(), 'output');
      const sanitizedFolderName = sanitizeFolderName(folderName || 'default');
      const charDir = path.join(outputDir, sanitizedFolderName);
      ensureDirectoryExists(outputDir);
      saveGeneratedImages(result.images, charDir);
      const zipBuffer = await createZipFromImages(result.images);

      res.set('Content-Type', 'application/x-zip-compressed');
      res.send(zipBuffer);
    } catch (error: any) {
      console.error('Proxy Fatal Error:', error.message);
      res.status(500).send(error.message);
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`NovelAI Clone Server running on http://localhost:${PORT}`);
    checkInterruptedQueue();
  });
}

startServer();
