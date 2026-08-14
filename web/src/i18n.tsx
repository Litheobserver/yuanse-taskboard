import { createContext, useContext, type ReactNode } from "react";
import type { TaskPriority, TaskStatus } from "./types";

export type TaskboardLanguage = "zh" | "en";

interface TaskboardI18n {
  language: TaskboardLanguage;
  locale: "zh-CN" | "en";
  text: (chinese: string, english: string) => string;
}

const I18N: Record<TaskboardLanguage, TaskboardI18n> = {
  zh: {
    language: "zh",
    locale: "zh-CN",
    text: (chinese) => chinese,
  },
  en: {
    language: "en",
    locale: "en",
    text: (_chinese, english) => english,
  },
};

const STATUS_LABELS: Record<TaskboardLanguage, Record<TaskStatus, string>> = {
  zh: {
    backlog: "尚未开始",
    todo: "编曲中",
    in_progress: "编曲确认 / 修改",
    in_review: "混音母带",
    blocked: "录音中（乐器 / 人声）",
    done: "已完成",
    canceled: "暂停",
  },
  en: {
    backlog: "Backlog",
    todo: "To do",
    in_progress: "In progress",
    in_review: "In review",
    blocked: "Blocked",
    done: "Done",
    canceled: "Canceled",
  },
};

const PRIORITY_LABELS: Record<TaskboardLanguage, Record<TaskPriority, string>> = {
  zh: {
    none: "无优先级",
    urgent: "紧急",
    high: "高",
    medium: "中",
    low: "低",
  },
  en: {
    none: "No priority",
    urgent: "Urgent",
    high: "High",
    medium: "Medium",
    low: "Low",
  },
};

const TaskboardLanguageContext = createContext<TaskboardLanguage>("zh");

export function resolveTaskboardLanguage(_value: string | null | undefined): TaskboardLanguage {
  return "zh";
}

export function getTaskboardI18n(language: TaskboardLanguage): TaskboardI18n {
  return I18N[language];
}

export function taskStatusLabel(language: TaskboardLanguage, status: TaskStatus): string {
  return STATUS_LABELS[language][status];
}

export function taskPriorityLabel(language: TaskboardLanguage, priority: TaskPriority): string {
  return PRIORITY_LABELS[language][priority];
}

export function TaskboardLanguageProvider({
  language,
  children,
}: {
  language: TaskboardLanguage;
  children: ReactNode;
}) {
  return (
    <TaskboardLanguageContext.Provider value={language}>
      {children}
    </TaskboardLanguageContext.Provider>
  );
}

export function useTaskboardI18n(): TaskboardI18n {
  return I18N[useContext(TaskboardLanguageContext)];
}
