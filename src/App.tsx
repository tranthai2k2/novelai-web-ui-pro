import { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plus,
  Image as ImageIcon,
  Play,
  Download,
  RefreshCw,
  Layers,
  X,
  Check,
  Search,
  Maximize2,
  Square,
  Zap,
  FolderOpen,
  Save,
  Trash2
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useDropzone } from 'react-dropzone';

import { 
  MODEL_OPTIONS,
  SAMPLERS, 
  SIZE_PRESETS, 
  QUALITY_PRESETS, 
  UC_PRESETS, 
  REF_MODES, 
  DEFAULT_PROMPT,
  DEFAULT_NEGATIVE 
} from './constants';
import {
  generateImage,
  buildPayload,
  generateImageBatch,
  getBatchStatus,
  cancelBatch,
  type GenerateParams,
  type CharacterPrompt,
  type ReferenceImage
} from './lib/novelai';
import {
  computePreciseReferenceCacheKey,
  normalizePreciseReferenceDataUrl,
  type ReferenceMode
} from './lib/preciseReference';
import { useTagAutocomplete, buildEmphasisTag } from './hooks/useTagAutocomplete';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function preparePreciseReferenceFile(file: File) {
  const previewData = await readFileAsDataUrl(file);
  const data = await normalizePreciseReferenceDataUrl(previewData);
  const cacheKey = await computePreciseReferenceCacheKey(data);
  return { previewData, data, cacheKey };
}

interface Reference {
  id: string;
  data: string;
  previewData: string;
  cacheKey: string;
  strength: number;
  fidelity: number;
  name: string;
  mode: ReferenceMode;
}

interface Multiple {
  id: string;
  name: string;
  prompt: string;
  folder: string;
  image?: string;
  referenceData?: string;
  referenceCacheKey?: string;
  strength: number;
  fidelity: number;
  promptsFromFile?: string[]; // Danh sách các dòng prompt từ file txt
  currentFileIndex?: number;  // Chỉ số dòng đang sử dụng
  tempPromptFile?: string;
}

interface PromptTemplate {
  id: string;
  name: string;
  basePrompt: string;
  negativePrompt: string;
  imageData?: string;
}

interface NovelAiAccountStatus {
  priorityActions: number;
  nextRefillAt: number | null;
  taskPriority: number;
  trainingStepsFixed: number;
  trainingStepsPurchased: number;
  trainingStepsTotal: number;
}

const PRECISE_REFERENCE_ANLAS_COST = 5;
const ANLAS_BALANCE_STORAGE_KEY = 'novelai-web-ui-pro.anlas-balance';

export default function App() {
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers ignore custom text here, but setting returnValue still triggers
      // the native leave-page confirmation dialog.
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // --- State ---
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_NEGATIVE);
  const [params, setParams] = useState<GenerateParams>({
    model: 'nai-diffusion-4-5-curated',
    width: 832,
    height: 1216,
    steps: 28,
    scale: 5.0,
    sampler: 'k_euler_ancestral',
    seed: -1,
    n_samples: 1,
    ucPreset: 0,
    qualityToggle: true,
    negative_prompt: DEFAULT_NEGATIVE,
    quality_pfx: QUALITY_PRESETS.Heavy
  });
  const [highlightEmphasis, setHighlightEmphasis] = useState(1.0);

  const [multiples, setMultiples] = useState<Multiple[]>([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [history, setHistory] = useState<{ imageUrl: string; seed: number; prompt: string }[]>([]);
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [results, setResults] = useState<{ imageUrl: string; seed: number; blob: Blob }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(true);
  const [loraProcessorPath, setLoraProcessorPath] = useState('D:\\no\\lora_processor.py');
  const [anlasBalance, setAnlasBalance] = useState(0);
  const [novelAiAccountStatus, setNovelAiAccountStatus] = useState<NovelAiAccountStatus | null>(null);

  // Template states
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [showTemplatePanel, setShowTemplatePanel] = useState(false);
  const [templateSaveName, setTemplateSaveName] = useState('');

  // Focus Mode states
  const [focusMode, setFocusMode] = useState(false);
  const [queueProgress, setQueueProgress] = useState<{
    total: number;
    done: number;
    currentChar: string;
    currentLine: number;
    totalLines: number;
  } | null>(null);

  // Queue states
  const [showQueueInterruptedBanner, setShowQueueInterruptedBanner] = useState(false);
  const [queueInterruptedError, setQueueInterruptedError] = useState<string | null>(null);
  const [queueBannerDismissed, setQueueBannerDismissed] = useState(false);
  const queuePollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-browse states
  const [autoBrowsingCharacterId, setAutoBrowsingCharacterId] = useState<string | null>(null);
  const [autoBrowseDelay, setAutoBrowseDelay] = useState(0.15); // giây
  const [batchCount, setBatchCount] = useState(1);
  const [activeDynamicCharacterId, setActiveDynamicCharacterId] = useState<string | null>(null);
  const stopAllRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const batchIdRef = useRef<string | null>(null);
  
  // UI States
  const [activeTab, setActiveTab] = useState<'prompt' | 'negative' | 'reference' | 'multiple' | 'settings' | 'templates'>('prompt');
  const [showReferenceMode, setShowReferenceMode] = useState(false);

  // --- Autocomplete ---
  const { suggestions, activeSuggestion, setSuggestions, tagPrefix: promptTagPrefix } = useTagAutocomplete(prompt);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const {
    suggestions: negativeSuggestions,
    activeSuggestion: activeNegativeSuggestion,
    setSuggestions: setNegativeSuggestions,
    tagPrefix: negativeTagPrefix
  } = useTagAutocomplete(negativePrompt);
  const negativePromptRef = useRef<HTMLTextAreaElement>(null);
  const dynamicPromptValue = multiples.find(m => m.id === activeDynamicCharacterId)?.prompt || '';
  const {
    suggestions: dynamicSuggestions,
    activeSuggestion: activeDynamicSuggestion,
    setSuggestions: setDynamicSuggestions,
    tagPrefix: dynamicTagPrefix
  } = useTagAutocomplete(dynamicPromptValue);
  const dynamicPromptRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const hasLoadedStoredAnlasRef = useRef(false);

  const getCharacterPromptLineCount = (character?: Multiple) => {
    const lines = character?.promptsFromFile || [];
    return lines.length > 0 ? lines.length : 1;
  };

  const hasCharacterPreciseReference = (character?: Multiple) => {
    return Boolean(character?.referenceData || character?.image);
  };

  const getCharacterPreciseReferenceCalls = (character?: Multiple) => {
    if (!hasCharacterPreciseReference(character)) {
      return 0;
    }
    return getCharacterPromptLineCount(character) * Math.max(1, Math.floor(batchCount));
  };

  const currentCharacterForEstimate =
    multiples.find(m => m.id === (activeDynamicCharacterId || autoBrowsingCharacterId || selectedCharacterId)) ||
    multiples[0];
  const currentGenerateReferenceCalls = hasCharacterPreciseReference(currentCharacterForEstimate)
    ? Math.max(1, Math.floor(batchCount))
    : 0;
  const currentGenerateAnlasEstimate = currentGenerateReferenceCalls * PRECISE_REFERENCE_ANLAS_COST;
  const queueReferenceCalls = multiples.reduce((total, character) => (
    total + getCharacterPreciseReferenceCalls(character)
  ), 0);
  const queueAnlasEstimate = queueReferenceCalls * PRECISE_REFERENCE_ANLAS_COST;
  const anlasAfterGenerate = Math.max(0, anlasBalance - currentGenerateAnlasEstimate);
  const anlasAfterQueue = Math.max(0, anlasBalance - queueAnlasEstimate);

  const getUniqueSeed = (usedSeeds: Set<number>) => {
    let candidate = Math.floor(Math.random() * 4294967295);
    while (usedSeeds.has(candidate)) {
      candidate = (candidate + 1) % 4294967295;
    }
    usedSeeds.add(candidate);
    return candidate;
  };

  const isAbortError = (err: any) => {
    return (
      err?.name === 'CanceledError' ||
      err?.code === 'ERR_CANCELED' ||
      err?.message === 'canceled' ||
      err?.message === 'canceled by user'
    );
  };

  const syncCharacterPrompts = async (character: Multiple) => {
    const response = await fetch('/api/process-character-prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderPath: character.folder,
        characterName: character.name,
        characterPrompt: character.prompt,
        processorPath: loraProcessorPath
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to process character prompt');
    }

    const prompts = Array.isArray(data.prompts) ? data.prompts.filter((line: string) => line?.trim().length > 0) : [];
    if (prompts.length === 0) {
      throw new Error('Processor returned no prompt lines');
    }

    setMultiples(prev => prev.map(item => item.id === character.id ? {
      ...item,
      promptsFromFile: prompts,
      currentFileIndex: 0,
      tempPromptFile: data.tempFile
    } : item));

    return {
      prompts,
      tempPromptFile: data.tempFile as string | undefined
    };
  };

  // Template functions
  const loadTemplates = async () => {
    try {
      const response = await fetch('/api/templates');
      if (response.ok) {
        const data = await response.json();
        setTemplates(data);
      }
    } catch (err) {
      console.error('Failed to load templates:', err);
    }
  };

  const saveTemplate = async () => {
    if (!templateSaveName.trim()) {
      setError('Template name required');
      return;
    }

    const saveName = templateSaveName.trim();

    try {
      const response = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: saveName,
          basePrompt: prompt,
          negativePrompt: negativePrompt
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        setError(`Save failed: ${errData.error || 'Unknown error'}`);
        return;
      }

      // Success - clear input
      setTemplateSaveName('');

      // Reload templates
      await loadTemplates();
    } catch (err) {
      console.error('Template save error:', err);
      setError(`Error: ${err}`);
    }
  };

  const loadTemplate = (template: PromptTemplate) => {
    if (template.basePrompt) setPrompt(template.basePrompt);
    if (template.negativePrompt) setNegativePrompt(template.negativePrompt);
  };

  const deleteTemplate = (e: any, templateId: string) => {
    e.preventDefault();
    e.stopPropagation();

    // Optimistic update - remove from UI immediately, no success toast
    setTemplates(prev => prev.filter(t => t.id !== templateId));

    // Send delete request in background (fire-and-forget)
    fetch(`/api/templates/${templateId}`, { method: 'DELETE' })
      .then(response => {
        if (!response.ok) {
          // If server delete failed, reload templates to restore
          loadTemplates();
        }
      })
      .catch(() => {
        // On network error, reload to restore
        loadTemplates();
      });
  };

  // Queue functions
  const checkQueueStatus = async () => {
    try {
      const response = await fetch('/api/queue/status');
      const data = await response.json();

      if (data.queue) {
        if (data.queue.status === 'paused') {
          // Only show banner if user hasn't dismissed it
          if (!queueBannerDismissed) {
            setShowQueueInterruptedBanner(true);
          }
          setQueueInterruptedError(data.queue.error || 'Queue was interrupted');
          setIsGenerating(false);
          // Don't change focus mode - let user control it
        } else if (data.queue.status === 'running') {
          // Reset dismissal flag when queue is running
          setQueueBannerDismissed(false);
          setShowQueueInterruptedBanner(false);
          // Only set focus mode on if it's the initial check (no polling yet)
          if (!queuePollIntervalRef.current) {
            setFocusMode(true);
          }
          setIsGenerating(true);
          setQueueProgress({
            total: data.queue.progress.totalImages,
            done: data.queue.progress.doneImages,
            currentChar: data.queue.currentChar,
            currentLine: data.queue.currentLine,
            totalLines: data.queue.totalLines
          });

          // Start polling if queue is running
          if (!queuePollIntervalRef.current) {
            startQueuePolling();
          }
        } else if (data.queue.status === 'done') {
          setQueueBannerDismissed(false);
          setShowQueueInterruptedBanner(false);
          setFocusMode(false);
          setIsGenerating(false);
          if (queuePollIntervalRef.current) {
            clearInterval(queuePollIntervalRef.current);
            queuePollIntervalRef.current = null;
          }
        }
      }
    } catch (err) {
      console.error('Failed to check queue status:', err);
    }
  };

  const startQueuePolling = () => {
    if (queuePollIntervalRef.current) {
      clearInterval(queuePollIntervalRef.current);
    }

    queuePollIntervalRef.current = setInterval(async () => {
      try {
        const statusResponse = await fetch('/api/queue/status');
        const statusData = await statusResponse.json();

        if (statusData.queue) {
          const q = statusData.queue;

          // Only update progress if it actually changed (prevent unnecessary re-renders)
          setQueueProgress(prev => {
            if (prev &&
                prev.total === q.progress.totalImages &&
                prev.done === q.progress.doneImages &&
                prev.currentChar === q.currentChar &&
                prev.currentLine === q.currentLine &&
                prev.totalLines === q.totalLines) {
              return prev; // Return same object to skip re-render
            }
            return {
              total: q.progress.totalImages,
              done: q.progress.doneImages,
              currentChar: q.currentChar,
              currentLine: q.currentLine,
              totalLines: q.totalLines
            };
          });

          if (q.status === 'done') {
            if (queuePollIntervalRef.current) {
              clearInterval(queuePollIntervalRef.current);
              queuePollIntervalRef.current = null;
            }
            setIsGenerating(false);
            setFocusMode(false);
          } else if (q.status !== 'running') {
            if (queuePollIntervalRef.current) {
              clearInterval(queuePollIntervalRef.current);
              queuePollIntervalRef.current = null;
            }
            setIsGenerating(false);
            // Don't turn off focus mode here - let user control it manually
          }
        }
      } catch (err) {
        console.error('Error polling queue status:', err);
      }
    }, 2000);
  };

  const startQueueGeneration = async () => {
    if (multiples.length === 0) {
      setError('Add at least one character before queueing');
      return;
    }

    // Prevent starting a new queue if one is already running
    if (queuePollIntervalRef.current) {
      setError('A queue is already running. Stop it first.');
      return;
    }

    try {
      setError(null);
      setIsGenerating(true);
      setFocusMode(true);

      // First, sync prompts for characters that need processing
      const processedChars = [...multiples];
      for (let i = 0; i < processedChars.length; i++) {
        const char = processedChars[i];
        if (char.folder && char.prompt && !char.promptsFromFile?.length) {
          console.log(`[Queue] Processing character: ${char.name}`);
          try {
            const result = await syncCharacterPrompts(char);
            // Update the character with the new promptsFromFile
            processedChars[i] = {
              ...char,
              promptsFromFile: result.prompts,
              tempPromptFile: result.tempPromptFile
            };
          } catch (err) {
            console.error(`[Queue] Failed to process ${char.name}:`, err);
            setError(`Failed to process ${char.name}: ${err}`);
            setIsGenerating(false);
            setFocusMode(false);
            return;
          }
        }
      }

      // Calculate total images for progress (fallback to 1 if no lines)
      let totalImages = 0;
      for (const char of processedChars) {
        const lines = char.promptsFromFile || [];
        const lineCount = lines.length > 0 ? lines.length : 1;
        totalImages += lineCount * batchCount;
      }

      setQueueProgress({
        total: totalImages,
        done: 0,
        currentChar: processedChars[0]?.name || 'Unknown',
        currentLine: 1,
        totalLines: processedChars[0]?.promptsFromFile?.length || 1
      });

      const response = await fetch('/api/queue/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          basePrompt: prompt,
          negativePrompt: negativePrompt,
          characters: processedChars.map(m => ({
            id: m.id,
            name: m.name,
            prompt: m.prompt,
            folder: m.folder,
            image: m.image,
            referenceData: m.referenceData,
            referenceCacheKey: m.referenceCacheKey,
            strength: m.strength,
            fidelity: m.fidelity,
            promptsFromFile: m.promptsFromFile || []
          })),
          settings: {
            model: params.model,
            width: params.width,
            height: params.height,
            steps: params.steps,
            scale: params.scale,
            sampler: params.sampler,
            ucPreset: params.ucPreset,
            qualityToggle: params.qualityToggle,
            quality_pfx: params.quality_pfx,
            batchCount: batchCount,
            delaySeconds: autoBrowseDelay
          }
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start queue');
      }

      // Start polling for progress
      startQueuePolling();
    } catch (err: any) {
      setError(err.message || 'Failed to start queue');
      setIsGenerating(false);
    }
  };

  const resumeInterruptedQueue = async () => {
    try {
      const response = await fetch('/api/queue/resume', { method: 'POST' });
      if (response.ok) {
        setShowQueueInterruptedBanner(false);
        setQueueBannerDismissed(false);
        setIsGenerating(true);
        setFocusMode(true);
        setQueueInterruptedError(null);

        // Wait a bit for worker to spawn, then start polling
        setTimeout(() => {
          checkQueueStatus();
        }, 500);
      } else {
        const error = await response.json();
        setError(`Failed to resume: ${error.error}`);
      }
    } catch (err) {
      console.error('Failed to resume queue:', err);
      setError(`Resume error: ${err}`);
    }
  };

  const handleStopAll = async () => {
    stopAllRef.current = true;
    setAutoBrowsingCharacterId(null);
    setMultiples(prev => prev.map(item =>
      item.promptsFromFile?.length
        ? { ...item, currentFileIndex: 0 }
        : item
    ));
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (batchIdRef.current) {
      cancelBatch(batchIdRef.current);
      batchIdRef.current = null;
    }

    // Cancel queue generation: kill worker + DELETE queue file entirely
    if (queuePollIntervalRef.current) {
      clearInterval(queuePollIntervalRef.current);
      queuePollIntervalRef.current = null;
    }

    try {
      // DELETE removes the queue file completely — worker will see file gone and exit
      await fetch('/api/queue', { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to delete queue:', err);
    }

    setIsGenerating(false);
    setFocusMode(false);
    setQueueProgress(null);
    setShowQueueInterruptedBanner(false);
    setQueueBannerDismissed(true);
  };

  const handleSelectSuggestion = (tag: string) => {
    const parts = prompt.split(',');
    parts.pop();
    const finalTag = buildEmphasisTag(promptTagPrefix, tag);
    const newPrompt = [...parts, ` ${finalTag}`].join(',').trim();
    setPrompt(newPrompt + ', ');
    setSuggestions([]);
    promptRef.current?.focus();
  };

  const handleSelectNegativeSuggestion = (tag: string) => {
    const parts = negativePrompt.split(',');
    parts.pop();
    const finalTag = buildEmphasisTag(negativeTagPrefix, tag);
    const newPrompt = [...parts, ` ${finalTag}`].join(',').trim();
    setNegativePrompt(newPrompt + ', ');
    setNegativeSuggestions([]);
    negativePromptRef.current?.focus();
  };

  const handleSelectDynamicSuggestion = (characterId: string, tag: string) => {
    const finalTag = buildEmphasisTag(dynamicTagPrefix, tag);
    setMultiples(prev => prev.map(item => {
      if (item.id !== characterId) {
        return item;
      }
      const parts = item.prompt.split(',');
      parts.pop();
      const newPrompt = [...parts, ` ${finalTag}`].join(',').trim();
      return { ...item, prompt: newPrompt + ', ' };
    }));
    setDynamicSuggestions([]);
    dynamicPromptRefs.current[characterId]?.focus();
  };

  // Load templates and check queue on mount
  useEffect(() => {
    loadTemplates();
    checkQueueStatus();
  }, []);

  useEffect(() => {
    const loadNovelAiAccountStatus = async () => {
      try {
        const response = await fetch('/api/novelai/account-status');
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        setNovelAiAccountStatus(data);
      } catch (err) {
        console.error('Failed to load NovelAI account status:', err);
      }
    };

    loadNovelAiAccountStatus();
  }, []);

  useEffect(() => {
    const storedBalance = window.localStorage.getItem(ANLAS_BALANCE_STORAGE_KEY);
    if (!storedBalance) {
      return;
    }

    const parsedBalance = Number(storedBalance);
    if (Number.isFinite(parsedBalance) && parsedBalance >= 0) {
      setAnlasBalance(parsedBalance);
      hasLoadedStoredAnlasRef.current = true;
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(ANLAS_BALANCE_STORAGE_KEY, String(anlasBalance));
  }, [anlasBalance]);

  useEffect(() => {
    if (!novelAiAccountStatus || hasLoadedStoredAnlasRef.current) {
      return;
    }

    setAnlasBalance(novelAiAccountStatus.trainingStepsTotal);
  }, [novelAiAccountStatus]);

  // Handle auto-advance and next generation after current generation completes
  useEffect(() => {
    // Only trigger when generation just completed (isGenerating is false) and auto-browsing is active
    if (isGenerating || !autoBrowsingCharacterId) {
      return;
    }

    const currentChar = multiples.find(m => m.id === autoBrowsingCharacterId);
    if (!currentChar?.promptsFromFile || currentChar.promptsFromFile.length === 0) {
      setAutoBrowsingCharacterId(null);
      return;
    }

    const currentIndex = currentChar.currentFileIndex || 0;
    
    // Check if reached the final line of current character
    if (currentIndex >= currentChar.promptsFromFile.length - 1) {
      // Find current character's index in multiples array
      const currentCharIndex = multiples.findIndex(m => m.id === autoBrowsingCharacterId);
      
      // Find next character that has promptsFromFile
      let nextCharIndex = currentCharIndex + 1;
      while (nextCharIndex < multiples.length) {
        if (multiples[nextCharIndex]?.promptsFromFile?.length) {
          break;
        }
        nextCharIndex++;
      }
      
      // If found next character, auto-advance to it
      if (nextCharIndex < multiples.length) {
        const nextChar = multiples[nextCharIndex];
        setMultiples(prev => prev.map(item =>
          item.id === nextChar.id 
            ? { ...item, currentFileIndex: 0 }
            : item
        ));
        setAutoBrowsingCharacterId(nextChar.id);
        
        // Generate next image with the new character after delay
        const timer = setTimeout(() => {
          if (stopAllRef.current) {
            return;
          }
          handleGenerate({
            forcedCharacterId: nextChar.id,
            forcedFileIndex: 0
          });
        }, Math.max(150, autoBrowseDelay * 1000));
        
        return () => clearTimeout(timer);
      } else {
        // No more characters, stop auto-browsing
        setAutoBrowsingCharacterId(null);
        setIsGenerating(false);
        return;
      }
    }

    const nextIndex = currentIndex + 1;

    // Use delay before generating next image. Prompt index changes when the delayed run starts.
    const timer = setTimeout(() => {
      if (stopAllRef.current) {
        return;
      }
      setMultiples(prev => prev.map(item => 
        item.id === autoBrowsingCharacterId 
          ? { ...item, currentFileIndex: nextIndex } 
          : item
      ));
      handleGenerate({
        forcedCharacterId: autoBrowsingCharacterId,
        forcedFileIndex: nextIndex
      });
    }, Math.max(150, autoBrowseDelay * 1000));

    return () => clearTimeout(timer);
  }, [isGenerating, autoBrowsingCharacterId, multiples, autoBrowseDelay]);


  // --- Handlers ---
  const handleGenerate = async (options?: { forcedCharacterId?: string; forcedFileIndex?: number }) => {
    stopAllRef.current = false;
    setIsGenerating(true);
    setError(null);
    try {
      // Logic mới: Kế thừa Tĩnh + Động (LoRA-like workflow)
      // When auto-browsing, use autoBrowsingCharacterId; otherwise use selectedCharacterId
      const charId = options?.forcedCharacterId || autoBrowsingCharacterId || selectedCharacterId;
      let activeChar = multiples.find(m => m.id === charId) || multiples[0];
      let resolvedPromptsFromFile = activeChar?.promptsFromFile;

      const shouldProcessDynamicCharacter =
        !!activeChar?.folder.trim() &&
        !!activeChar?.prompt.trim() &&
        (!options || options.forcedFileIndex === 0);

      if (activeChar && shouldProcessDynamicCharacter) {
        const processed = await syncCharacterPrompts(activeChar);
        resolvedPromptsFromFile = processed.prompts;
        activeChar = {
          ...activeChar,
          promptsFromFile: processed.prompts,
          currentFileIndex: 0,
          tempPromptFile: processed.tempPromptFile
        };
      }

      // If user clicks Generate manually and this character has addfaceless lines,
      // start auto-browsing from line 0 (or current line) automatically.
      if (!autoBrowsingCharacterId && activeChar?.id && resolvedPromptsFromFile?.length) {
        const startIndex = activeChar.currentFileIndex ?? 0;
        setAutoBrowsingCharacterId(activeChar.id);
        if (activeChar.currentFileIndex === undefined) {
          setMultiples(prev => prev.map(item =>
            item.id === activeChar!.id ? { ...item, currentFileIndex: 0 } : item
          ));
        }
        activeChar = { ...activeChar, currentFileIndex: startIndex };
      }
      
      // 1. Thành phần Động: Prompt từ file (addfaceless) + Tags nhân vật
      const currentFileIndex = options?.forcedFileIndex ?? activeChar?.currentFileIndex ?? 0;
      const filePrompt = resolvedPromptsFromFile?.length
        ? resolvedPromptsFromFile[currentFileIndex]
        : '';
      
      const dynamicPrompt = [filePrompt, activeChar?.prompt].filter(Boolean).join(', ');

      // 2. Thành phần Tĩnh: Base Prompt
      const finalPrompt = [dynamicPrompt, prompt].filter(Boolean).join(', ');

      // 3. Xử lý References (Tĩnh: Style, Động: Character)
      const staticStyleRefs: ReferenceImage[] = references.map(r => ({
        data: r.data,
        cacheKey: r.cacheKey,
        strength: r.strength,
        fidelity: r.fidelity,
        mode: r.mode
      }));

      const dynamicCharData = activeChar?.image
        ? (activeChar.referenceData || await normalizePreciseReferenceDataUrl(activeChar.image))
        : null;
      const dynamicCharCacheKey = dynamicCharData
        ? (activeChar?.referenceCacheKey || await computePreciseReferenceCacheKey(dynamicCharData))
        : null;
      const dynamicCharRef: ReferenceImage[] = dynamicCharData ? [{
        data: dynamicCharData,
        cacheKey: dynamicCharCacheKey || undefined,
        strength: activeChar?.strength ?? 1,
        fidelity: activeChar?.fidelity ?? 1,
        mode: 'character' as const
      }] : [];

      const allRefs = [...staticStyleRefs, ...dynamicCharRef];
      if (allRefs.length > 0 && !params.model.includes('4-5')) {
        throw new Error('Precise Reference only works on NovelAI V4.5 models.');
      }

      const usedSeeds = new Set<number>(history.map(h => h.seed));
      const runCount = Math.max(1, Math.floor(batchCount));
      const allBatchResults: { imageUrl: string; seed: number; blob: Blob }[] = [];

      if (runCount === 1) {
        // Single image - existing behavior with abort support
        const uniqueSeed = params.seed === -1 ? getUniqueSeed(usedSeeds) : params.seed;
        const effectiveParams = {
          ...params,
          seed: uniqueSeed,
          negative_prompt: negativePrompt,
          highlightEmphasis,
          n_samples: 1
        };
        const controller = new AbortController();
        abortControllerRef.current = controller;
        try {
          const res = await generateImage(
            finalPrompt,
            effectiveParams,
            [],
            allRefs as any,
            undefined,
            activeChar?.name || 'default',
            controller.signal
          );
          allBatchResults.push(...res);
        } catch (err: any) {
          if (!isAbortError(err) && !stopAllRef.current) throw err;
        } finally {
          abortControllerRef.current = null;
        }
      } else {
        // Batch mode - runs on server, continues even if browser is closed
        const seeds: number[] = [];
        for (let i = 0; i < runCount; i++) {
          let seed: number;
          if (params.seed === -1) {
            seed = getUniqueSeed(usedSeeds);
          } else {
            seed = params.seed + i;
            while (usedSeeds.has(seed)) seed = (seed + 1) % 4294967295;
            usedSeeds.add(seed);
          }
          seeds.push(seed);
        }

        const baseParams = {
          ...params,
          seed: seeds[0],
          negative_prompt: negativePrompt,
          highlightEmphasis,
          n_samples: 1
        };
        const basePayload = buildPayload(finalPrompt, baseParams, [], allRefs as any, activeChar?.name || 'default');

        const { batchId } = await generateImageBatch(seeds, basePayload);
        batchIdRef.current = batchId;

        let offset = 0;
        while (!stopAllRef.current) {
          const status = await getBatchStatus(batchId, offset);

          for (const img of (status.newImages || [])) {
            const bytes = Uint8Array.from(atob(img.data), c => c.charCodeAt(0));
            const blob = new Blob([bytes], { type: img.mimeType || 'image/png' });
            const imageUrl = URL.createObjectURL(blob);
            allBatchResults.push({ imageUrl, seed: img.seed, blob });
          }

          if (allBatchResults.length > 0) {
            setResults([...allBatchResults]);
          }

          offset = status.nextOffset;

          if (status.status === 'done' || status.status === 'error' || status.status === 'cancelled') {
            if (status.error) throw new Error(status.error);
            break;
          }

          await new Promise<void>(r => setTimeout(r, 1500));
        }

        if (stopAllRef.current && batchIdRef.current) {
          cancelBatch(batchIdRef.current);
        }
        batchIdRef.current = null;
      }

      if (allBatchResults.length > 0) {
        setResults(allBatchResults);
        const newHistory = allBatchResults.map(r => ({ imageUrl: r.imageUrl, seed: r.seed, prompt: finalPrompt }));
        setHistory(prev => [...newHistory, ...prev]);
      }
    } catch (err: any) {
      if (!stopAllRef.current) {
        setError(err.message || 'Generation failed');
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const onDrop = useCallback((acceptedFiles: File[]) => {
    void (async () => {
      for (const file of acceptedFiles) {
        try {
          const { previewData, data, cacheKey } = await preparePreciseReferenceFile(file);
          setReferences(prev => [
            ...prev,
            {
              id: Math.random().toString(36).slice(2, 11),
              data,
              previewData,
              cacheKey,
              strength: 1,
              fidelity: 1,
              name: file.name,
              mode: 'style'
            }
          ]);
        } catch (err: any) {
          setError(err.message || `Failed to prepare ${file.name}`);
        }
      }
    })();
    setActiveTab('reference');
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop, 
    accept: { 'image/*': [] },
    noClick: true 
  } as any);

  return (
    <div className="flex flex-col h-screen bg-[#091413] text-[#B0E4CC] font-sans selection:bg-[#408A71]/30 overflow-hidden" {...getRootProps()}>
      <input {...getInputProps()} />

      {/* Queue Interrupted Banner */}
      <AnimatePresence>
        {showQueueInterruptedBanner && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="bg-[#e94560]/20 border-b border-[#e94560]/30 px-6 py-4 flex items-center justify-between z-50"
          >
            <div className="flex items-center gap-4 flex-1">
              <div className="w-2 h-2 bg-[#e94560] rounded-full animate-pulse" />
              <div>
                <p className="text-[11px] font-bold text-[#ff7a8f]">Queue was interrupted</p>
                {queueInterruptedError && (
                  <p className="text-[9px] text-[#e94560]/70">{queueInterruptedError}</p>
                )}
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={resumeInterruptedQueue}
                className="px-4 py-2 bg-[#408A71] text-white text-[9px] font-bold rounded-lg hover:bg-[#5aaea0] transition-all"
              >
                Resume
              </button>
              <button
                onClick={() => {
                  setShowQueueInterruptedBanner(false);
                  setQueueBannerDismissed(true);
                  // Delete queue file so it never asks again on refresh
                  fetch('/api/queue', { method: 'DELETE' }).catch(() => {});
                }}
                className="px-4 py-2 bg-[#e94560]/30 text-[#ff7a8f] text-[9px] font-bold rounded-lg hover:bg-[#e94560]/50 transition-all"
              >
                Dismiss
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Layout */}
      <div className="flex flex-1 overflow-hidden">

      {/* --- Left Sidebar: Navigation --- */}
      <aside className="w-[180px] flex flex-col border-r border-[#285A48] bg-[#091413] shadow-2xl z-20">
        <div className="p-4 flex flex-col gap-3 mt-10">
          {(['prompt', 'negative', 'reference', 'multiple', 'templates', 'settings'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "w-full py-3 px-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all text-center shadow-md",
                activeTab === tab 
                  ? "bg-[#408A71] text-white shadow-[#408A71]/30 scale-105" 
                  : "bg-[#1d4035] text-[#408A71] hover:bg-[#285A48] hover:text-[#B0E4CC]"
              )}
            >
              {tab === 'reference' ? 'Style Ref' : tab === 'negative' ? 'negative' : tab === 'templates' ? 'Templates' : tab}
            </button>
          ))}
          
          <button 
            onClick={handleGenerate}
            disabled={isGenerating}
            className={cn(
              "w-full py-5 mt-8 rounded-xl font-black text-[10px] uppercase tracking-[0.2em] flex flex-col items-center justify-center gap-2 transition-all shadow-2xl border border-[#B0E4CC]/10",
              isGenerating 
                ? "bg-[#285A48] text-[#408A71] cursor-not-allowed" 
                : "bg-[#408A71] hover:bg-[#5da886] text-white active:scale-[0.98] hover:shadow-[#408A71]/50"
            )}
          >
            {isGenerating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
            {isGenerating ? 'GEN...' : 'GENERATE'}
          </button>

          <button
            onClick={startQueueGeneration}
            disabled={isGenerating || multiples.length === 0}
            className={cn(
              "w-full py-4 rounded-xl font-black text-[10px] uppercase tracking-[0.2em] flex flex-col items-center justify-center gap-2 transition-all shadow-xl border border-[#B0E4CC]/10",
              (isGenerating || multiples.length === 0)
                ? "bg-[#285A48] text-[#408A71] cursor-not-allowed"
                : "bg-[#1d7f5e] hover:bg-[#2a9e75] text-white active:scale-[0.98] hover:shadow-[#1d7f5e]/50"
            )}
          >
            <Zap className="w-4 h-4" />
            QUEUE & RUN
          </button>

          <button
            onClick={handleStopAll}
            disabled={!isGenerating && !autoBrowsingCharacterId}
            className={cn(
              "w-full py-3 rounded-xl font-black text-[10px] uppercase tracking-[0.2em] transition-all border",
              (!isGenerating && !autoBrowsingCharacterId)
                ? "bg-[#2a1a1d] text-[#6b3a42] border-[#4a2a30] cursor-not-allowed"
                : "bg-[#e94560]/20 text-[#ff7a8f] border-[#e94560]/50 hover:bg-[#e94560]/30"
            )}
          >
            STOP ALL
          </button>
        </div>
      </aside>

      {/* --- Middle Panel: Configuration --- */}
      <div className="w-[400px] flex flex-col border-r border-[#285A48] bg-[#091413] z-10">
        <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
          <div className="space-y-3">
            <label className="text-[10px] font-bold uppercase tracking-widest text-[#408A71]">Model</label>
            <select 
              value={params.model}
              onChange={(e) => setParams(prev => ({ ...prev, model: e.target.value }))}
              className="w-full bg-[#1d4035] border border-[#285A48] rounded-2xl px-6 py-4 text-sm text-white outline-none focus:border-[#408A71] appearance-none"
            >
              {MODEL_OPTIONS.map(model => <option key={model} value={model}>{model}</option>)}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-bold uppercase tracking-widest text-[#408A71]">Batch Count</label>
            <input
              type="number"
              min={1}
              max={200}
              value={batchCount}
              onChange={(e) => setBatchCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
              className="w-full bg-[#1d4035] border border-[#285A48] rounded-xl px-4 py-2.5 text-xs text-white outline-none focus:border-[#408A71]"
            />
            <p className="text-[9px] text-[#408A71]/80">Mỗi lần Generate sẽ chạy lặp theo số này, mỗi lượt dùng seed khác nhau.</p>
          </div>

          <div className="space-y-4 rounded-2xl border border-[#285A48] bg-[#10211d] p-4 shadow-inner">
            <div className="flex items-center justify-between gap-3">
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#408A71]">Anlas hiện có</label>
              <input
                type="number"
                min={0}
                step={1}
                value={anlasBalance}
                onChange={(e) => setAnlasBalance(Math.max(0, Number(e.target.value) || 0))}
                className="w-32 bg-[#091413] border border-[#285A48] rounded-xl px-3 py-2 text-right text-xs text-white outline-none focus:border-[#408A71]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-[#285A48] bg-[#091413] p-3 space-y-1">
                <p className="text-[8px] font-bold uppercase tracking-widest text-[#408A71]/80">Generate hiện tại</p>
                <p className="text-lg font-black text-white">{currentGenerateAnlasEstimate}</p>
                <p className="text-[9px] text-[#408A71]/75">
                  {currentGenerateReferenceCalls > 0
                    ? `${currentGenerateReferenceCalls} call PR character x ${PRECISE_REFERENCE_ANLAS_COST}`
                    : 'Không có character Precise Reference'}
                </p>
              </div>

              <div className="rounded-xl border border-[#285A48] bg-[#091413] p-3 space-y-1">
                <p className="text-[8px] font-bold uppercase tracking-widest text-[#408A71]/80">Queue tổng</p>
                <p className="text-lg font-black text-white">{queueAnlasEstimate}</p>
                <p className="text-[9px] text-[#408A71]/75">
                  {queueReferenceCalls > 0
                    ? `${queueReferenceCalls} call PR character x ${PRECISE_REFERENCE_ANLAS_COST}`
                    : 'Chưa có character nào gắn Precise Reference'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-[9px]">
              <div className="rounded-xl bg-[#091413] px-3 py-2 border border-[#285A48] text-[#B0E4CC]">
                Sau Generate: <span className="font-bold text-white">{anlasAfterGenerate}</span>
              </div>
              <div className="rounded-xl bg-[#091413] px-3 py-2 border border-[#285A48] text-[#B0E4CC]">
                Sau Queue: <span className="font-bold text-white">{anlasAfterQueue}</span>
              </div>
            </div>

            {novelAiAccountStatus && (
              <div className="rounded-xl border border-[#285A48] bg-[#091413] p-3 space-y-2">
                <div className="flex items-center justify-between text-[9px] text-[#B0E4CC]">
                  <span>NovelAI Anlas hiện có</span>
                  <span className="font-bold text-white">{novelAiAccountStatus.trainingStepsTotal}</span>
                </div>
                <div className="flex items-center justify-between text-[9px] text-[#B0E4CC]">
                  <span>NovelAI Priority Actions</span>
                  <span className="font-bold text-white">{novelAiAccountStatus.priorityActions}</span>
                </div>
                <div className="flex items-center justify-between text-[9px] text-[#B0E4CC]">
                  <span>Training Steps Left</span>
                  <span className="font-bold text-white">{novelAiAccountStatus.trainingStepsTotal}</span>
                </div>
                <div className="flex items-center justify-between text-[9px] text-[#B0E4CC]">
                  <span>Purchased Steps</span>
                  <span className="font-bold text-white">{novelAiAccountStatus.trainingStepsPurchased}</span>
                </div>
                <div className="flex items-center justify-between text-[9px] text-[#B0E4CC]">
                  <span>Task Priority</span>
                  <span className="font-bold text-white">{novelAiAccountStatus.taskPriority}</span>
                </div>
                {novelAiAccountStatus.nextRefillAt && (
                  <div className="text-[9px] text-[#408A71]/80">
                    Priority refill: {new Date(novelAiAccountStatus.nextRefillAt * 1000).toLocaleString()}
                  </div>
                )}
              </div>
            )}

            <p className="text-[9px] leading-5 text-[#408A71]/80">
              Estimate này đang tính theo rule bạn chốt: không bật <span className="text-white font-bold">Precise Reference</span> thì tốn <span className="text-white font-bold">0 Anlas</span>; mỗi lần gọi có <span className="text-white font-bold">character Precise Reference</span> sẽ tốn <span className="text-white font-bold">5 Anlas</span>. Static Style Reference hiện chưa cộng thêm vào đây.
            </p>
            <p className="text-[9px] leading-5 text-[#408A71]/65">
              Với account này, số live NovelAI trả về đang là <span className="text-white font-bold">{novelAiAccountStatus?.trainingStepsTotal ?? 0}</span> từ <span className="text-white font-bold">Training Steps Left</span>, khớp với số Anlas bạn xác nhận. Ô `Anlas hiện có` phía trên sẽ tự nạp theo số này nếu chưa có giá trị lưu cục bộ.
            </p>
          </div>

          {activeTab === 'prompt' && (
            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              <label className="text-xs font-black uppercase tracking-widest text-[#408A71] flex items-center gap-2">
                <Search className="w-3 h-3" />
                Base Prompt
              </label>
              <div className="rounded-2xl border border-[#285A48] bg-[#091413] p-4 text-[10px] leading-5 text-[#B0E4CC]/80">
                Use `{ "{}" }` to strengthen, `[]` to weaken, and `1.5::tag::` for exact numeric emphasis.
                In Negative Prompt, `{ "{}" }` makes the model avoid that detail more strongly, while `[]` weakens the avoidance.
              </div>
              <div className="relative group">
                <textarea
                  ref={promptRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className="w-full h-80 bg-[#1d4035] border border-[#285A48] rounded-3xl p-6 text-sm font-mono text-white focus:border-[#408A71] outline-none transition-all resize-none shadow-inner"
                  placeholder="Enter tags..."
                />
                {/* Autocomplete Popup */}
                <AnimatePresence>
                  {suggestions.length > 0 && (
                    <motion.div 
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="absolute z-50 left-0 right-0 top-full mt-2 bg-[#091413] border border-[#285A48] rounded-2xl shadow-2xl overflow-hidden"
                    >
                      <div className="max-h-60 overflow-y-auto custom-scrollbar">
                        {suggestions.map((tag, i) => (
                          <button
                            key={tag}
                            onClick={() => handleSelectSuggestion(tag)}
                            className={cn(
                              "w-full text-left px-5 py-3 text-sm transition-all border-b border-[#285A48]/30 last:border-0",
                              i === activeSuggestion ? "bg-[#408A71] text-white" : "text-[#B0E4CC] hover:bg-[#285A48]"
                            )}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.section>
          )}

          {activeTab === 'negative' && (
            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              <label className="text-xs font-black uppercase tracking-widest text-[#408A71]">Negative Prompt</label>
              <div className="rounded-2xl border border-[#285A48] bg-[#091413] p-4 text-[10px] leading-5 text-[#B0E4CC]/80">
                Negative Prompt also supports emphasis syntax: `{"{bad hands}"}` avoids more strongly, `[bad hands]` avoids less strongly, and `0.5::jacket::` lowers a tag numerically.
              </div>
              <div className="relative">
                <textarea
                  ref={negativePromptRef}
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  className="w-full h-80 bg-[#1d4035] border border-[#285A48] rounded-3xl p-6 text-xs font-mono text-[#6e6e9e] focus:border-[#408A71] outline-none transition-all resize-none shadow-inner"
                />
                <AnimatePresence>
                  {negativeSuggestions.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="absolute z-50 left-0 right-0 top-full mt-2 bg-[#091413] border border-[#285A48] rounded-2xl shadow-2xl overflow-hidden"
                    >
                      <div className="max-h-60 overflow-y-auto custom-scrollbar">
                        {negativeSuggestions.map((tag, i) => (
                          <button
                            key={`negative-${tag}`}
                            onClick={() => handleSelectNegativeSuggestion(tag)}
                            className={cn(
                              "w-full text-left px-5 py-3 text-sm transition-all border-b border-[#285A48]/30 last:border-0",
                              i === activeNegativeSuggestion ? "bg-[#408A71] text-white" : "text-[#B0E4CC] hover:bg-[#285A48]"
                            )}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.section>
          )}

          {activeTab === 'multiple' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-widest text-[#408A71]">Character Browser (Dynamic)</p>
                <div className="flex gap-2">
                  <button 
                    onClick={async () => {
                      try {
                        const response = await fetch('/api/open-output-folder');
                        if (response.ok) {
                          const data = await response.json();
                          console.log('Opened folder:', data.path);
                        } else {
                          console.error('Failed to open folder');
                        }
                      } catch (err: any) {
                        console.error('Open folder error:', err.message);
                      }
                    }}
                    className="p-2 bg-[#408A71] text-white rounded-xl hover:bg-[#5da886] transition-all flex items-center gap-1"
                    title="Open output folder"
                  >
                    <FolderOpen className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => {
                      const newChar: Multiple = { 
                        id: Math.random().toString(36).slice(2, 11), 
                        name: 'Character ' + (multiples.length + 1),
                        prompt: '', 
                        folder: '',
                        strength: 1,
                        fidelity: 1
                      };
                      setMultiples([...multiples, newChar]);
                      if (!selectedCharacterId) setSelectedCharacterId(newChar.id);
                    }}
                    className="p-2 bg-[#408A71] text-white rounded-xl hover:bg-[#5da886] transition-all"
                    title="Add new character"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="space-y-6">
                {multiples.map((m) => (
                  <div key={m.id} className={cn(
                    "bg-[#1d4035] border rounded-[2.5rem] p-8 space-y-6 relative shadow-2xl transition-all",
                    selectedCharacterId === m.id ? "border-[#408A71]" : "border-[#285A48] opacity-80"
                  )}>
                    <button 
                      onClick={() => setMultiples(prev => prev.filter(item => item.id !== m.id))}
                      className="absolute top-6 right-6 w-10 h-10 bg-[#e94560] text-white rounded-full flex items-center justify-center shadow-lg hover:scale-110 transition-transform z-10"
                    >
                      <X className="w-5 h-5" />
                    </button>
                    
                    <div className="flex gap-6">
                      <button 
                        onClick={() => setSelectedCharacterId(m.id)}
                        className={cn(
                          "w-32 h-32 rounded-3xl border-2 overflow-hidden relative flex-shrink-0 group/img transition-all",
                          selectedCharacterId === m.id ? "border-[#408A71] shadow-[0_0_20px_rgba(64,138,113,0.4)]" : "border-[#285A48] opacity-50 hover:opacity-100"
                        )}
                      >
                        {m.image ? (
                          <img src={m.image} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[#408A71]/30 bg-[#091413]">
                            <ImageIcon className="w-10 h-10" />
                          </div>
                        )}
                        {selectedCharacterId === m.id && (
                          <div className="absolute inset-0 bg-[#408A71]/20 flex items-center justify-center">
                            <Check className="w-10 h-10 text-white" />
                          </div>
                        )}
                        <label 
                          className="absolute inset-0 bg-[#408A71]/40 opacity-0 group-hover/img:opacity-100 flex items-center justify-center cursor-pointer transition-all backdrop-blur-sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Plus className="w-8 h-8 text-white" />
                          <input 
                            type="file" 
                            className="hidden" 
                            accept="image/*"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                void (async () => {
                                  try {
                                    const { previewData, data, cacheKey } = await preparePreciseReferenceFile(file);
                                    setMultiples(prev => prev.map(item => (
                                      item.id === m.id
                                        ? { ...item, image: previewData, referenceData: data, referenceCacheKey: cacheKey }
                                        : item
                                    )));
                                  } catch (err: any) {
                                    setError(err.message || `Failed to prepare ${file.name}`);
                                  }
                                })();
                              }
                            }}
                          />
                        </label>
                      </button>
                      <div className="flex-1 space-y-4">
                        <div className="space-y-2">
                          <p className="text-[9px] font-bold text-[#408A71] uppercase tracking-widest">Character Name (Output Folder)</p>
                          <input 
                            type="text"
                            value={m.name}
                            onChange={(e) => setMultiples(prev => prev.map(item => item.id === m.id ? { ...item, name: e.target.value } : item))}
                            placeholder="Character Name"
                            className="w-full bg-[#091413] border border-[#285A48] rounded-2xl px-4 py-2 text-xs text-white outline-none focus:border-[#408A71] placeholder-[#408A71]/30"
                          />
                        </div>

                        <div className="space-y-2">
                          <p className="text-[9px] font-bold text-[#408A71] uppercase tracking-widest">Character Tags (Dynamic)</p>
                          <div className="relative">
                            <textarea
                              ref={(el) => {
                                dynamicPromptRefs.current[m.id] = el;
                              }}
                              value={m.prompt}
                              onFocus={() => setActiveDynamicCharacterId(m.id)}
                              onBlur={() => {
                                window.setTimeout(() => {
                                  setDynamicSuggestions([]);
                                  setActiveDynamicCharacterId(current => current === m.id ? null : current);
                                }, 150);
                              }}
                              onChange={(e) => {
                                setActiveDynamicCharacterId(m.id);
                                setMultiples(prev => prev.map(item => item.id === m.id ? { ...item, prompt: e.target.value } : item));
                              }}
                              placeholder="Tags nhận diện nhân vật (Character Prompts)"
                              className="w-full h-48 bg-[#091413] border border-[#285A48] rounded-2xl p-4 text-xs font-mono text-white outline-none focus:border-[#408A71] placeholder-[#408A71]/30 resize-none"
                            />
                            <AnimatePresence>
                              {activeDynamicCharacterId === m.id && dynamicSuggestions.length > 0 && (
                                <motion.div
                                  initial={{ opacity: 0, y: -10 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  exit={{ opacity: 0 }}
                                  className="absolute z-50 left-0 right-0 top-full mt-2 bg-[#091413] border border-[#285A48] rounded-2xl shadow-2xl overflow-hidden"
                                >
                                  <div className="max-h-60 overflow-y-auto custom-scrollbar">
                                    {dynamicSuggestions.map((tag, i) => (
                                      <button
                                        key={`${m.id}-${tag}`}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => handleSelectDynamicSuggestion(m.id, tag)}
                                        className={cn(
                                          "w-full text-left px-5 py-3 text-sm transition-all border-b border-[#285A48]/30 last:border-0",
                                          i === activeDynamicSuggestion ? "bg-[#408A71] text-white" : "text-[#B0E4CC] hover:bg-[#285A48]"
                                        )}
                                      >
                                        {tag}
                                      </button>
                                    ))}
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <div className="flex justify-between text-[10px] text-[#408A71] font-bold uppercase">
                              <span>Strength</span>
                              <span>{m.strength.toFixed(2)}</span>
                            </div>
                            <input 
                              type="range" min="0" max="1" step="0.01"
                              value={m.strength}
                              onChange={(e) => setMultiples(prev => prev.map(item => item.id === m.id ? { ...item, strength: parseFloat(e.target.value) } : item))}
                              className="w-full accent-[#408A71]"
                            />
                          </div>
                          <div className="space-y-2">
                            <div className="flex justify-between text-[10px] text-[#408A71] font-bold uppercase">
                              <span>Fidelity</span>
                              <span>{m.fidelity.toFixed(2)}</span>
                            </div>
                            <input 
                              type="range" min="0" max="1" step="0.01"
                              value={m.fidelity}
                              onChange={(e) => setMultiples(prev => prev.map(item => item.id === m.id ? { ...item, fidelity: parseFloat(e.target.value) } : item))}
                              className="w-full accent-[#408A71]"
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="flex gap-3">
                        <div className="flex-1 flex bg-[#B0E4CC]/20 border border-[#285A48] rounded-full overflow-hidden focus-within:border-[#408A71]">
                          <input 
                            type="text"
                            value={m.folder}
                            onChange={(e) => setMultiples(prev => prev.map(item => item.id === m.id ? { ...item, folder: e.target.value } : item))}
                            placeholder="Folder path (e.g. D:\no\out_tags)"
                            className="flex-1 bg-transparent px-8 py-4 text-sm text-white outline-none placeholder-[#408A71]/50"
                          />
                          <button 
                            onClick={async () => {
                              try {
                                await syncCharacterPrompts(m);
                              } catch (err: any) {
                                setError(err.message);
                              }
                            }}
                            className="px-6 hover:bg-[#408A71]/20 text-[#408A71] transition-all border-l border-[#285A48]"
                            title="Process Character Prompt"
                          >
                            <RefreshCw className="w-4 h-4" />
                          </button>
                        </div>
                        <label className="px-6 bg-[#B0E4CC]/30 text-[#091413] rounded-full text-xs font-bold hover:bg-[#B0E4CC]/50 transition-all flex items-center justify-center cursor-pointer">
                          Load TXT
                          <input 
                            type="file" 
                            className="hidden" 
                            accept=".txt"
                            multiple
                            onChange={async (e) => {
                              const files = Array.from(e.target.files || []) as File[];
                              const allLines: string[] = [];
                              for (const file of files) {
                                const text = await file.text();
                                const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                                allLines.push(...lines);
                              }
                              if (allLines.length > 0) {
                                setMultiples(prev => prev.map(item => item.id === m.id ? { 
                                  ...item, 
                                  promptsFromFile: allLines,
                                  currentFileIndex: 0
                                } : item));
                              }
                            }}
                          />
                        </label>
                      </div>

                      {m.promptsFromFile && m.promptsFromFile.length > 0 && (
                        <div className="bg-[#091413] rounded-2xl p-4 border border-[#285A48] space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-bold text-[#408A71] uppercase">Dynamic Prompts ({m.promptsFromFile.length})</span>
                            <div className="flex items-center gap-2">
                              <button 
                                onClick={() => setMultiples(prev => prev.map(item => item.id === m.id ? { ...item, currentFileIndex: Math.max(0, (item.currentFileIndex || 0) - 1) } : item))}
                                className="p-1 hover:bg-[#285A48] rounded text-[#408A71]"
                              >
                                <RefreshCw className="w-3 h-3 rotate-180" />
                              </button>
                              <span className="text-[10px] font-mono text-white">{(m.currentFileIndex || 0) + 1} / {m.promptsFromFile.length}</span>
                              <button 
                                onClick={() => setMultiples(prev => prev.map(item => item.id === m.id ? { ...item, currentFileIndex: Math.min(m.promptsFromFile!.length - 1, (item.currentFileIndex || 0) + 1) } : item))}
                                className="p-1 hover:bg-[#285A48] rounded text-[#408A71]"
                              >
                                <RefreshCw className="w-3 h-3" />
                              </button>
                              {autoBrowsingCharacterId === m.id ? (
                                <button 
                                  onClick={handleStopAll}
                                  className="p-1 hover:bg-[#e94560] rounded text-[#e94560] transition-all"
                                  title="Dừng duyệt tự động"
                                >
                                  <Square className="w-3 h-3 fill-current" />
                                </button>
                              ) : (
                                <button 
                                  onClick={() => setAutoBrowsingCharacterId(m.id)}
                                  className="p-1 hover:bg-[#408A71] rounded text-[#408A71] transition-all"
                                  title="Bắt đầu duyệt tự động"
                                >
                                  <Play className="w-3 h-3 fill-current" />
                                </button>
                              )}
                            </div>
                          </div>
                          {m.tempPromptFile && (
                            <p className="text-[9px] text-[#408A71]/80 break-all">{m.tempPromptFile}</p>
                          )}
                          <p className="text-[10px] text-[#B0E4CC]/70 italic line-clamp-2">
                            "{m.promptsFromFile[m.currentFileIndex || 0]}"
                          </p>
                          
                          {autoBrowsingCharacterId === m.id && (
                            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="pt-2 border-t border-[#285A48] space-y-2">
                              <div className="flex items-center gap-3">
                                <div className="flex-1">
                                  <div className="flex justify-between mb-1">
                                    <label className="text-[8px] font-bold text-[#408A71] uppercase">Độ trễ (giây)</label>
                                    <span className="text-[9px] text-white font-bold">{autoBrowseDelay.toFixed(2)}s</span>
                                  </div>
                                  <input 
                                    type="range" 
                                    min="0.15" 
                                    max="10" 
                                    step="0.05"
                                    value={autoBrowseDelay}
                                    onChange={(e) => setAutoBrowseDelay(parseFloat(e.target.value))}
                                    className="w-full accent-[#408A71]"
                                  />
                                </div>
                              </div>
                              <div className="flex items-center gap-2 text-[8px] text-[#408A71]">
                                <Zap className="w-3 h-3" />
                                <span>Đang duyệt...</span>
                              </div>
                            </motion.div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {activeTab === 'settings' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8">
              <div className="space-y-4">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#408A71]">Quality Tags</label>
                <select 
                  value={Object.keys(QUALITY_PRESETS).find(key => (QUALITY_PRESETS as any)[key] === params.quality_pfx)}
                  onChange={(e) => setParams(prev => ({ ...prev, quality_pfx: (QUALITY_PRESETS as any)[e.target.value] }))}
                  className="w-full bg-[#1d4035] border border-[#285A48] rounded-2xl px-6 py-4 text-sm text-white outline-none focus:border-[#408A71] appearance-none"
                >
                  {Object.keys(QUALITY_PRESETS).map(key => <option key={key} value={key}>{key}</option>)}
                </select>
              </div>

              <div className="space-y-4">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#408A71]">LoRA Processor Path</label>
                <input
                  type="text"
                  value={loraProcessorPath}
                  onChange={(e) => setLoraProcessorPath(e.target.value)}
                  className="w-full bg-[#1d4035] border border-[#285A48] rounded-2xl px-6 py-4 text-xs text-white outline-none focus:border-[#408A71]"
                />
                <p className="text-[9px] text-[#408A71]/80">Generate sẽ gọi file này để tạo txt tạm cho Character Tags (Dynamic).</p>
              </div>

              <div className="space-y-4">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#408A71]">UC Preset</label>
                <select 
                  value={params.ucPreset}
                  onChange={(e) => setParams(prev => ({ ...prev, ucPreset: parseInt(e.target.value) }))}
                  className="w-full bg-[#1d4035] border border-[#285A48] rounded-2xl px-6 py-4 text-sm text-white outline-none focus:border-[#408A71] appearance-none"
                >
                  {Object.entries(UC_PRESETS).map(([key, val]) => <option key={key} value={val}>{key}</option>)}
                </select>
              </div>

              <div className="space-y-4">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#408A71]">Highlight Emphasis</label>
                <div className="bg-[#1d4035] border border-[#285A48] rounded-2xl p-6 space-y-4">
                  <input 
                    type="range" min="0" max="2" step="0.1" value={highlightEmphasis}
                    onChange={(e) => setHighlightEmphasis(parseFloat(e.target.value))}
                    className="w-full h-1 bg-[#091413] rounded-lg appearance-none cursor-pointer accent-[#408A71]"
                  />
                  <div className="flex justify-between text-xs font-bold text-[#408A71]">
                    <span>0.0</span>
                    <span className="text-white bg-[#408A71] px-3 py-1 rounded-lg">{highlightEmphasis}</span>
                    <span>2.0</span>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#408A71]">Image Settings</label>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[9px] text-[#408A71]">Resolution</label>
                    <select 
                      onChange={(e) => {
                        const preset = (SIZE_PRESETS as any)[e.target.value];
                        if (preset) setParams(prev => ({ ...prev, width: preset.width, height: preset.height }));
                      }}
                      className="w-full bg-[#1d4035] border border-[#285A48] rounded-xl px-4 py-2.5 text-xs text-white outline-none"
                    >
                      {Object.keys(SIZE_PRESETS).map(key => <option key={key} value={key}>{key}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[9px] text-[#408A71]">Sampler</label>
                    <select 
                      value={params.sampler}
                      onChange={(e) => setParams(prev => ({ ...prev, sampler: e.target.value }))}
                      className="w-full bg-[#1d4035] border border-[#285A48] rounded-xl px-4 py-2.5 text-xs text-white outline-none"
                    >
                      {SAMPLERS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'templates' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              <div className="space-y-3">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#408A71]">Save Current Prompts</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={templateSaveName}
                    onChange={(e) => setTemplateSaveName(e.target.value)}
                    placeholder="Template name..."
                    className="flex-1 bg-[#1d4035] border border-[#285A48] rounded-xl px-4 py-2.5 text-xs text-white outline-none focus:border-[#408A71] placeholder-[#408A71]/50"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveTemplate();
                      }
                    }}
                  />
                  <button
                    onClick={saveTemplate}
                    type="button"
                    className="px-4 py-2.5 bg-[#408A71] text-white text-[9px] font-bold rounded-xl hover:bg-[#5aaea0] transition-all flex items-center gap-2"
                  >
                    <Save className="w-3 h-3" />
                    Save
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#408A71]">Saved Templates</label>
                {templates.length === 0 ? (
                  <p className="text-[9px] text-[#408A71]/60 italic">No templates saved yet</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 max-h-80 overflow-y-auto custom-scrollbar">
                    {templates.map((template) => (
                      <div
                        key={template.id}
                        className="bg-[#1d4035] border border-[#285A48] rounded-lg p-3 hover:border-[#408A71] transition-all"
                      >
                        <p className="text-[9px] font-bold text-white truncate mb-1">{template.name}</p>
                        <p className="text-[7px] text-[#408A71]/50 line-clamp-2 mb-2">
                          {template.basePrompt ? template.basePrompt.substring(0, 50) : 'No base prompt'}
                        </p>

                        <div className="flex gap-1">
                          <button
                            onClick={() => loadTemplate(template)}
                            type="button"
                            className="flex-1 px-2 py-1 bg-[#408A71] text-white text-[7px] font-bold rounded hover:bg-[#5aaea0] transition-all"
                          >
                            Load
                          </button>
                          <button
                            onClick={(e) => deleteTemplate(e, template.id)}
                            type="button"
                            className="px-2 py-1 bg-[#e94560] text-white text-[7px] font-bold rounded hover:bg-[#ff6b7a] transition-all"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'reference' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-bold uppercase tracking-widest text-[#408A71]">Style Reference (Static)</p>
                <button
                  onClick={() => setShowReferenceMode(!showReferenceMode)}
                  className={cn(
                    "px-3 py-1 text-[9px] font-bold rounded-lg transition-all",
                    showReferenceMode
                      ? "bg-[#408A71] text-white"
                      : "bg-[#1d4035] text-[#408A71] border border-[#285A48] hover:border-[#408A71]"
                  )}
                >
                  {showReferenceMode ? 'Hide Mode' : 'Show Mode'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {references.map((ref) => (
                  <div key={ref.id} className="bg-[#1d4035] border border-[#285A48] rounded-2xl p-3 relative group shadow-xl flex flex-col">
                    <button 
                      onClick={() => setReferences(prev => prev.filter(r => r.id !== ref.id))}
                      className="absolute -top-2 -right-2 p-1.5 bg-[#e94560] text-white rounded-full shadow-xl z-10 hover:scale-110 transition-transform"
                    >
                      <X className="w-3 h-3" />
                    </button>
                    <div className="aspect-square rounded-xl overflow-hidden mb-3 border border-[#285A48] shadow-inner bg-[#091413]">
                      <img src={ref.previewData || ref.data} className="w-full h-full object-cover" />
                    </div>
                    {showReferenceMode && (
                      <select 
                        value={ref.mode}
                        onChange={(e) => setReferences(prev => prev.map(r => r.id === ref.id ? { ...r, mode: e.target.value as ReferenceMode } : r))}
                        className="w-full bg-[#091413] text-[9px] font-bold uppercase tracking-widest p-2 rounded-lg outline-none text-[#408A71] border border-[#285A48]"
                      >
                        {Object.entries(REF_MODES).map(([k, v]) => <option key={v} value={v}>{k}</option>)}
                      </select>
                    )}
                  </div>
                ))}
                <div className="border-2 border-dashed border-[#285A48] rounded-2xl aspect-square flex flex-col items-center justify-center text-center p-6 hover:border-[#408A71] hover:bg-[#408A71]/5 transition-all cursor-pointer group">
                  <Layers className="w-10 h-10 text-[#408A71] mb-3 group-hover:scale-110 transition-transform" />
                  <p className="text-[10px] text-[#408A71] font-black uppercase tracking-widest">Drop Image</p>
                </div>
              </div>
            </motion.div>
          )}
        </div>
      </div>

      {/* --- Right Panel: Preview & History --- */}
      <main className="flex-1 flex relative bg-[#091413] overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,#1d4035_0%,#091413_100%)] opacity-50" />
        
        {/* Main Preview (100% size) */}
        <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-hidden relative">
          {focusMode ? (
            // Focus Mode - Show Progress Overlay
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center gap-8"
            >
              <div className="text-center space-y-6">
                <h2 className="text-2xl font-black uppercase tracking-[0.3em] text-[#408A71]">Generation Queue</h2>

                {queueProgress ? (
                  <div className="space-y-6 w-96">
                    {/* Progress Bar */}
                    <div className="space-y-2">
                      <div className="w-full h-3 bg-[#1d4035] border border-[#285A48] rounded-full overflow-hidden shadow-inner">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${(queueProgress.done / queueProgress.total) * 100}%` }}
                          className="h-full bg-gradient-to-r from-[#408A71] to-[#5aaea0] transition-all duration-500"
                        />
                      </div>
                      <div className="flex justify-between text-[10px] font-bold text-[#408A71]">
                        <span>{queueProgress.done}/{queueProgress.total} images</span>
                        <span>{Math.round((queueProgress.done / queueProgress.total) * 100)}%</span>
                      </div>
                    </div>

                    {/* Status Info */}
                    <div className="bg-[#1d4035] border border-[#285A48] rounded-2xl p-6 space-y-3">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-[#408A71]">Character:</span>
                        <span className="font-bold text-white">{queueProgress.currentChar}</span>
                      </div>
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-[#408A71]">Line:</span>
                        <span className="font-bold text-white">{queueProgress.currentLine} / {queueProgress.totalLines}</span>
                      </div>
                    </div>

                    {isGenerating && (
                      <div className="flex items-center justify-center gap-2 text-[9px] text-[#408A71]">
                        <div className="w-2 h-2 bg-[#408A71] rounded-full animate-pulse" />
                        Generating...
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-[10px] text-[#408A71]/60">No queue in progress</p>
                    <p className="text-[9px] text-[#408A71]/40">Click "Queue & Run" when ready</p>
                  </div>
                )}
              </div>
            </motion.div>
          ) : (
            // Normal Mode - Show Results
            <>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute top-8 p-4 bg-[#e94560]/10 border border-[#e94560]/30 rounded-2xl text-[#e94560] text-xs font-bold flex items-center gap-3 max-w-md text-center z-10"
                >
                  <X className="w-4 h-4 flex-shrink-0" />
                  {error}
                </motion.div>
              )}

              <AnimatePresence mode="wait">
                {results.length > 0 ? (
              <motion.div 
                key={results[0].imageUrl}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full h-full flex items-center justify-center"
              >
                <div className={cn(
                  "grid gap-4 w-full h-full p-4",
                  results.length === 1 ? "grid-cols-1" : "grid-cols-2"
                )}>
                  {results.map((res, idx) => (
                    <div key={idx} className="relative group h-full w-full flex items-center justify-center overflow-hidden rounded-[2rem] border border-[#285A48] bg-[#091413]">
                      <img 
                        src={res.imageUrl} 
                        alt={`Generated ${idx}`} 
                        className="max-w-full max-h-full object-contain transition-transform duration-700 group-hover:scale-[1.02]"
                      />
                      <div className="absolute bottom-6 right-6 flex gap-3 opacity-0 group-hover:opacity-100 transition-all translate-y-2 group-hover:translate-y-0">
                        <button 
                          onClick={() => {
                            const a = document.createElement('a');
                            a.href = res.imageUrl;
                            a.download = `novelai_${res.seed}.png`;
                            a.click();
                          }}
                          className="p-4 bg-[#091413]/90 backdrop-blur-2xl rounded-2xl hover:bg-[#408A71] transition-all shadow-2xl border border-[#285A48]"
                        >
                          <Download className="w-6 h-6" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            ) : (
              <div className="flex flex-col items-center gap-8 text-[#408A71] relative z-0">
                <div className="w-48 h-48 border-4 border-dashed border-[#285A48] rounded-[3rem] flex items-center justify-center animate-pulse">
                  <ImageIcon className="w-20 h-20 opacity-10" />
                </div>
                <div className="text-center space-y-3">
                  <p className="text-3xl font-black uppercase tracking-[0.4em] opacity-40">Awaiting Input</p>
                  <p className="text-sm font-medium italic opacity-20">Configure your masterpiece and click generate</p>
                </div>
              </div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>

        <div className="absolute top-4 right-4 z-20 flex gap-2">
          <button
            onClick={() => setFocusMode(prev => !prev)}
            className={cn(
              "px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-[0.2em] transition-all",
              focusMode
                ? "bg-[#408A71] text-white border border-[#408A71]"
                : "border border-[#285A48] bg-[#091413]/85 backdrop-blur-xl text-[#408A71] hover:bg-[#1d4035]"
            )}
          >
            {focusMode ? 'Exit Focus' : 'Focus Mode'}
          </button>
          <button
            onClick={() => setShowHistory(prev => !prev)}
            className="px-4 py-2 rounded-xl border border-[#285A48] bg-[#091413]/85 backdrop-blur-xl text-[10px] font-black uppercase tracking-[0.2em] text-[#408A71] hover:bg-[#1d4035] transition-all"
          >
            {showHistory ? 'Hide History' : 'Show History'}
          </button>
        </div>

        {/* Vertical History Sidebar (4-panel grid) */}
        <AnimatePresence initial={false}>
          {showHistory && (
            <motion.div
              initial={{ opacity: 0, x: 32 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 32 }}
              className="w-[320px] bg-[#091413]/80 backdrop-blur-xl border-l border-[#285A48] flex flex-col overflow-hidden"
            >
              <div className="p-4 border-b border-[#285A48] flex items-center justify-between">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-[#408A71]">History</h3>
                <span className="text-[9px] font-bold text-[#408A71]/50">{history.length} items</span>
              </div>
              <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                <div className="grid grid-cols-2 gap-3">
                  {history.map((item, i) => (
                    <motion.button 
                      whileHover={{ scale: 1.02, y: -2 }}
                      key={i}
                      onClick={() => setResults([{ imageUrl: item.imageUrl, seed: item.seed, blob: new Blob() }])}
                      className="aspect-[2/3] bg-[#1d4035] rounded-xl overflow-hidden border border-[#285A48] hover:border-[#408A71] transition-all shadow-lg relative group"
                    >
                      <img src={item.imageUrl} alt="history" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <Maximize2 className="w-4 h-4 text-white" />
                      </div>
                    </motion.button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 5px;
          height: 5px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #285A48;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #408A71;
        }
        .perspective-2000 {
          perspective: 2000px;
        }
        input[type="range"]::-webkit-slider-thumb {
          appearance: none;
          width: 12px;
          height: 12px;
          background: #B0E4CC;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 0 10px rgba(64,138,113,0.5);
        }
      `}</style>
      </div>
      {/* End Main Layout */}
    </div>
  );
}
