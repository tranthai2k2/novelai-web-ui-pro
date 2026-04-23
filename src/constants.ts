export const SAMPLERS = [
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m',
  'k_dpmpp_sde',
  'ddim'
];

export const MODEL_OPTIONS = [
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-full'
];

export const SIZE_PRESETS = {
  'Portrait': { width: 832, height: 1216 },
  'Landscape': { width: 1216, height: 832 },
  'Square': { width: 1024, height: 1024 }
};

export const QUALITY_PRESETS = {
  'Heavy': 'masterpiece, best quality, absurdres, highres, highly detailed',
  'Light': 'masterpiece, best quality',
  'None': ''
};

export const DEFAULT_PROMPT = 'masterpiece, best quality, amazing quality, unconventional supreme masterpiece, very aesthetic, absurdres, sophisticated, shiny skin, beautiful face, ultra-detailed face, ultra-detailed eyes, best quality, perfect hands, best hands, perfect anatomy, perfect proportion, extremely smooth skin, thin hair, shiny hair, skin-tight clothes, beautiful eyes, (( narrow waist , wide hips, curvy)), artist::lieolo, lightria, lioreo, mature female, very aesthetic, best quality, amazing qualityuncensored, 1.2::achan (blue semi), :: Kiko.L, arist::liang xing::, 1.4::lightria, ::artist:meion, arist:MeioN, 2::lightria::, 1.5::piromizu::, artist:jasony, 1.3::nixeu::,,1.5::1girl, tsurime, kuudere, huge breasts ::, 0.5:: gigantic breasts ::, wide ass';

export const UC_PRESETS = {
  'Heavy': 0,
  'Light': 1,
  'None': 2
};

export const REF_MODES = {
  'Character & Style': 'characterAndStyle',
  'Character': 'character',
  'Style': 'style'
} as const;

export const DEFAULT_NEGATIVE = 'worst quality, low quality, normal quality, lowres, jpeg artifacts, blurry, aliasing, bad anatomy, bad hands, extra fingers, fewer fingers, missing fingers, fused fingers, extra digits, extra limbs, missing limbs, extra arms, extra legs, deformed, disfigured, mutated, malformed, ugly, bad proportions, wrong proportions, body horror, twisted body, contorted, duplicate, clone, error, cropped, signature, watermark, username, monochrome, greyscale, 2:: ass focus::, blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page, worst quality, low quality, normal quality, lowres, jpeg artifacts, blurry, bad anatomy, bad hands, extra fingers, fewer fingers, missing fingers, fused fingers, extra digits, extra limbs, missing limbs, extra arms, extra legs, deformed, disfigured, mutated, malformed, ugly, bad proportions, wrong proportions, body horror, twisted body, contorted, duplicate, clone, error, 2::text focus, text, aritst name, chinese text::';
