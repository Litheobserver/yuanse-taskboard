import type { TaskboardLanguage } from "./i18n";

export const DEFAULT_LABELS = [
  { name: "缺陷", color: "#eb5757" },
  { name: "特性", color: "#bb87fc" },
  { name: "for-claude", color: "#5b8cff" },
  { name: "hold", color: "#d99b25" },
  { name: "改进", color: "#4ea7fc" },
  { name: "phase-1", color: "#1d4ed8" },
  { name: "phase-2", color: "#0f766e" },
  { name: "phase-3", color: "#7c3aed" },
  { name: "phase-4", color: "#b45309" },
  { name: "phase-5", color: "#be123c" },
  { name: "phase-6", color: "#475569" },
] as const;

export const RELEASE_LABEL_PREFIX = "作品:";

const RELEASE_COLORS = ["#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#14b8a6"];
const KNOWN_RELEASE_COLORS: Record<string, string> = {
  "焦迈奇四专": "#8b5cf6",
  "鹿先森五专": "#06b6d4",
};

export function isReleaseLabel(name: string): boolean {
  return name.startsWith(RELEASE_LABEL_PREFIX);
}

function releaseName(name: string): string {
  return name.slice(RELEASE_LABEL_PREFIX.length).trim();
}

function stableReleaseColor(name: string): string {
  const cleanName = releaseName(name);
  const known = KNOWN_RELEASE_COLORS[cleanName];
  if (known) return known;
  let hash = 0;
  for (const character of cleanName) hash = ((hash * 31) + character.codePointAt(0)!) >>> 0;
  return RELEASE_COLORS[hash % RELEASE_COLORS.length];
}

export function labelColor(name: string): string {
  if (isReleaseLabel(name)) return stableReleaseColor(name);
  return DEFAULT_LABELS.find((label) => label.name === name)?.color ?? "#8b8d92";
}

export type LabelTone = "bug" | "feature" | null;

export function labelDisplayName(name: string, language: TaskboardLanguage = "zh"): string {
  if (isReleaseLabel(name)) return releaseName(name);
  if (name === "缺陷" || name.toLocaleUpperCase() === "BUG") return "BUG";
  if (name === "特性" || name === "新功能") return language === "zh" ? "新功能" : "Feature";
  if (name === "改进") return language === "zh" ? "改进" : "Improvement";
  return name;
}

export function labelTone(name: string): LabelTone {
  if (name === "缺陷" || name.toLocaleUpperCase() === "BUG") return "bug";
  if (name === "特性" || name === "新功能") return "feature";
  return null;
}

export function labelPresentation(name: string, language: TaskboardLanguage = "zh") {
  const tone = labelTone(name);
  return {
    name: labelDisplayName(name, language),
    tone,
    color: tone === "bug" ? "#eb5757" : tone === "feature" ? "#bb87fc" : labelColor(name),
  };
}
