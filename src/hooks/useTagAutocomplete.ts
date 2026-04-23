import { useState, useEffect } from 'react';
import { searchTags } from '../lib/tags';

/**
 * Extract the pure tag query and emphasis prefix from a raw input token.
 * Supports NovelAI emphasis syntax:
 *   "2::blue"    → prefix="2::", query="blue"
 *   "0.5::tag::" → prefix="0.5::", query="tag" (trailing :: stripped)
 *   "{long"      → prefix="{", query="long"
 *   "{{long"     → prefix="{{", query="long"
 *   "[bad"       → prefix="[", query="bad"
 *   "[[bad"      → prefix="[[", query="bad"
 */
const extractTagQuery = (rawToken: string): { prefix: string; query: string } => {
  // Numeric emphasis: "2::query" or "0.5::query::"
  const numericMatch = rawToken.match(/^([\d.]+::)(.*)$/);
  if (numericMatch) {
    return { prefix: numericMatch[1], query: numericMatch[2].replace(/::$/, '') };
  }
  // Curly brace: "{query" or "{{query"
  const curlyMatch = rawToken.match(/^(\{+)(.*)$/);
  if (curlyMatch) {
    return { prefix: curlyMatch[1], query: curlyMatch[2].replace(/\}+$/, '') };
  }
  // Square bracket: "[query" or "[[query"
  const squareMatch = rawToken.match(/^(\[+)(.*)$/);
  if (squareMatch) {
    return { prefix: squareMatch[1], query: squareMatch[2].replace(/\]+$/, '') };
  }
  return { prefix: '', query: rawToken };
};

/**
 * Wrap a selected tag back with its emphasis syntax.
 *   prefix="2::", tag="blue_eyes" → "2::blue_eyes::"
 *   prefix="{",   tag="long_hair" → "{long_hair}"
 *   prefix="{{",  tag="long_hair" → "{{long_hair}}"
 *   prefix="[",   tag="bad_hands" → "[bad_hands]"
 */
export const buildEmphasisTag = (prefix: string, tag: string): string => {
  if (!prefix) return tag;
  if (/^[\d.]+::$/.test(prefix)) return `${prefix}${tag}::`;
  if (/^\{+$/.test(prefix)) return `${prefix}${tag}${'}' .repeat(prefix.length)}`;
  if (/^\[+$/.test(prefix)) return `${prefix}${tag}${']'.repeat(prefix.length)}`;
  return tag;
};

export const useTagAutocomplete = (input: string) => {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [tagPrefix, setTagPrefix] = useState('');

  useEffect(() => {
    const rawToken = input.split(',').pop()?.trim() || '';
    const { prefix, query } = extractTagQuery(rawToken);

    if (query.length < 2) {
      setSuggestions([]);
      setTagPrefix('');
      return;
    }

    setTagPrefix(prefix);

    const timer = setTimeout(async () => {
      setIsLoading(true);
      const results = await searchTags(query);
      setSuggestions(results);
      setIsLoading(false);
      setActiveSuggestion(0);
    }, 300);

    return () => clearTimeout(timer);
  }, [input]);

  return { suggestions, isLoading, activeSuggestion, setActiveSuggestion, setSuggestions, tagPrefix };
};
