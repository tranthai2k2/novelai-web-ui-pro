import fs from 'fs';
import path from 'path';
import axios from 'axios';
import crypto from 'crypto';

const QUEUE_FILE = path.join(process.cwd(), 'data', 'generation-queue.json');
const API_BASE = 'http://localhost:3000';

interface Queue {
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

function readQueue(): Queue | null {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return null;
    const content = fs.readFileSync(QUEUE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

function writeQueue(queue: Queue): void {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampReferenceValue(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function stripDataUrlPrefix(data: string): string {
  const commaIndex = data.indexOf(',');
  return commaIndex === -1 ? data : data.slice(commaIndex + 1);
}

function computeReferenceCacheKey(data: string): string {
  const base64 = stripDataUrlPrefix(data);
  const buffer = Buffer.from(base64, 'base64');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function callApiGenerate(payload: any, retries = 5): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt++) {
    // Check if queue was cancelled during retry
    const currentQueue = readQueue();
    if (currentQueue?.status !== 'running') {
      console.log('[Worker] ✗ Queue cancelled during retry');
      return false;
    }

    try {
      console.log(`[Worker] Attempt ${attempt + 1}/${retries}...`);
      const response = await axios.post(`${API_BASE}/api/generate`, payload, {
        timeout: 180000, // 3 minutes
        maxRedirects: 5,
        validateStatus: () => true
      });

      console.log(`[Worker] Response status:`, response.status);

      if (response.status === 200) {
        console.log(`[Worker] ✓ Image generated successfully`);
        return true;
      } else if (response.status === 429) {
        console.log(`[Worker] 429 Lock, retry in 3s...`);
        // Sleep but check for cancellation periodically
        for (let i = 0; i < 6; i++) {
          await sleep(500);
          const cancelCheck = readQueue();
          if (cancelCheck?.status !== 'running') {
            console.log('[Worker] ✗ Queue cancelled during lock wait');
            return false;
          }
        }
      } else {
        console.error(`[Worker] ✗ API error ${response.status}:`,
          typeof response.data === 'string'
            ? response.data.substring(0, 200)
            : JSON.stringify(response.data).substring(0, 200)
        );

        if (attempt < retries - 1) {
          const backoffMs = 2000 * (attempt + 1);
          // Sleep but check for cancellation every 500ms
          for (let i = 0; i < backoffMs; i += 500) {
            await sleep(Math.min(500, backoffMs - i));
            const cancelCheck = readQueue();
            if (cancelCheck?.status !== 'running') {
              console.log('[Worker] ✗ Queue cancelled during backoff wait');
              return false;
            }
          }
        }
      }
    } catch (error: any) {
      console.error(`[Worker] ✗ Connection error:`, error.code || error.message);
      if (attempt < retries - 1) {
        const backoffMs = 2000 * (attempt + 1);
        for (let i = 0; i < backoffMs; i += 500) {
          await sleep(Math.min(500, backoffMs - i));
          const cancelCheck = readQueue();
          if (cancelCheck?.status !== 'running') {
            console.log('[Worker] ✗ Queue cancelled during error backoff');
            return false;
          }
        }
      }
    }
  }
  return false;
}

async function processQueue() {
  console.log('[Worker] === Starting Queue Processing ===');

  const queue = readQueue();
  if (!queue) {
    console.error('[Worker] ✗ No queue file found at:', QUEUE_FILE);
    return;
  }

  console.log('[Worker] Queue:',  queue.id);
  console.log('[Worker] Status:', queue.status);
  console.log('[Worker] Characters:', queue.characters.length);

  if (queue.status !== 'running') {
    console.log(`[Worker] Queue is ${queue.status}, exiting`);
    return;
  }

  const { currentCharacterIndex, currentLineIndex, currentBatchDone } = queue.progress;

  try {
    for (let charIdx = currentCharacterIndex; charIdx < queue.characters.length; charIdx++) {
      const character = queue.characters[charIdx];

      const promptLines = character.promptsFromFile && character.promptsFromFile.length > 0
        ? character.promptsFromFile
        : [character.prompt || ''];

      const startLineIdx = charIdx === currentCharacterIndex ? currentLineIndex : 0;

      for (let lineIdx = startLineIdx; lineIdx < promptLines.length; lineIdx++) {
        const filePrompt = promptLines[lineIdx] || '';
        const combinedPrompt = [filePrompt, character.prompt, queue.basePrompt]
          .filter(p => p && p.trim())
          .join(', ');

        const batchCount = queue.settings.batchCount || 1;
        const startBatch = charIdx === currentCharacterIndex && lineIdx === currentLineIndex ? currentBatchDone : 0;

        for (let batchIdx = startBatch; batchIdx < batchCount; batchIdx++) {
          // Check if still running
          const currentQueue = readQueue();
          if (currentQueue?.status !== 'running') {
            console.log('[Worker] ✗ Queue cancelled by user');
            queue.status = 'cancelled';
            writeQueue(queue);
            return;
          }

          console.log(`\n[Worker] Char ${charIdx + 1}/${queue.characters.length}: ${character.name}`);
          console.log(`[Worker] Line ${lineIdx + 1}/${promptLines.length}, Batch ${batchIdx + 1}/${batchCount}`);

          // Build proper payload - match buildPayload structure
          const seed = Math.floor(Math.random() * 4294967295);
          const baseCaption = queue.settings.qualityToggle && queue.settings.quality_pfx
            ? `${queue.settings.quality_pfx}, ${combinedPrompt}`
            : combinedPrompt;
          const rawReferenceData = character.referenceData || character.image || '';
          const hasReference = Boolean(rawReferenceData);
          const referenceFieldName = 'director_ref_0';
          const referenceCacheKey = hasReference
            ? (character.referenceCacheKey || computeReferenceCacheKey(rawReferenceData))
            : '';

          if (hasReference && !String(queue.settings.model || '').includes('4-5')) {
            throw new Error('Precise Reference only works on NovelAI V4.5 models.');
          }

          const payload = {
            input: baseCaption,
            model: queue.settings.model || 'nai-diffusion-4-5-curated',
            action: "generate",
            folderName: character.name,
            referenceFiles: hasReference ? [{
              fieldName: referenceFieldName,
              data: rawReferenceData
            }] : [],
            parameters: {
              params_version: 3,
              width: queue.settings.width || 832,
              height: queue.settings.height || 1216,
              scale: queue.settings.scale || 5.0,
              sampler: queue.settings.sampler || 'k_euler_ancestral',
              steps: queue.settings.steps || 28,
              n_samples: 1,
              ucPreset: queue.settings.ucPreset || 0,
              qualityToggle: false,
              autoSmea: false,
              dynamic_thresholding: false,
              controlnet_strength: 1,
              legacy: false,
              add_original_image: true,
              cfg_rescale: 0,
              noise_schedule: "karras",
              legacy_v3_extend: false,
              skip_cfg_above_sigma: null,
              use_coords: true,
              normalize_reference_strength_multiple: true,
              inpaintImg2ImgStrength: 1,
              negative_prompt: queue.negativePrompt || '',
              seed: seed,
              deliberate_euler_ancestral_bug: false,
              prefer_brownian: true,
              image_format: "png",
              highlightEmphasis: 1.0,
              characterPrompts: [],
              v4_prompt: {
                caption: {
                  base_caption: baseCaption,
                  char_captions: []
                },
                use_coords: true,
                use_order: true
              },
              v4_negative_prompt: {
                caption: {
                  base_caption: queue.negativePrompt || '',
                  char_captions: []
                },
                legacy_uc: false
              },
              ...(hasReference
                ? {
                    director_reference_descriptions: [{
                      caption: {
                        base_caption: 'character',
                        char_captions: []
                      },
                      legacy_uc: false
                    }],
                    director_reference_information_extracted: [1],
                    director_reference_strength_values: [clampReferenceValue(character.strength ?? 1)],
                    director_reference_secondary_strength_values: [clampReferenceValue(1 - (character.fidelity ?? 1))],
                    director_reference_images_cached: [{
                      cache_secret_key: referenceCacheKey,
                      data: referenceFieldName
                    }],
                    stream: 'msgpack'
                  }
                : {})
            }
          };

          const success = await callApiGenerate(payload, 5);
          if (!success) {
            // Check if failure was due to cancellation
            const statusCheck = readQueue();
            if (statusCheck?.status !== 'running') {
              console.log('[Worker] ✗ Generation stopped (queue cancelled)');
              return; // Exit cleanly — don't overwrite status
            }
            console.error('[Worker] ✗ Failed after retries');
            throw new Error('API generation failed after retries');
          }

          // Update progress
          queue.progress.currentCharacterIndex = charIdx;
          queue.progress.currentLineIndex = lineIdx;
          queue.progress.currentBatchDone = batchIdx + 1;
          queue.progress.doneImages += 1;
          writeQueue(queue);

          console.log(`[Worker] ✓ Progress: ${queue.progress.doneImages}/${queue.progress.totalImages}`);

          // Delay between generations
          const delay = queue.settings.delaySeconds || 0.15;
          if (batchIdx < batchCount - 1 || lineIdx < promptLines.length - 1) {
            const waitMs = Math.max(500, delay * 1000);
            console.log(`[Worker] Waiting ${waitMs}ms...`);
            // Check cancellation during delay every 500ms
            for (let i = 0; i < waitMs; i += 500) {
              await sleep(Math.min(500, waitMs - i));
              const cancelCheck = readQueue();
              if (cancelCheck?.status !== 'running') {
                console.log('[Worker] ✗ Queue cancelled during delay');
                queue.status = 'cancelled';
                writeQueue(queue);
                return;
              }
            }
          }
        }

        queue.progress.currentBatchDone = 0;
        writeQueue(queue);
      }

      queue.progress.currentLineIndex = 0;
      writeQueue(queue);
    }

    // All done
    queue.status = 'done';
    queue.progress.doneImages = queue.progress.totalImages;
    writeQueue(queue);
    console.log('[Worker] ✓✓✓ Queue Completed Successfully! ✓✓✓');
  } catch (error: any) {
    console.error('[Worker] ✗ Processing error:', error.message);
    queue.status = 'paused';
    queue.error = error.message;
    writeQueue(queue);
  }
}

console.log('[Worker] Process started, PID:', process.pid);
console.log('[Worker] API Base:', API_BASE);
console.log('[Worker] Queue file:', QUEUE_FILE);

processQueue().then(() => {
  console.log('[Worker] Processing finished, exiting');
  process.exit(0);
}).catch(err => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
