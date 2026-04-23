import axios from 'axios';
import JSZip from 'jszip';
import { enhanceTags } from './tagEnhancer';
import {
  clampReferenceValue,
  getDirectorReferenceBaseCaption,
  toDirectorReferenceSecondaryStrength,
  type ReferenceMode
} from './preciseReference';

const ENDPOINT = '/api/generate';

export interface GenerateParams {
  model: string;
  width: number;
  height: number;
  scale: number;
  sampler: string;
  steps: number;
  seed: number;
  n_samples: number;
  ucPreset: number;
  qualityToggle: boolean;
  negative_prompt: string;
  quality_pfx: string;
  highlightEmphasis?: number;
}

export interface CharacterPrompt {
  prompt: string;
  uc: string;
  center: { x: number; y: number };
  enabled: boolean;
}

export interface ReferenceImage {
  data?: string; // data URL or raw base64
  cacheKey?: string;
  strength: number;
  fidelity: number;
  mode: ReferenceMode;
  informationExtracted?: number;
}

interface ReferenceFile {
  fieldName: string;
  data: string;
}

export const buildPayload = (
  prompt: string,
  params: GenerateParams,
  characters: CharacterPrompt[] = [],
  references: ReferenceImage[] = [],
  folderName?: string
) => {
  const seed = params.seed === -1 ? Math.floor(Math.random() * 4294967295) : params.seed;
  const enhancedPrompt = enhanceTags(prompt);
  const fullPrompt = params.qualityToggle ? `${params.quality_pfx}, ${enhancedPrompt}` : enhancedPrompt;
  const activeReferences = references.filter(reference => Boolean(reference.cacheKey || reference.data));
  const referenceFiles: ReferenceFile[] = activeReferences
    .filter(reference => Boolean(reference.data))
    .map((reference, index) => ({
      fieldName: `director_ref_${index}`,
      data: reference.data!
    }));
  const directorReferencePayload = activeReferences.length > 0
    ? {
        director_reference_descriptions: activeReferences.map(reference => ({
          caption: {
            base_caption: getDirectorReferenceBaseCaption(reference.mode),
            char_captions: []
          },
          legacy_uc: false
        })),
        director_reference_information_extracted: activeReferences.map(reference => (
          reference.informationExtracted ?? 1
        )),
        director_reference_strength_values: activeReferences.map(reference => (
          clampReferenceValue(reference.strength)
        )),
        director_reference_secondary_strength_values: activeReferences.map(reference => (
          toDirectorReferenceSecondaryStrength(reference.fidelity)
        )),
        director_reference_images_cached: activeReferences.map((reference, index) => ({
          cache_secret_key: reference.cacheKey || '',
          data: reference.data ? referenceFiles[index]?.fieldName || `director_ref_${index}` : undefined
        })),
        stream: 'msgpack'
      }
    : {};

  return {
    input: fullPrompt,
    model: params.model,
    action: "generate",
    folderName: folderName || 'default',
    referenceFiles,
    parameters: {
      params_version: 3,
      width: params.width,
      height: params.height,
      scale: params.scale,
      sampler: params.sampler,
      steps: params.steps,
      n_samples: params.n_samples || 1,
      ucPreset: params.ucPreset,
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
      v4_prompt: {
        caption: {
          base_caption: fullPrompt,
          char_captions: characters.map(c => ({
            char_caption: enhanceTags(c.prompt),
            centers: [c.center]
          }))
        },
        use_coords: true,
        use_order: true
      },
      v4_negative_prompt: {
        caption: {
          base_caption: params.negative_prompt,
          char_captions: []
        },
        legacy_uc: false
      },
      highlightEmphasis: params.highlightEmphasis || 1.0,
      negative_prompt: params.negative_prompt,
      seed,
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
      image_format: "png",
      characterPrompts: characters.map(c => ({
        prompt: c.prompt,
        uc: c.uc,
        center: c.center
      })),
      ...directorReferencePayload
    }
  };
};

export const generateImageBatch = async (
  seeds: number[],
  basePayload: object
): Promise<{ batchId: string; total: number }> => {
  const response = await axios.post('/api/generate-batch', { seeds, basePayload });
  return response.data;
};

export const getBatchStatus = async (
  batchId: string,
  offset: number
): Promise<{
  status: 'running' | 'done' | 'error' | 'cancelled';
  done: number;
  total: number;
  newImages: { data: string; seed: number; mimeType: string }[];
  nextOffset: number;
  error?: string;
}> => {
  const response = await axios.get(`/api/batch-status/${batchId}?offset=${offset}`);
  return response.data;
};

export const cancelBatch = async (batchId: string): Promise<void> => {
  await axios.post(`/api/batch-cancel/${batchId}`).catch(() => {});
};

export const generateImage = async (
  prompt: string,
  params: GenerateParams,
  characters: CharacterPrompt[] = [],
  references: ReferenceImage[] = [],
  apiKey?: string,
  folderName?: string,
  abortSignal?: AbortSignal
) => {
  const payload = buildPayload(prompt, params, characters, references, folderName);
  const baseSeed = payload.parameters.seed;

  try {
    const response = await axios.post(ENDPOINT, payload, {
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
      },
      responseType: 'arraybuffer',
      signal: abortSignal
    });

    const zip = new JSZip();
    const zipData = await zip.loadAsync(response.data);
    
    const results: { imageUrl: string; seed: number; blob: Blob }[] = [];
    const files = Object.values(zipData.files).filter(f => !f.dir && /\.(png|jpe?g|webp)$/i.test(f.name));
    
    for (const file of files) {
      const buffer = await file.async('arraybuffer');
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
      const mimeType = ext === 'png'
        ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'webp'
            ? 'image/webp'
            : 'application/octet-stream';
      const imageBlob = new Blob([buffer], { type: mimeType });
      const imageUrl = URL.createObjectURL(imageBlob);
      results.push({
        imageUrl,
        seed: baseSeed + results.length,
        blob: imageBlob
      });
    }

    return results;
  } catch (error: any) {
    let message = "Failed to generate image";
    if (error.response?.data instanceof ArrayBuffer) {
      const decoder = new TextDecoder("utf-8");
      const text = decoder.decode(error.response.data);
      try {
        const json = JSON.parse(text);
        message = json.message || message;
      } catch {
        message = text || message;
      }
    } else {
      message = error.message;
    }
    console.error('NovelAI API Error:', message);
    throw new Error(message);
  }
};
