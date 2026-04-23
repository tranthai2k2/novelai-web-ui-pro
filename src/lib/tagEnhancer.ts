/**
 * Tag Enhancer Logic (Ported from tag_enhancer_v12.6_FINAL.py)
 */

const SEX_POSITIONS = new Set([
  "missionary", "boy on top", "cowgirl position", "girl on top", "reverse cowgirl", 
  "reverse upright straddle", "doggystyle", "sex from behind", "mating press", "prone bone", 
  "standing sex", "spooning", "just the tip", "straddling", "seated", "suspended congress"
]);

const PENETRATION_TAGS = new Set([
  "vaginal", "anal", "penis", "cum", "ejaculation", "internal cumshot", 
  "cum in pussy", "cum in mouth", "penetration", "imminent penetration", 
  "deep penetration", "vaginal penetration", "anal penetration"
]);

const ORAL_TAGS = new Set([
  "oral", "fellatio", "deepthroat", "irrumatio", "imminent fellatio", 
  "blowjob", "handjob", "cunnilingus", "oral sex"
]);

const DOGGYSTYLE_TAGS = new Set([
  "doggystyle", "all_fours", "all fours", "sex from behind", "from behind"
]);

const LYING_INDICATORS = new Set([
  "lying", "sleeping", "sleep molestation", "on back", "on bed", "on floor", 
  "on ground", "on stomach", "on side", "unconscious", "head on pillow"
]);

const RAPE_TAGS = new Set([
  "rape", "sleep molestation", "imminent rape", "sexual assault", 
  "molestation", "non-consensual", "forced"
]);

const POV_TAGS = new Set([
  "pov hands", "pov crotch", "pov", "pov feet"
]);

export function enhanceTags(prompt: string): string {
  const tags = new Set(prompt.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0));
  const strongTag = (tag: string) => `{{${tag}}}`;
  
  const hasTag = (tag: string) => tags.has(tag);
  const hasAny = (tagSet: Set<string>) => Array.from(tagSet).some(t => tags.has(t));

  // --- Tier 1: Faceless Wrapping ---
  if (hasTag("faceless male") && !hasTag(strongTag("faceless male"))) {
    tags.delete("faceless male");
    tags.add(strongTag("faceless male"));
  }
  if (hasTag("bald") && !hasTag(strongTag("bald"))) {
    tags.delete("bald");
    tags.add(strongTag("bald"));
  }

  // --- Tier 2a: Doggystyle + Penetration -> Fat Man ---
  if (hasAny(DOGGYSTYLE_TAGS) && hasAny(PENETRATION_TAGS)) {
    if (!hasTag("fat man") && !hasTag(strongTag("fat man"))) {
      tags.add(strongTag("fat man"));
    }
  }

  // --- Tier 2b: Rape + Contact/POV -> Fat Man ---
  if (hasAny(RAPE_TAGS) && (hasAny(SEX_POSITIONS) || hasAny(POV_TAGS)) && hasAny(PENETRATION_TAGS)) {
    if (!hasTag("fat man") && !hasTag(strongTag("fat man"))) {
      tags.add(strongTag("fat man"));
    }
  }

  // --- Tier 2d: Cunnilingus -> Faceless + Bald ---
  if (hasTag("cunnilingus")) {
    if (!hasTag("faceless male") && !hasTag(strongTag("faceless male"))) tags.add(strongTag("faceless male"));
    if (!hasTag("bald") && !hasTag(strongTag("bald"))) tags.add(strongTag("bald"));
  }

  // --- Tier 4: Missionary -> Fat Man ---
  if (hasTag("missionary")) {
    if (!hasTag("fat man") && !hasTag(strongTag("fat man"))) {
      tags.add(strongTag("fat man"));
    }
  }

  // --- Tier 6: Prone Bone -> On Stomach ---
  if (hasTag("prone bone") && !hasTag("on stomach")) {
    tags.add("on stomach");
  }

  // --- Tier 6.5: Prone Bone + X-Ray -> Cross-Section ---
  if (hasTag("prone bone") && hasTag("x-ray") && !hasTag("cross-section")) {
    tags.add("cross-section");
  }

  // --- Male Character Grouping ---
  const maleTags = ["1boy", "faceless male", "bald", "fat man"];
  const foundMaleTags = maleTags.filter(t => tags.has(t) || tags.has(strongTag(t)));
  
  if (foundMaleTags.length > 0) {
    foundMaleTags.forEach(t => {
      tags.delete(t);
      tags.delete(strongTag(t));
    });
    const grouped = strongTag(foundMaleTags.join(', '));
    tags.add(grouped);
  }

  // --- Cleanup: Remove underscores from all tags ---
  const cleanedTags = Array.from(tags).map(t => t.replace(/_/g, ' '));

  return cleanedTags.join(', ');
}
