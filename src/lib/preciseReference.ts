export const PRECISE_REFERENCE_CANVAS_SIZES = [
  { width: 1024, height: 1536 },
  { width: 1472, height: 1472 },
  { width: 1536, height: 1024 }
] as const;

export type ReferenceMode = 'character' | 'style' | 'characterAndStyle';

const MODE_TO_BASE_CAPTION: Record<ReferenceMode, string> = {
  character: 'character',
  style: 'style',
  characterAndStyle: 'character&style'
};

export function clampReferenceValue(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function getDirectorReferenceBaseCaption(mode: ReferenceMode): string {
  return MODE_TO_BASE_CAPTION[mode];
}

export function toDirectorReferenceSecondaryStrength(fidelity: number): number {
  return clampReferenceValue(1 - fidelity);
}

export function stripDataUrlPrefix(data: string): string {
  const commaIndex = data.indexOf(',');
  return commaIndex === -1 ? data : data.slice(commaIndex + 1);
}

export function getDataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1] || 'image/png';
}

export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = stripDataUrlPrefix(dataUrl);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function computePreciseReferenceCacheKey(dataUrl: string): Promise<string> {
  const bytes = dataUrlToUint8Array(dataUrl);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function chooseReferenceCanvasSize(width: number, height: number) {
  const aspect = width / height;

  return PRECISE_REFERENCE_CANVAS_SIZES.reduce((best, size) => {
    const bestAspect = best.width / best.height;
    const currentAspect = size.width / size.height;

    return Math.abs(currentAspect - aspect) < Math.abs(bestAspect - aspect) ? size : best;
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load reference image'));
    image.src = dataUrl;
  });
}

export async function normalizePreciseReferenceDataUrl(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl);
  const targetSize = chooseReferenceCanvasSize(image.width, image.height);
  const scale = Math.min(targetSize.width / image.width, targetSize.height / image.height);
  const drawWidth = Math.max(1, Math.round(image.width * scale));
  const drawHeight = Math.max(1, Math.round(image.height * scale));
  const offsetX = Math.floor((targetSize.width - drawWidth) / 2);
  const offsetY = Math.floor((targetSize.height - drawHeight) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = targetSize.width;
  canvas.height = targetSize.height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to prepare reference canvas');
  }

  // Match NovelAI's large reference canvases by centering the image on black padding.
  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);

  return canvas.toDataURL('image/png');
}
