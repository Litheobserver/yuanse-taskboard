import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { taskboardStorage } from "../storage";
import {
  ApiError,
  attachmentDownloadUrl,
  createComment,
  deleteAttachment,
  deleteComment,
  listAttachments,
  listComments,
  listTaskActivities,
  markdownIncludesAttachment,
  resolveTaskboardUrl,
  resolvePersistedAttachmentUrl,
  uploadAttachment,
  uploadCommentAttachment,
  updateComment,
} from "../api";
import {
  taskPriorityLabel,
  taskStatusLabel,
  useTaskboardI18n,
  type TaskboardLanguage,
} from "../i18n";
import { TASK_PRIORITIES, TASK_STATUSES } from "../types";
import type {
  ActorIdentity,
  Attachment,
  Comment,
  DevelopmentContext,
  DevelopmentScan,
  IssueRelationType,
  Recurrence,
  Task,
  TaskChangeActivity,
  TaskDraft,
  TaskPriority,
  TaskRelationSummary,
  TaskStatus,
} from "../types";
import {
  CODEX_AGENT_ACTOR,
  actorKey,
  assigneeTargetForActor,
} from "../actors";
import { ActorAvatar } from "./ActorAvatar";
import { STATUS_DETAILS, StatusIcon } from "./BoardColumn";
import { LabelPicker } from "./LabelPicker";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";
import { TaskboardIcon } from "./TaskboardIcon";
import {
  fileKey,
  MAX_ATTACHMENT_SIZE,
  PendingAttachments,
} from "./PendingAttachments";
import {
  createInlineMediaSegments,
  InlineMediaComposer,
  inlineMediaImages,
  inlineMediaText,
  resolveInlineMediaMarkdown,
  serializeInlineMedia,
  type InlineMediaComposerHandle,
  type InlineMediaSegment,
} from "./InlineMediaComposer";
import {
  IssueParentLink,
  IssueRelationSidebar,
  IssueSubIssues,
  type RelationMutationResult,
} from "./IssueRelations";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { buildIssueUrl, readIssueIdentifier } from "../issueRoute";
import { postEmbeddedHostMessage } from "../embeddedHost.mjs";
import copyIdIcon from "../assets/figma-taskboard/copy-id.svg";
import copyLinkIcon from "../assets/figma-taskboard/copy-link.svg";

type TaskDetailError = string | readonly [string, string];

interface TaskDetailProps {
  task: Task;
  tasks: Task[];
  currentUser: ActorIdentity;
  availableLabels: string[];
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  commentsRevision: number;
  attachmentsRevision: number;
  onCreateLabel: (label: string) => Promise<void>;
  onDeleteLabel: (label: string) => Promise<void>;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onOpenTask: (task: TaskRelationSummary) => void;
  onAddRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
  onRemoveRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
  onOpenThread: (threadId: string) => void;
  onOpenInThread: (task: Task) => void;
  onCopy: (text: string, announcement: string) => void;
  openingThread: boolean;
  onError: (message: TaskDetailError | null) => void;
}

function messageFor(error: unknown): TaskDetailError {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return ["操作未完成，请重试。", "The action could not be completed. Try again."];
}

function issueMessageFor(error: unknown): TaskDetailError {
  if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
    return [
      "该议题已在其他位置更新，请刷新后重试。",
      "This issue changed elsewhere. Refresh and try again.",
    ];
  }
  return messageFor(error);
}

function exactTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function relativeTime(value: string, locale: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(value));
}

function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

async function downloadAttachmentFile(attachment: Attachment) {
  const host = new URL(document.baseURI).searchParams.get("host");
  if (host === "codex" && window.parent !== window) {
    postEmbeddedHostMessage({
      type: "taskboard:open-attachment",
      payload: {
        attachmentId: attachment.id,
        filename: attachment.filename,
      },
    });
    return;
  }

  const response = await fetch(resolveTaskboardUrl(attachmentDownloadUrl(attachment)));
  if (!response.ok) {
    throw new ApiError(response.status, await response.json().catch(() => ({})));
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function contextValue(context: DevelopmentContext | null): string {
  return context ? JSON.stringify(context) : "";
}

function contextLabel(
  context: DevelopmentContext,
  text: (chinese: string, english: string) => string,
): string {
  if (context.type === "branch") return context.branch;
  const folder = context.path.split(/[\\/]/).filter(Boolean).at(-1) ?? context.path;
  return `${context.branch ?? text("分离 HEAD", "detached")} · ${folder}`;
}

const ACTIVITY_FIELD_LABELS: Record<string, readonly [string, string]> = {
  projectId: ["项目", "project"],
  title: ["标题", "title"],
  description: ["描述", "description"],
  status: ["状态", "status"],
  priority: ["优先级", "priority"],
  labels: ["标签", "labels"],
  assignee: ["负责人", "assignee"],
  workflowId: ["工作流", "workflow"],
  developmentContext: ["开发上下文", "development context"],
  startDate: ["开始日期", "start date"],
  dueDate: ["截止日期", "due date"],
  recurrence: ["重复", "recurrence"],
  archivedAt: ["归档状态", "archive status"],
  relation: ["关系", "relation"],
};

const RELATION_LABELS: Record<IssueRelationType, readonly [string, string]> = {
  parent: ["父议题", "Parent issue"],
  blocks: ["阻塞", "Blocks"],
  blocked_by: ["阻塞于", "Blocked by"],
  related: ["相关议题", "Related issue"],
};

function activityValue(
  field: string,
  value: unknown,
  language: TaskboardLanguage,
  locale: string,
  text: (chinese: string, english: string) => string,
): string {
  if (field === "archivedAt") {
    return typeof value === "string"
      ? text(`已归档（${exactTime(value, locale)}）`, `Archived (${exactTime(value, locale)})`)
      : text("未归档", "Not archived");
  }
  if (value === null || value === "") return text("未设置", "Not set");
  if (field === "status" && typeof value === "string" && value in STATUS_DETAILS) {
    return taskStatusLabel(language, value as TaskStatus);
  }
  if (field === "priority" && typeof value === "string" && TASK_PRIORITIES.includes(value as TaskPriority)) {
    return taskPriorityLabel(language, value as TaskPriority);
  }
  if (field === "labels" && Array.isArray(value)) {
    return value.length > 0
      ? value.join(language === "zh" ? "、" : ", ")
      : text("无标签", "No labels");
  }
  if (field === "assignee" && typeof value === "object") {
    const actor = value as ActorIdentity;
    return `${actor.name} @${actor.id}`;
  }
  if (field === "developmentContext" && typeof value === "object") {
    const context = value as { type: string; branch?: string | null; path?: string | null };
    if (context.type === "branch") return context.branch ?? text("未设置", "Not set");
    const folder = context.path?.split(/[\\/]/).filter(Boolean).at(-1);
    return `${context.branch ?? text("分离 HEAD", "detached")}${folder ? ` · ${folder}` : ""}`;
  }
  if (field === "recurrence" && typeof value === "object") {
    const recurrence = value as Recurrence;
    const units: Record<Recurrence["unit"], readonly [string, string]> = {
      day: ["天", "day"],
      week: ["周", "week"],
      month: ["月", "month"],
      year: ["年", "year"],
    };
    const [chineseUnit, englishUnit] = units[recurrence.unit];
    return text(
      recurrence.interval === 1 ? `每${chineseUnit}` : `每 ${recurrence.interval} ${chineseUnit}`,
      `Every ${recurrence.interval === 1 ? "" : `${recurrence.interval} `}${englishUnit}${recurrence.interval === 1 ? "" : "s"}`,
    );
  }
  if (field === "relation" && typeof value === "object") {
    const relation = value as {
      type: IssueRelationType;
      identifier: string;
      externalKey?: string | null;
      title: string;
    };
    const [chineseLabel, englishLabel] = RELATION_LABELS[relation.type];
    return `${text(chineseLabel, englishLabel)} ${relation.externalKey ?? relation.identifier} · ${relation.title}`;
  }
  if (Array.isArray(value)) return value.join(language === "zh" ? "、" : ", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ActivityChangeIcon({ field, before, after }: {
  field: string;
  before: unknown;
  after: unknown;
}) {
  const value = after ?? before;
  if (field === "status" && typeof value === "string" && value in STATUS_DETAILS) {
    return <StatusIcon status={value as TaskStatus} />;
  }
  if (field === "priority" && typeof value === "string" && TASK_PRIORITIES.includes(value as TaskPriority)) {
    return <LinearPriorityIcon priority={value as TaskPriority} />;
  }
  if (field === "relation" && typeof value === "object") {
    const relation = value as { type?: IssueRelationType };
    if (relation.type === "blocked_by") return <TaskboardIcon name="relationBlockedBy" />;
    if (relation.type === "blocks") return <TaskboardIcon name="relationBlocks" />;
    return <LinearIcon name="link" />;
  }
  if (field === "projectId" || field === "workflowId") return <LinearIcon name="project" />;
  if (field === "labels") return <LinearIcon name="label" />;
  if (field === "assignee") return <LinearIcon name="myIssues" />;
  if (field === "developmentContext") return <LinearIcon name="branch" />;
  if (field === "startDate" || field === "dueDate") return <LinearIcon name="calendar" />;
  if (field === "recurrence") return <LinearIcon name="recurrence" />;
  if (field === "archivedAt") return <LinearIcon name="trash" />;
  return <LinearIcon name="write" />;
}

function referencedTask(href: string, tasks: Task[]): Task | null {
  try {
    const base = new URL(document.baseURI);
    base.search = "";
    base.hash = "";
    const url = new URL(href, base);
    if (url.origin !== base.origin || url.pathname !== base.pathname) return null;
    const identifier = readIssueIdentifier(url.search);
    const projectId = url.searchParams.get("project");
    if (!identifier || !projectId) return null;
    return tasks.find((task) => task.projectId === projectId && task.identifier === identifier) ?? null;
  } catch {
    return null;
  }
}

function DescriptionDocument({
  value,
  tasks,
  onOpenTask,
}: {
  value: string;
  tasks: Task[];
  onOpenTask: (task: TaskRelationSummary) => void;
}) {
  return (
    <div className="issue-description-document">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={(url) => defaultUrlTransform(resolvePersistedAttachmentUrl(url))}
        components={{
          a: ({ node: _node, href, ...props }) => {
            const task = href ? referencedTask(href, tasks) : null;
            return (
              <a
                {...props}
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  if (
                    !task
                    || event.button !== 0
                    || event.metaKey
                    || event.ctrlKey
                    || event.shiftKey
                    || event.altKey
                  ) return;
                  event.preventDefault();
                  onOpenTask(task);
                }}
              />
            );
          },
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

const YUANSE_MANUAL_BLOCK_RE = /<!-- YUANSE-MANUAL START -->\n?([\s\S]*?)\n?<!-- YUANSE-MANUAL END -->/;
const YUANSE_SYNC_BLOCK_RE = /<!-- YUANSE-SYNC entity=\d+ START -->\n?([\s\S]*?)\n?<!-- YUANSE-SYNC END -->/;
const YUANSE_COSTS_BLOCK_RE = /<!-- YUANSE-COSTS START -->\n?([\s\S]*?)\n?<!-- YUANSE-COSTS END -->/;
const YUANSE_FACT_OVERRIDES_BLOCK_RE = /<!-- YUANSE-FACT-OVERRIDES START -->\n?([\s\S]*?)\n?<!-- YUANSE-FACT-OVERRIDES END -->/;

type YuanseFactTone = "neutral" | "arrangement" | "instrument" | "vocal" | "post";
type YuanseStatusTone = "complete" | "active" | "pending" | "paused" | "neutral";

interface YuanseFact {
  label: string;
  value: string;
  tone: YuanseFactTone;
  statusTone: YuanseStatusTone;
}

interface YuanseDescriptionSummary {
  stage: string;
  manualNotes: string;
  facts: YuanseFact[];
  progressNotes: string[];
  thoughts: Array<{ createdAt: string; text: string }>;
  openItems: string[];
}

const YUANSE_PRODUCTION_FACTS: Array<Pick<YuanseFact, "label" | "tone"> & { defaultValue: string }> = [
  { label: "编曲", tone: "arrangement", defaultValue: "未开始" },
  { label: "鼓", tone: "instrument", defaultValue: "未录音" },
  { label: "吉他", tone: "instrument", defaultValue: "未录音" },
  { label: "贝斯", tone: "instrument", defaultValue: "未录音" },
  { label: "特殊乐器", tone: "instrument", defaultValue: "未录音" },
  { label: "人声", tone: "vocal", defaultValue: "未录音" },
  { label: "混音", tone: "post", defaultValue: "未开始" },
  { label: "母带", tone: "post", defaultValue: "未开始" },
];

type YuansePaymentStatus = "unpaid" | "partial" | "paid";

interface YuanseCostItem {
  id: string;
  service: string;
  supplier: string;
  total: number;
  paid: number;
  paymentStatus: YuansePaymentStatus;
}

function isYuanseDescription(value: string): boolean {
  return YUANSE_SYNC_BLOCK_RE.test(value);
}

function yuanseManualNotes(value: string): string {
  return value.match(YUANSE_MANUAL_BLOCK_RE)?.[1]?.trim() ?? "";
}

function mergeYuanseManualNotes(value: string, manualNotes: string): string {
  const replacement = `<!-- YUANSE-MANUAL START -->\n${manualNotes.trim()}\n<!-- YUANSE-MANUAL END -->`;
  if (YUANSE_MANUAL_BLOCK_RE.test(value)) return value.replace(YUANSE_MANUAL_BLOCK_RE, replacement);
  return `## 看板备注（可编辑，会回写元色大总管）\n${replacement}\n\n${value}`.trim();
}

function yuanseCosts(value: string): YuanseCostItem[] {
  const raw = value.match(YUANSE_COSTS_BLOCK_RE)?.[1]?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<YuanseCostItem>;
      if (typeof candidate.service !== "string" || typeof candidate.supplier !== "string") return [];
      const total = Number(candidate.total);
      const paid = Number(candidate.paid);
      const paymentStatus = candidate.paymentStatus === "paid" || candidate.paymentStatus === "partial"
        ? candidate.paymentStatus
        : "unpaid";
      return [{
        id: typeof candidate.id === "string" && candidate.id ? candidate.id : `cost-${index}`,
        service: candidate.service,
        supplier: candidate.supplier.replace(/Tony\s+Mora\b/gi, "Tony Morra"),
        total: Number.isFinite(total) ? Math.max(0, total) : 0,
        paid: Number.isFinite(paid) ? Math.max(0, paid) : 0,
        paymentStatus,
      }];
    });
  } catch {
    return [];
  }
}

function mergeYuanseCosts(value: string, costs: YuanseCostItem[]): string {
  const replacement = `<!-- YUANSE-COSTS START -->\n${JSON.stringify(costs)}\n<!-- YUANSE-COSTS END -->`;
  if (YUANSE_COSTS_BLOCK_RE.test(value)) return value.replace(YUANSE_COSTS_BLOCK_RE, replacement);
  return `${value.trim()}\n\n${replacement}`.trim();
}

function yuanseFactOverrides(value: string): Record<string, string> {
  const raw = value.match(YUANSE_FACT_OVERRIDES_BLOCK_RE)?.[1]?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([label, status]) => (
      typeof status === "string" && status.trim() ? [[label, status.trim()]] : []
    )));
  } catch {
    return {};
  }
}

function mergeYuanseFactOverride(value: string, label: string, status: string): string {
  const overrides = { ...yuanseFactOverrides(value), [label]: status };
  const replacement = `<!-- YUANSE-FACT-OVERRIDES START -->\n${JSON.stringify(overrides)}\n<!-- YUANSE-FACT-OVERRIDES END -->`;
  if (YUANSE_FACT_OVERRIDES_BLOCK_RE.test(value)) {
    return value.replace(YUANSE_FACT_OVERRIDES_BLOCK_RE, replacement);
  }
  return `${value.trim()}\n\n${replacement}`.trim();
}

function createYuanseCostId() {
  return `cost-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function yuanseMoney(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function yuanseFactTone(label: string): YuanseFactTone {
  if (/编曲/.test(label)) return "arrangement";
  if (/鼓|吉他|贝斯|特殊|弦乐|风笛|木管|铜管|钢琴|小号|三味线/.test(label)) return "instrument";
  if (/人声|录唱/.test(label)) return "vocal";
  if (/混音|母带/.test(label)) return "post";
  return "neutral";
}

function yuanseStatusTone(value: string): YuanseStatusTone {
  if (/暂停|搁置|取消/.test(value)) return "paused";
  if (/已完成|完成|已通过|通过|\bOK\b/i.test(value)) return "complete";
  if (/中|进行|录制/.test(value)) return "active";
  if (/待|未|确认项/.test(value)) return "pending";
  return "neutral";
}

function canonicalYuanseFactValue(label: string, value: string): string {
  const clean = value.trim().replace(/[。.]$/, "");
  if (/暂停|搁置|取消/.test(clean)) return "暂停";
  if (/已完成|完成|已通过|通过|\bOK\b/i.test(clean)) return "OK";

  if (label === "编曲") {
    if (/修改中|编曲修改/.test(clean)) return "修改中";
    if (/编曲中|进行中/.test(clean)) return "编曲中";
    if (/待确认|等待.*确认/.test(clean)) return "待确认";
    return "未开始";
  }

  if (label === "混音" || label === "母带") {
    if (/进行中|混音中|母带中|制作中/.test(clean)) return "进行中";
    if (/待确认|等待.*确认/.test(clean)) return "待确认";
    return "未开始";
  }

  if (label === "特殊乐器" && /^(无|可无|没有|无需|待定|待确认|等待确认)$/.test(clean)) return "未录音";
  if (/录音中|录制中|正在.*录|在家录音/.test(clean)) return "录音中";
  if (/待确认|等待.*确认/.test(clean)) return "待确认";
  return "未录音";
}

function isSimpleYuanseFactValue(label: string, value: string): boolean {
  const clean = value.trim().replace(/[。.]$/, "");
  if (label === "编曲") {
    return /^(未开始|待进入|编曲中|修改中|编曲修改中|待确认|等待确认|已完成|完成|已通过|通过|OK|暂停)$/i.test(clean);
  }
  if (label === "混音" || label === "母带") {
    return /^(未开始|待进入|进行中|待确认|等待确认|已完成|完成|OK|暂停)$/i.test(clean);
  }
  return /^(未录音|待录音|待进入|录音中|录制中|待确认|等待确认|已完成|完成|已录音|OK|无|可无|暂停)$/i.test(clean);
}

function yuanseFactProgressNote(label: string, value: string): string | null {
  if (isSimpleYuanseFactValue(label, value)) return null;
  let detail = value.trim().replace(/[。.]$/, "");
  if (label === "编曲") {
    detail = detail.replace(/^(?:编曲中|编曲修改中|修改中|待确认|等待确认)[，,]\s*/, "");
    const progress = detail.match(/^进度[：:]?\s*(.+)$/);
    if (progress) return `编曲进度：${progress[1]}`;
  }
  return `${label}：${detail}`;
}

function normalizeYuanseProductionLabel(label: string, value: string): string | null {
  const clean = label.trim().replace(/状态$/, "");
  if (/^(编曲)$/.test(clean)) return "编曲";
  if (/^(录鼓|鼓|鼓录音)$/.test(clean)) return "鼓";
  if (/^(吉他|吉他录音)$/.test(clean)) return "吉他";
  if (/^(贝斯|贝斯录音)$/.test(clean)) return "贝斯";
  if (/^(特殊乐器|特殊乐器录音)$/.test(clean)) return "特殊乐器";
  const namedInstrument = clean.match(/^特殊乐器[·/](.+)$/)?.[1]?.trim();
  if (namedInstrument) return namedInstrument;
  if (/^(弦乐|风笛|木管|铜管|钢琴|小号|三味线)$/.test(clean)) return clean;
  if (/^(人声|录唱|人声录音)$/.test(clean)) return "人声";
  if (/^(混音)$/.test(clean)) return "混音";
  if (/^(母带)$/.test(clean)) return "母带";
  if (clean === "当前") {
    if (/混音/.test(value)) return "混音";
    if (/母带/.test(value)) return "母带";
    if (/编曲/.test(value)) return "编曲";
    return null;
  }
  return null;
}

function yuanseNamedSpecialInstruments(value: string): Array<{ label: string; value: string }> {
  const clean = value.trim().replace(/[。.]$/, "");
  if (!clean || /^(无|可无|没有|无需|待确认|等待确认|未录音|待录音|待进入)$/.test(clean)) return [];

  const commonStatus = clean.match(/[（(]均\s*([^）)]+)[）)]\s*$/)?.[1]?.trim();
  const names = clean.replace(/[（(]均\s*[^）)]+[）)]\s*$/, "").split(/[、，,]+/);
  return names.flatMap((item) => {
    const part = item.trim();
    if (!part) return [];
    const match = part.match(/^(.+?)(?:[（(]([^）)]+)[）)])?$/);
    const label = match?.[1]?.trim() ?? "";
    if (!label || /^(无|可无|没有|无需)$/.test(label)) return [];
    const status = match?.[2]?.trim() || commonStatus || "未录音";
    return [{ label, value: canonicalYuanseFactValue(label, status) }];
  });
}

function yuanseRecordingStudios(manualNotes: string): string[] {
  const section = manualNotes.match(/#{1,6}\s*人声录音\s*\n([\s\S]*?)(?=\n#{1,6}\s|$)/)?.[1] ?? "";
  return [...new Set(section.split("\n").flatMap((line) => {
    const clean = line.trim().replace(/^[-*]\s*/, "").replace(/[。.]$/, "");
    if (!clean) return [];
    const place = clean.includes("｜") ? clean.split("｜").at(-1)!.trim() : "";
    const studio = place.replace(/^第[^，,]+次[，,]\s*/, "").trim();
    return studio ? [studio] : [];
  }))];
}

function yuanseFactSupplier(value: string, fact: YuanseFact, manualNotes: string): string {
  const aliases = fact.label === "人声"
    ? ["人声", "人声录音", "录唱", "录音棚"]
    : [fact.label];
  const suppliers = yuanseCosts(value).flatMap((item) => {
    const service = item.service.trim();
    if (!aliases.some((alias) => service === alias || service.includes(alias))) return [];
    const supplier = item.supplier.trim();
    return supplier ? [supplier] : [];
  });
  if (suppliers.length) return [...new Set(suppliers)].join("、");

  if (fact.label === "人声") {
    const studios = yuanseRecordingStudios(manualNotes);
    return studios.length ? studios.join("、") : "录音棚待定";
  }
  if (fact.label === "编曲") return "我";
  if (fact.label === "鼓") return "Tony Morra";
  if (/^(吉他|贝斯|钢琴)$/.test(fact.label)) return "我";
  return "待定";
}

function yuanseSupplierIsExternal(supplier: string): boolean {
  return supplier !== "我" && !supplier.includes("待定");
}

function orderedYuanseProductionFacts(facts: Map<string, YuanseFact>): YuanseFact[] {
  const leading = ["编曲", "鼓", "吉他", "贝斯"];
  const trailing = ["人声", "混音", "母带"];
  const fixed = new Set([...leading, ...trailing]);
  const specials = [...facts.values()].filter((fact) => !fixed.has(fact.label));
  return [
    ...leading.flatMap((label) => facts.get(label) ? [facts.get(label)!] : []),
    ...specials,
    ...trailing.flatMap((label) => facts.get(label) ? [facts.get(label)!] : []),
  ];
}

function extractYuanseList(section: string, metadataPattern: RegExp): string[] {
  return [...section.matchAll(/^-\s+(.+)$/gm)].map((match) => (
    match[1].replace(metadataPattern, "").trim()
  )).filter(Boolean);
}

function parseYuanseDescription(value: string): YuanseDescriptionSummary {
  const managed = value.match(YUANSE_SYNC_BLOCK_RE)?.[1] ?? "";
  const stage = managed.match(/\*\*制作阶段\*\*[：:]\s*([^\n]+)/)?.[1]?.trim() || "待补充";
  const progressSection = managed.match(/\*\*当前进度\*\*([\s\S]*?)(?=\n\*\*(?:思考日志|开放事项)\*\*|$)/)?.[1] ?? "";
  const thoughtSection = managed.match(/\*\*思考日志\*\*([\s\S]*?)(?=\n\*\*开放事项\*\*|$)/)?.[1] ?? "";
  const openSection = managed.match(/\*\*开放事项\*\*([\s\S]*?)$/)?.[1] ?? "";
  const updates = extractYuanseList(
    progressSection,
    /^\*\*[^*]+\*\*\s*·\s*`UPDATE #\d+`\s*/,
  );
  const facts = new Map<string, YuanseFact>(YUANSE_PRODUCTION_FACTS.map((fact) => [
    fact.label,
    {
      label: fact.label,
      value: fact.defaultValue,
      tone: fact.tone,
      statusTone: yuanseStatusTone(fact.defaultValue),
    },
  ]));
  const progressNotes: string[] = [];

  for (const update of updates) {
    for (let token of update.split(/[；;\n]+/)) {
      token = token.trim().replace(/[。.]$/, "").replace(/^当前进度[：:]\s*/, "");
      if (!token || token === "待补充") continue;
      if (/通过后开启|完毕后进入/.test(token)) continue;

      let label = "";
      let factValue = "";
      const pair = token.match(/^([^：:]{1,18})[：:]\s*(.+)$/);
      if (pair) {
        label = pair[1];
        factValue = pair[2];
      } else {
        const inline = token.match(/^(录鼓|鼓|吉他|贝斯|特殊乐器|人声|录唱)(.+)$/);
        if (inline) {
          label = inline[1];
          factValue = inline[2];
        } else {
          label = "最新进度";
          factValue = token;
        }
      }

      const normalizedLabel = normalizeYuanseProductionLabel(label, factValue);
      if (!normalizedLabel) {
        if (/^曲目序号$/.test(label.trim())) continue;
        progressNotes.push(pair ? `${label.trim()}：${factValue.trim()}` : factValue.trim());
        continue;
      }
      if (normalizedLabel === "特殊乐器") {
        const namedInstruments = yuanseNamedSpecialInstruments(factValue);
        if (namedInstruments.length) {
          facts.delete("特殊乐器");
          for (const instrument of namedInstruments) {
            facts.set(instrument.label, {
              label: instrument.label,
              value: instrument.value,
              tone: "instrument",
              statusTone: yuanseStatusTone(instrument.value),
            });
          }
          continue;
        }
      } else if (!YUANSE_PRODUCTION_FACTS.some((fact) => fact.label === normalizedLabel)) {
        facts.delete("特殊乐器");
      }
      const canonicalValue = canonicalYuanseFactValue(normalizedLabel, factValue);
      const progressNote = yuanseFactProgressNote(normalizedLabel, factValue);
      if (progressNote) progressNotes.push(progressNote);
      facts.set(normalizedLabel, {
        label: normalizedLabel,
        value: canonicalValue,
        tone: yuanseFactTone(normalizedLabel),
        statusTone: yuanseStatusTone(canonicalValue),
      });
    }
  }

  const openItems = extractYuanseList(openSection, /^`[^`]+`\s*/)
    .filter((item) => !/^(暂无|无)[。.]?$/.test(item));
  const thoughts = [...thoughtSection.matchAll(/^-\s+`([^`]+)`\s+(.+)$/gm)].map((match) => ({
    createdAt: match[1].trim(),
    text: match[2].trim(),
  }));

  if (/录音|混音|母带|完成/.test(stage) && facts.has("编曲")) {
    facts.set("编曲", {
      label: "编曲",
      value: "OK",
      tone: "arrangement",
      statusTone: "complete",
    });
  }

  for (const [label, factValue] of Object.entries(yuanseFactOverrides(value))) {
    const normalizedLabel = normalizeYuanseProductionLabel(label, factValue) ?? label.trim();
    if (!normalizedLabel) continue;
    if (!YUANSE_PRODUCTION_FACTS.some((fact) => fact.label === normalizedLabel)) facts.delete("特殊乐器");
    const existing = facts.get(normalizedLabel);
    facts.set(normalizedLabel, {
      label: normalizedLabel,
      value: factValue,
      tone: existing?.tone ?? yuanseFactTone(normalizedLabel),
      statusTone: yuanseStatusTone(factValue),
    });
  }

  return {
    stage,
    manualNotes: yuanseManualNotes(value),
    facts: orderedYuanseProductionFacts(facts),
    progressNotes: [...new Set(progressNotes)].filter(Boolean),
    thoughts,
    openItems,
  };
}

function YuanseDescriptionView({
  value,
  tasks,
  onOpenTask,
  onEditNotes,
  onSaveCosts,
  onSaveFact,
}: {
  value: string;
  tasks: Task[];
  onOpenTask: (task: TaskRelationSummary) => void;
  onEditNotes: () => void;
  onSaveCosts: (costs: YuanseCostItem[]) => Promise<boolean>;
  onSaveFact: (label: string, status: string) => Promise<boolean>;
}) {
  const { text } = useTaskboardI18n();
  const summary = parseYuanseDescription(value);
  const productionVisible = /^(录音中|混音母带|已完成)$/.test(summary.stage);
  const visibleFacts = productionVisible
    ? summary.facts
    : summary.facts.filter((fact) => fact.label === "编曲");
  return (
    <div className="yuanse-production-summary">
      <section className="yuanse-stage-card">
        <span>{text("当前制作阶段", "Current production stage")}</span>
        <strong>{summary.stage}</strong>
      </section>

      {visibleFacts.length > 0 && (
        <section className="yuanse-summary-section">
          <h2>{text("制作进度", "Production progress")}</h2>
          <div className="yuanse-fact-list">
            <div className="yuanse-fact-header" aria-hidden="true">
              <span>环节</span>
              <span>供应商 / 执行者</span>
              <span>状态</span>
            </div>
            {visibleFacts.map((fact) => {
              const supplier = yuanseFactSupplier(value, fact, summary.manualNotes);
              const ownership = yuanseSupplierIsExternal(supplier) ? "external" : "self";
              return (
                <div className={`yuanse-fact-row owner-${ownership}`} key={fact.label}>
                  <span className="yuanse-fact-label">{fact.label}</span>
                  <span className={`yuanse-fact-supplier${supplier.includes("待定") ? " is-pending" : ""}`}>{supplier}</span>
                  <select
                    className={`yuanse-fact-value yuanse-fact-select status-${fact.statusTone}`}
                    value={fact.value}
                    aria-label={`${fact.label}状态`}
                    onChange={(event) => void onSaveFact(fact.label, event.target.value)}
                  >
                    {[...new Set([
                      fact.value,
                      ...(fact.tone === "arrangement"
                        ? ["未开始", "编曲中", "修改中", "待确认", "OK"]
                        : fact.tone === "post"
                          ? ["未开始", "进行中", "待确认", "OK"]
                          : ["未录音", "录音中", "待确认", "OK"]),
                    ])].map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {productionVisible && <YuanseCostPanel value={value} onSave={onSaveCosts} />}

      {summary.thoughts.length > 0 && (
        <section className="yuanse-summary-section yuanse-thought-section">
          <h2>思考日志</h2>
          <ol>
            {summary.thoughts.map((thought, index) => (
              <li key={`${thought.createdAt}-${index}`}>
                <time>{thought.createdAt}</time>
                <p>{thought.text}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="yuanse-summary-section yuanse-notes-section">
        <header>
          <h2>{text("看板备注", "Board notes")}</h2>
          <button type="button" onClick={onEditNotes}>{text("编辑", "Edit")}</button>
        </header>
        {summary.manualNotes ? (
          <DescriptionDocument value={summary.manualNotes} tasks={tasks} onOpenTask={onOpenTask} />
        ) : summary.progressNotes.length === 0 ? (
          <p className="yuanse-empty-notes">{text("点击这里添加备注", "Click here to add notes")}</p>
        ) : null}
        {summary.progressNotes.length > 0 && (
          <ul className="yuanse-progress-notes">
            {summary.progressNotes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        )}
      </section>

      {summary.openItems.length > 0 && (
        <section className="yuanse-summary-section yuanse-open-items">
          <h2>{text("待处理", "Open items")}</h2>
          <ul>{summary.openItems.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

function YuanseCostPanel({
  value,
  onSave,
}: {
  value: string;
  onSave: (costs: YuanseCostItem[]) => Promise<boolean>;
}) {
  const [costs, setCosts] = useState(() => yuanseCosts(value));
  const [saving, setSaving] = useState(false);
  const total = costs.reduce((sum, item) => sum + item.total, 0);
  const paid = costs.reduce((sum, item) => sum + item.paid, 0);
  const remaining = Math.max(0, total - paid);

  useEffect(() => setCosts(yuanseCosts(value)), [value]);

  function addCost(
    service: string,
    supplier = "",
    total = 0,
    paymentStatus: YuansePaymentStatus = "unpaid",
  ) {
    setCosts((current) => [...current, {
      id: createYuanseCostId(),
      service,
      supplier,
      total,
      paid: paymentStatus === "paid" ? total : 0,
      paymentStatus,
    }]);
  }

  function updateCost(id: string, changes: Partial<YuanseCostItem>) {
    setCosts((current) => current.map((item) => item.id === id ? { ...item, ...changes } : item));
  }

  async function saveCosts() {
    setSaving(true);
    try {
      await onSave(costs);
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="yuanse-cost-panel">
      <summary>
        <span>
          <strong>供应商与成本</strong>
          <small>{costs.length ? `${costs.length} 项` : "尚未登记"}</small>
        </span>
        <span className="yuanse-cost-summary">
          <b>成本 {yuanseMoney(total)}</b>
          <em>已付 {yuanseMoney(paid)}</em>
        </span>
      </summary>

      <div className="yuanse-cost-panel-body">
        <div className="yuanse-cost-totals">
          <span><small>总成本</small><strong>{yuanseMoney(total)}</strong></span>
          <span><small>已支付</small><strong className="is-paid">{yuanseMoney(paid)}</strong></span>
          <span><small>待支付</small><strong className="is-pending">{yuanseMoney(remaining)}</strong></span>
        </div>

        {costs.length > 0 && (
          <div className="yuanse-cost-list">
            {costs.map((item) => (
              <div className="yuanse-cost-row" key={item.id}>
                <label>项目<input value={item.service} placeholder="如：弦乐 / 风笛" onChange={(event) => updateCost(item.id, { service: event.target.value })} /></label>
                <label>供应商<input value={item.supplier} placeholder="姓名或工作室" onChange={(event) => updateCost(item.id, { supplier: event.target.value })} /></label>
                <label>总费用<input type="number" min="0" step="0.01" value={item.total} onChange={(event) => updateCost(item.id, { total: Math.max(0, Number(event.target.value) || 0) })} /></label>
                <label>已支付<input type="number" min="0" step="0.01" value={item.paid} onChange={(event) => updateCost(item.id, { paid: Math.max(0, Number(event.target.value) || 0) })} /></label>
                <label>付款状态<select value={item.paymentStatus} onChange={(event) => {
                  const paymentStatus = event.target.value as YuansePaymentStatus;
                  updateCost(item.id, {
                    paymentStatus,
                    ...(paymentStatus === "unpaid" ? { paid: 0 } : {}),
                    ...(paymentStatus === "paid" ? { paid: item.total } : {}),
                  });
                }}><option value="unpaid">未支付</option><option value="partial">部分支付</option><option value="paid">已付清</option></select></label>
                <button type="button" className="yuanse-cost-remove" onClick={() => setCosts((current) => current.filter((cost) => cost.id !== item.id))}>删除</button>
              </div>
            ))}
          </div>
        )}

        <div className="yuanse-cost-actions">
          <div>
            <button type="button" onClick={() => addCost("鼓", "Tony Morra", 1500, "paid")}>+ Tony Morra · 鼓</button>
            <button type="button" onClick={() => addCost("特殊乐器")}>+ 特殊乐器</button>
            <button type="button" onClick={() => addCost("混音")}>+ 混音</button>
            <button type="button" onClick={() => addCost("母带")}>+ 母带</button>
            <button type="button" onClick={() => addCost("其他服务")}>+ 其他</button>
          </div>
          <button type="button" className="yuanse-cost-save" disabled={saving} onClick={() => void saveCosts()}>{saving ? "保存中…" : "保存成本"}</button>
        </div>
      </div>
    </details>
  );
}

function ConversationLink({
  threadId,
  onOpen,
}: {
  threadId: string;
  onOpen: (threadId: string) => void;
}) {
  const { text } = useTaskboardI18n();
  return (
    <button
      className="issue-conversation-link"
      type="button"
      title={text(`查看对话 ${threadId}`, `View conversation ${threadId}`)}
      onClick={() => onOpen(threadId)}
    >
      <TaskboardIcon name="conversation" />
      <strong>{text("查看对话", "View conversation")}</strong>
      <span className="conversation-divider" aria-hidden="true" />
      <span className="conversation-thread-id">{threadId}</span>
    </button>
  );
}

export function TaskDetail({
  task,
  tasks,
  currentUser,
  availableLabels,
  developmentScan,
  developmentScanLoading,
  commentsRevision,
  attachmentsRevision,
  onCreateLabel,
  onDeleteLabel,
  onUpdate,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
  onOpenThread,
  onOpenInThread,
  onCopy,
  openingThread,
  onError,
}: TaskDetailProps) {
  const { language, locale, text } = useTaskboardI18n();
  const yuanseTask = isYuanseDescription(task.description);
  const [currentTask, setCurrentTask] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [descriptionSegments, setDescriptionSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(yuanseTask ? yuanseManualNotes(task.description) : task.description),
  );
  const [editingDescription, setEditingDescription] = useState(false);
  const [propertyMenu, setPropertyMenu] = useState<"status" | "priority" | "assignee" | "labels" | null>(null);
  const [savingProperty, setSavingProperty] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(true);
  const [attachmentsError, setAttachmentsError] = useState<TaskDetailError | null>(null);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [pendingAttachmentDelete, setPendingAttachmentDelete] = useState<Attachment | null>(null);
  const [deletingAttachment, setDeletingAttachment] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [taskActivities, setTaskActivities] = useState<TaskChangeActivity[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<TaskDetailError | null>(null);
  const [commentSegments, setCommentSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(
      taskboardStorage.getItem(`taskboard.comment-draft.${task.id}`) ?? "",
    ),
  );
  const [pendingCommentFiles, setPendingCommentFiles] = useState<File[]>([]);
  const [changeStatusToTodo, setChangeStatusToTodo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSegments, setEditingSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(),
  );
  const [savingCommentId, setSavingCommentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Comment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionComposerRef = useRef<InlineMediaComposerHandle>(null);
  const composerRef = useRef<InlineMediaComposerHandle>(null);
  const editingComposerRef = useRef<InlineMediaComposerHandle>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const commentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const editCommentImageInputRef = useRef<HTMLInputElement>(null);
  const editingUploadedAttachmentsRef = useRef<Map<string, Attachment>>(new Map());
  const draft = serializeInlineMedia(commentSegments);
  const commentInlineImages = inlineMediaImages(commentSegments);
  const editingDraft = serializeInlineMedia(editingSegments);
  const displayIdentifier = currentTask.externalKey ?? currentTask.identifier;
  const editingInlineImages = inlineMediaImages(editingSegments);

  useEffect(() => {
    const taskChanged = currentTask.id !== task.id;
    setCurrentTask(task);
    if (document.activeElement !== titleRef.current) setTitle(task.title);
    if (taskChanged || !editingDescription) {
      setDescription(task.description);
      setDescriptionSegments(createInlineMediaSegments(
        isYuanseDescription(task.description) ? yuanseManualNotes(task.description) : task.description,
      ));
    }
    if (taskChanged) {
      setEditingDescription(false);
      setChangeStatusToTodo(false);
    }
  }, [task]);

  useEffect(() => {
    resizeTextarea(titleRef.current);
  }, [title]);

  useEffect(() => {
    if (!editingDescription) return;
    requestAnimationFrame(() => {
      descriptionComposerRef.current?.focus();
    });
  }, [editingDescription]);

  useEffect(() => {
    if (!editingId) return;
    requestAnimationFrame(() => {
      editingComposerRef.current?.focus();
    });
  }, [editingId]);

  useEffect(() => {
    const controller = new AbortController();
    setCommentsLoading(true);
    setCommentsError(null);
    void Promise.all([
      listComments(task.id, controller.signal),
      listTaskActivities(task.id, controller.signal),
    ]).then(
      ([nextComments, nextActivities]) => {
        setComments(nextComments);
        setTaskActivities(nextActivities);
        setCommentsLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setCommentsError(messageFor(error));
        setCommentsLoading(false);
      },
    );
    return () => controller.abort();
  }, [commentsRevision, task.activityKey, task.id]);

  useEffect(() => {
    const controller = new AbortController();
    setAttachmentsLoading(true);
    setAttachmentsError(null);
    void listAttachments(task.id, controller.signal).then(
      (nextAttachments) => {
        setAttachments(nextAttachments.filter((attachment) => !attachment.commentId));
        setAttachmentsLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setAttachmentsError(messageFor(error));
        setAttachmentsLoading(false);
      },
    );
    return () => controller.abort();
  }, [attachmentsRevision, task.id]);

  useEffect(() => {
    function receiveAttachmentOpenError(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      if (event.data.type !== "taskboard:attachment-open-error") return;
      setAttachmentsError(typeof event.data.payload?.error === "string"
        ? event.data.payload.error
        : ["无法打开附件，请重试。", "Could not open the attachment. Try again."]);
    }
    window.addEventListener("message", receiveAttachmentOpenError);
    return () => window.removeEventListener("message", receiveAttachmentOpenError);
  }, []);

  useEffect(() => {
    const key = `taskboard.comment-draft.${task.id}`;
    const text = inlineMediaText(commentSegments);
    if (text) taskboardStorage.setItem(key, text);
    else taskboardStorage.removeItem(key);
  }, [commentSegments, task.id]);

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() !== "r" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      composerRef.current?.focus();
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!activeMenuId) return;
    function closeMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest(`[data-comment-menu-root="${activeMenuId}"]`)) setActiveMenuId(null);
    }
    function closeWithEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setActiveMenuId(null);
    }
    document.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [activeMenuId]);

  async function saveTask(changes: Partial<TaskDraft>, property: string) {
    setSavingProperty(property);
    onError(null);
    try {
      const saved = await onUpdate(currentTask, changes);
      setCurrentTask(saved);
      setTitle(saved.title);
      setDescription(saved.description);
      return saved;
    } catch (error) {
      onError(issueMessageFor(error));
      setTitle(currentTask.title);
      setDescription(currentTask.description);
      return null;
    } finally {
      setSavingProperty(null);
    }
  }

  async function applyRelationMutation(
    mutation: () => Promise<RelationMutationResult>,
  ): Promise<RelationMutationResult> {
    onError(null);
    try {
      const result = await mutation();
      const nextCurrent = result.task.id === currentTask.id
        ? result.task
        : result.relatedTask.id === currentTask.id
          ? result.relatedTask
          : null;
      if (nextCurrent) setCurrentTask(nextCurrent);
      return result;
    } catch (error) {
      onError(issueMessageFor(error));
      throw error;
    }
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      setTitle(currentTask.title);
      event.currentTarget.blur();
    }
  }

  async function saveTitle() {
    const normalized = title.trim();
    if (!normalized) {
      setTitle(currentTask.title);
      onError(["议题标题不能为空。", "Issue title cannot be empty."]);
      return;
    }
    if (normalized === currentTask.title) {
      setTitle(normalized);
      return;
    }
    await saveTask({ title: normalized }, "title");
  }

  async function saveDescription() {
    if (savingProperty === "description") return;
    const draftDescription = serializeInlineMedia(descriptionSegments).trim();
    const inlineImages = inlineMediaImages(descriptionSegments);
    const currentEditableDescription = isYuanseDescription(currentTask.description)
      ? yuanseManualNotes(currentTask.description)
      : currentTask.description;
    if (draftDescription === currentEditableDescription && inlineImages.length === 0) {
      setEditingDescription(false);
      return;
    }

    setSavingProperty("description");
    onError(null);
    try {
      const uploaded = await Promise.all(
        inlineImages.map((image) => uploadAttachment(currentTask.id, image.file)),
      );
      const resolvedDescription = resolveInlineMediaMarkdown(
        draftDescription,
        inlineImages,
        uploaded,
      ).trim();
      const savedDescription = isYuanseDescription(currentTask.description)
        ? mergeYuanseManualNotes(currentTask.description, resolvedDescription)
        : resolvedDescription;
      const saved = await onUpdate(currentTask, { description: savedDescription }).catch((error) => {
        onError(issueMessageFor(error));
        return null;
      });
      if (!saved) return;
      setCurrentTask(saved);
      setDescription(saved.description);
      setDescriptionSegments(createInlineMediaSegments(
        isYuanseDescription(saved.description) ? yuanseManualNotes(saved.description) : saved.description,
      ));
      setAttachments((current) => [
        ...current,
        ...uploaded.filter((attachment) => !current.some((item) => item.id === attachment.id)),
      ]);
      setEditingDescription(false);
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setSavingProperty(null);
    }
  }

  async function saveYuanseCosts(costs: YuanseCostItem[]): Promise<boolean> {
    if (savingProperty === "yuanse-costs") return false;
    setSavingProperty("yuanse-costs");
    onError(null);
    try {
      const saved = await onUpdate(currentTask, {
        description: mergeYuanseCosts(currentTask.description, costs),
      });
      setCurrentTask(saved);
      setDescription(saved.description);
      return true;
    } catch (error) {
      onError(issueMessageFor(error));
      return false;
    } finally {
      setSavingProperty(null);
    }
  }

  async function saveYuanseFact(label: string, status: string): Promise<boolean> {
    if (savingProperty === "yuanse-fact") return false;
    setSavingProperty("yuanse-fact");
    onError(null);
    try {
      const saved = await onUpdate(currentTask, {
        description: mergeYuanseFactOverride(currentTask.description, label, status),
      });
      setCurrentTask(saved);
      setDescription(saved.description);
      return true;
    } catch (error) {
      onError(issueMessageFor(error));
      return false;
    } finally {
      setSavingProperty(null);
    }
  }

  async function submitComment() {
    const body = draft.trim();
    if ((!body && pendingCommentFiles.length === 0 && commentInlineImages.length === 0) || submitting) return;
    setSubmitting(true);
    setCommentsError(null);
    try {
      const comment = await createComment(task.id, body);
      const [results, inlineAttachments] = await Promise.all([
        Promise.allSettled(
          pendingCommentFiles.map((file) => uploadCommentAttachment(comment.id, file)),
        ),
        Promise.all(
          commentInlineImages.map((image) => uploadCommentAttachment(comment.id, image.file)),
        ),
      ]);
      const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const nextComment = commentInlineImages.length > 0
        ? await updateComment(
            comment,
            resolveInlineMediaMarkdown(body, commentInlineImages, inlineAttachments),
          )
        : { ...comment, attachments: [...comment.attachments, ...uploaded] };
      setComments((current) => [...current, nextComment]);
      setCommentSegments(createInlineMediaSegments());
      setPendingCommentFiles([]);
      if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      if (changeStatusToTodo) {
        const saved = await onUpdate(currentTask, { status: "todo" });
        setCurrentTask(saved);
        setChangeStatusToTodo(false);
      }
      const failed = results.length - uploaded.length;
      if (failed > 0) setCommentsError([
        `评论已发布，但有 ${failed} 个附件上传失败。`,
        `The comment was posted, but ${failed} attachments failed to upload.`,
      ]);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSubmitting(false);
    }
  }

  function stageCommentFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setCommentsError([
        `“${oversized.name}” 超过 25 MB，无法上传。`,
        `“${oversized.name}” is larger than 25 MB and cannot be uploaded.`,
      ]);
      if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      return;
    }
    setCommentsError(null);
    setPendingCommentFiles((current) => {
      const existing = new Set(current.map(fileKey));
      return [...current, ...selected.filter((file) => !existing.has(fileKey(file)))];
    });
  }

  function handleSubmitShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitComment();
    }
  }

  function beginEdit(comment: Comment) {
    if (savingCommentId !== null) return;
    editingUploadedAttachmentsRef.current.clear();
    setEditingId(comment.id);
    setEditingSegments(createInlineMediaSegments(comment.body));
    setActiveMenuId(null);
  }

  function endCommentEdit() {
    setEditingId(null);
    editingUploadedAttachmentsRef.current.clear();
  }

  async function saveComment(comment: Comment) {
    const body = editingDraft.trim();
    if (!body || (body === comment.body && editingInlineImages.length === 0)) {
      if (body === comment.body) endCommentEdit();
      return;
    }
    setSavingCommentId(comment.id);
    setCommentsError(null);
    try {
      const uploaded: Attachment[] = [];
      for (const image of editingInlineImages) {
        let attachment = editingUploadedAttachmentsRef.current.get(image.id);
        if (!attachment) {
          attachment = await uploadCommentAttachment(comment.id, image.file);
          editingUploadedAttachmentsRef.current.set(image.id, attachment);
        }
        uploaded.push(attachment);
      }
      const updated = await updateComment(
        comment,
        resolveInlineMediaMarkdown(body, editingInlineImages, uploaded).trim(),
      );
      setComments((current) => current.map((item) => item.id === updated.id ? updated : item));
      endCommentEdit();
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSavingCommentId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setCommentsError(null);
    try {
      await deleteComment(pendingDelete);
      setComments((current) => current.filter((comment) => comment.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setDeleting(false);
    }
  }

  async function uploadFiles(files: FileList) {
    const selected = Array.from(files);
    if (selected.length === 0 || uploadingAttachments) return;
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setAttachmentsError([
        `“${oversized.name}” 超过 25 MB，无法上传。`,
        `“${oversized.name}” is larger than 25 MB and cannot be uploaded.`,
      ]);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
      return;
    }

    setUploadingAttachments(true);
    setAttachmentsError(null);
    try {
      for (const file of selected) {
        const attachment = await uploadAttachment(task.id, file);
        setAttachments((current) => current.some((item) => item.id === attachment.id)
          ? current
          : [...current, attachment]);
      }
    } catch (error) {
      setAttachmentsError(messageFor(error));
    } finally {
      setUploadingAttachments(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  }

  async function confirmAttachmentDelete() {
    if (!pendingAttachmentDelete || deletingAttachment) return;
    setDeletingAttachment(true);
    setAttachmentsError(null);
    try {
      await deleteAttachment(pendingAttachmentDelete);
      setAttachments((current) => current.filter((attachment) => attachment.id !== pendingAttachmentDelete.id));
      setComments((current) => current.map((comment) => ({
        ...comment,
        attachments: comment.attachments.filter((attachment) => attachment.id !== pendingAttachmentDelete.id),
      })));
      setPendingAttachmentDelete(null);
    } catch (error) {
      setAttachmentsError(messageFor(error));
    } finally {
      setDeletingAttachment(false);
    }
  }

  function handleAttachmentDownload(event: MouseEvent<HTMLAnchorElement>, attachment: Attachment) {
    event.preventDefault();
    setAttachmentsError(null);
    void downloadAttachmentFile(attachment).catch((error) => {
      setAttachmentsError(messageFor(error));
    });
  }

  const developmentOptions = [...developmentScan.contexts];
  if (
    currentTask.developmentContext
    && !developmentOptions.some((context) => contextValue(context) === contextValue(currentTask.developmentContext))
  ) {
    developmentOptions.unshift(currentTask.developmentContext);
  }
  const assigneeOptions = [currentTask.assignee, currentUser, CODEX_AGENT_ACTOR]
    .filter((actor, index, actors) => (
      actors.findIndex((candidate) => actorKey(candidate) === actorKey(actor)) === index
    ));
  const visibleTaskAttachments = attachments.filter(
    (attachment) => !markdownIncludesAttachment(description, attachment),
  );
  const activityTimeline = [
    ...taskActivities.flatMap((activity) => activity.changes.map((change, index) => ({
      kind: "change" as const,
      id: `${activity.id}-${index}`,
      createdAt: activity.createdAt,
      activity,
      change,
    }))),
    ...comments.map((comment) => ({
      kind: "comment" as const,
      id: comment.id,
      createdAt: comment.createdAt,
      comment,
    })),
  ].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  ));

  return (
    <section
      className={`issue-detail${yuanseTask ? " yuanse-issue-detail" : ""}`}
      aria-label={text(`${displayIdentifier} 议题详情`, `${displayIdentifier} issue details`)}
    >
      <div className="issue-detail-scroll">
        <div className="issue-detail-layout">
          <div className="issue-detail-main">
            <article className="issue-editor" aria-label={text("议题内容", "Issue content")}>
              <div className="issue-editor-content">
                <textarea
                  ref={titleRef}
                  className="issue-title-input"
                  rows={1}
                  value={title}
                  aria-label={text("议题标题", "Issue title")}
                  disabled={savingProperty === "title"}
                  onChange={(event) => {
                    setTitle(event.target.value.replace(/\n/g, ""));
                    resizeTextarea(event.currentTarget);
                  }}
                  onKeyDown={handleTitleKeyDown}
                  onBlur={() => void saveTitle()}
                />
                {!yuanseTask && <IssueParentLink
                  task={currentTask}
                  tasks={tasks}
                  onOpenTask={onOpenTask}
                  onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                    () => onAddRelation(anchor, type, relatedTaskId),
                  )}
                  onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                    () => onRemoveRelation(anchor, type, relatedTaskId),
                  )}
                />}
                {editingDescription ? (
                  <div
                    className="issue-description-composer"
                    onBlur={(event) => {
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      void saveDescription();
                    }}
                  >
                    <InlineMediaComposer
                      ref={descriptionComposerRef}
                      segments={descriptionSegments}
                      mentionTasks={tasks}
                      placeholder={text("添加描述…", "Add description…")}
                      ariaLabel={text("议题描述", "Issue description")}
                      disabled={savingProperty === "description"}
                      onChange={setDescriptionSegments}
                      onError={onError}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setDescriptionSegments(createInlineMediaSegments(
                            yuanseTask ? yuanseManualNotes(currentTask.description) : currentTask.description,
                          ));
                          setEditingDescription(false);
                        }
                      }}
                    />
                  </div>
                ) : (
                  <div
                    className={`issue-description-read${description ? "" : " empty"}`}
                    role={yuanseTask ? undefined : "button"}
                    tabIndex={yuanseTask ? undefined : 0}
                    aria-label={text("编辑议题描述", "Edit issue description")}
                    onClick={() => {
                      if (yuanseTask) return;
                      if (window.getSelection()?.isCollapsed === false) return;
                      setDescriptionSegments(createInlineMediaSegments(
                        yuanseTask ? yuanseManualNotes(description) : description,
                      ));
                      setEditingDescription(true);
                    }}
                    onKeyDown={(event) => {
                      if (yuanseTask) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setDescriptionSegments(createInlineMediaSegments(
                          yuanseTask ? yuanseManualNotes(description) : description,
                        ));
                        setEditingDescription(true);
                      }
                    }}
                  >
                    {description
                      ? yuanseTask
                        ? (
                            <YuanseDescriptionView
                              value={description}
                              tasks={tasks}
                              onOpenTask={onOpenTask}
                              onSaveCosts={saveYuanseCosts}
                              onSaveFact={saveYuanseFact}
                              onEditNotes={() => {
                                setDescriptionSegments(createInlineMediaSegments(yuanseManualNotes(description)));
                                setEditingDescription(true);
                              }}
                            />
                          )
                        : <DescriptionDocument value={description} tasks={tasks} onOpenTask={onOpenTask} />
                      : text("添加描述…", "Add description…")}
                  </div>
                )}
                {currentTask.threadId && (
                  <div
                    className="issue-conversation-list"
                    aria-label={text("处理此议题的对话", "Conversations for this issue")}
                  >
                    <ConversationLink threadId={currentTask.threadId} onOpen={onOpenThread} />
                  </div>
                )}
              </div>
            </article>

            <IssueSubIssues
              task={currentTask}
              tasks={tasks}
              onOpenTask={onOpenTask}
              onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onAddRelation(anchor, type, relatedTaskId),
              )}
              onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onRemoveRelation(anchor, type, relatedTaskId),
              )}
            />

            <section className="issue-attachments" aria-labelledby="attachments-heading">
              <header className="attachments-heading">
                <div>
                  <h2 id="attachments-heading">{text("附件", "Attachments")}</h2>
                  <span>{visibleTaskAttachments.length}</span>
                </div>
                <button
                  className="attachment-add-button"
                  type="button"
                  disabled={uploadingAttachments}
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  <LinearIcon name="attachment" />
                  {uploadingAttachments
                    ? text("上传中…", "Uploading…")
                    : text("添加附件", "Add attachment")}
                </button>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.currentTarget.files) void uploadFiles(event.currentTarget.files);
                  }}
                />
              </header>

              {attachmentsLoading ? (
                <div className="attachments-loading" aria-label={text("正在加载附件", "Loading attachments")} aria-busy="true"><i /><i /></div>
              ) : visibleTaskAttachments.length > 0 ? (
                <ul className="attachment-list">
                  {visibleTaskAttachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        className="attachment-link"
                        href={attachmentDownloadUrl(attachment)}
                        download={attachment.filename}
                        title={text(`下载 ${attachment.filename}`, `Download ${attachment.filename}`)}
                        onClick={(event) => handleAttachmentDownload(event, attachment)}
                      >
                        <span className="attachment-file-icon" aria-hidden="true">
                          <LinearIcon name="file" />
                        </span>
                        <span className="attachment-copy">
                          <strong>{attachment.filename}</strong>
                          <span>{fileSize(attachment.size)} · {relativeTime(attachment.createdAt, locale)}</span>
                        </span>
                      </a>
                      <div className="attachment-actions">
                        <a
                          href={attachmentDownloadUrl(attachment)}
                          download={attachment.filename}
                          aria-label={text(`下载 ${attachment.filename}`, `Download ${attachment.filename}`)}
                          title={text("下载附件", "Download attachment")}
                          onClick={(event) => handleAttachmentDownload(event, attachment)}
                        >
                          <LinearIcon name="openExternal" />
                        </a>
                        <button
                          type="button"
                          aria-label={text(`删除 ${attachment.filename}`, `Delete ${attachment.filename}`)}
                          title={text("删除附件", "Delete attachment")}
                          onClick={() => setPendingAttachmentDelete(attachment)}
                        >
                          <LinearIcon name="trash" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="attachments-empty">{text(
                  "添加图片、文档或其他文件，单个文件不超过 25 MB。",
                  "Add images, documents, or other files up to 25 MB each.",
                )}</p>
              )}
              {attachmentsError && (
                <div className="attachments-error" role="alert">
                  {typeof attachmentsError === "string"
                    ? attachmentsError
                    : text(attachmentsError[0], attachmentsError[1])}
                </div>
              )}
            </section>

            <section className="activity-section" aria-labelledby="activity-heading">
              <header className="activity-heading">
                <h2 id="activity-heading">{text("活动", "Activity")}</h2>
                <span>{activityTimeline.length}</span>
              </header>

              <div className="activity-stream">
                <div className={`activity-entry activity-created is-${currentTask.creatorType}`}>
                  <span className="activity-rail-icon activity-creator-icon" aria-hidden="true">
                    <ActorAvatar
                      className="comment-avatar"
                      actor={{
                        type: currentTask.creatorType,
                        id: currentTask.creatorId,
                        name: currentTask.creatorName,
                        avatarUrl: currentTask.creatorAvatarUrl,
                      }}
                    />
                  </span>
                  <p>
                    <strong>{currentTask.creatorName}</strong>
                    {text(" 创建了此议题", " created this issue")}
                    <time title={exactTime(currentTask.createdAt, locale)}>{relativeTime(currentTask.createdAt, locale)}</time>
                  </p>
                </div>

                {commentsLoading ? (
                  <div className="comments-loading" aria-label={text("正在加载活动", "Loading activity")} aria-busy="true"><i /><i /></div>
                ) : activityTimeline.map((item) => {
                  if (item.kind === "change") {
                    const { activity, change } = item;
                    const fieldLabels = ACTIVITY_FIELD_LABELS[change.field];
                    const fieldLabel = fieldLabels
                      ? text(fieldLabels[0], fieldLabels[1])
                      : change.field;
                    const beforeValue = activityValue(
                      change.field,
                      change.before,
                      language,
                      locale,
                      text,
                    );
                    const afterValue = activityValue(
                      change.field,
                      change.after,
                      language,
                      locale,
                      text,
                    );
                    return (
                      <article
                        className={`activity-entry activity-change is-${activity.actorType}`}
                        key={item.id}
                      >
                        <span className="activity-rail-icon" aria-hidden="true">
                          <ActivityChangeIcon
                            field={change.field}
                            before={change.before}
                            after={change.after}
                          />
                        </span>
                        <p>
                          <strong>{activity.actorName}</strong>
                          {" "}
                          {change.field === "description" ? (
                            <>{text("更新了描述", "updated the description")}</>
                          ) : change.field === "relation" && change.before === null ? (
                            <>{text("添加了 ", "added ")}<span className="activity-change-value">{afterValue}</span></>
                          ) : change.field === "relation" && change.after === null ? (
                            <>{text("移除了 ", "removed ")}<span className="activity-change-value">{beforeValue}</span></>
                          ) : language === "zh" ? (
                            <>
                              将{fieldLabel}从
                              <span className="activity-change-value">{beforeValue}</span>
                              改为
                              <span className="activity-change-value">{afterValue}</span>
                            </>
                          ) : (
                            <>
                              {`changed ${fieldLabel} from `}
                              <span className="activity-change-value">{beforeValue}</span>
                              {" to "}
                              <span className="activity-change-value">{afterValue}</span>
                            </>
                          )}
                          <time title={exactTime(activity.createdAt, locale)}>{relativeTime(activity.createdAt, locale)}</time>
                        </p>
                      </article>
                    );
                  }
                  const comment = item.comment;
                  return (
                  <article
                    className={`comment-entry is-${comment.authorType}`}
                    key={comment.id}
                    id={`comment-${comment.id}`}
                  >
                    <div className="comment-card">
                      <header className="comment-header">
                        <ActorAvatar
                          className="comment-avatar"
                          actor={{
                            type: comment.authorType,
                            id: comment.authorId,
                            name: comment.authorName,
                            avatarUrl: comment.authorAvatarUrl,
                          }}
                        />
                        <strong>{comment.authorName}</strong>
                        <span className="actor-id">@{comment.authorId}</span>
                        <time title={exactTime(comment.createdAt, locale)}>{relativeTime(comment.createdAt, locale)}</time>
                        {comment.version > 1 && (
                          <span
                            className="comment-edited"
                            title={text(
                              `编辑于 ${exactTime(comment.updatedAt, locale)}`,
                              `Edited ${exactTime(comment.updatedAt, locale)}`,
                            )}
                          >
                            {text("已编辑", "Edited")}
                          </span>
                        )}
                        {editingId !== comment.id && (
                          <div className="comment-actions" data-comment-menu-root={comment.id}>
                            <button
                              type="button"
                              className="comment-menu-trigger"
                              aria-label={text("评论操作", "Comment actions")}
                              aria-haspopup="menu"
                              aria-expanded={activeMenuId === comment.id}
                              onClick={() => setActiveMenuId((current) => current === comment.id ? null : comment.id)}
                            >
                              <LinearIcon name="more" />
                            </button>
                            {activeMenuId === comment.id && (
                              <div className="comment-action-menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={savingCommentId !== null}
                                  onClick={() => beginEdit(comment)}
                                >
                                  <LinearIcon name="write" />
                                  {text("编辑评论", "Edit comment")}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="danger"
                                  onClick={() => { setPendingDelete(comment); setActiveMenuId(null); }}
                                >
                                  <LinearIcon name="trash" />
                                  {text("删除评论", "Delete comment")}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </header>

                      {editingId === comment.id ? (
                        <div className="comment-edit-form">
                          <InlineMediaComposer
                            ref={editingComposerRef}
                            className="comment-inline-media"
                            segments={editingSegments}
                            mentionTasks={tasks}
                            placeholder={text("编辑评论", "Edit comment")}
                            ariaLabel={text("编辑评论", "Edit comment")}
                            disabled={savingCommentId === comment.id}
                            onChange={setEditingSegments}
                            onError={setCommentsError}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") endCommentEdit();
                              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                void saveComment(comment);
                              }
                            }}
                          />
                          <div className="comment-edit-actions">
                            <button
                              className="button secondary"
                              type="button"
                              disabled={savingCommentId === comment.id}
                              onClick={() => editCommentImageInputRef.current?.click()}
                            >
                              <LinearIcon name="attachment" />
                              {text("添加图片", "Add images")}
                            </button>
                            <input
                              ref={editCommentImageInputRef}
                              type="file"
                              accept="image/*"
                              multiple
                              hidden
                              onChange={(event) => {
                                if (event.currentTarget.files) {
                                  editingComposerRef.current?.addImages(event.currentTarget.files);
                                }
                                event.currentTarget.value = "";
                              }}
                            />
                            <button
                              className="button secondary"
                              type="button"
                              disabled={savingCommentId === comment.id}
                              onClick={endCommentEdit}
                            >
                              {text("取消", "Cancel")}
                            </button>
                            <button
                              className="button primary"
                              type="button"
                              disabled={!editingDraft.trim() || savingCommentId === comment.id}
                              onClick={() => void saveComment(comment)}
                            >
                              {savingCommentId === comment.id
                                ? text("保存中…", "Saving…")
                                : text("保存", "Save")}
                            </button>
                          </div>
                        </div>
                      ) : (
                        comment.body && (
                          <div className="comment-body">
                            <DescriptionDocument value={comment.body} tasks={tasks} onOpenTask={onOpenTask} />
                          </div>
                        )
                      )}
                      {comment.attachments.some(
                        (attachment) => !markdownIncludesAttachment(comment.body, attachment),
                      ) && (
                        <ul className="comment-attachment-list" aria-label={text("评论附件", "Comment attachments")}>
                          {comment.attachments
                            .filter((attachment) => !markdownIncludesAttachment(comment.body, attachment))
                            .map((attachment) => (
                              <li key={attachment.id}>
                                <a
                                  href={attachmentDownloadUrl(attachment)}
                                  download={attachment.filename}
                                  title={text(`下载 ${attachment.filename}`, `Download ${attachment.filename}`)}
                                  onClick={(event) => handleAttachmentDownload(event, attachment)}
                                >
                                  <span className="attachment-file-icon" aria-hidden="true">
                                    <LinearIcon name="file" />
                                  </span>
                                  <span><strong>{attachment.filename}</strong><small>{fileSize(attachment.size)}</small></span>
                                </a>
                                {editingId !== comment.id && (
                                  <button
                                    type="button"
                                    aria-label={text(`删除 ${attachment.filename}`, `Delete ${attachment.filename}`)}
                                    title={text("删除附件", "Delete attachment")}
                                    onClick={() => setPendingAttachmentDelete(attachment)}
                                  >
                                    <LinearIcon name="trash" />
                                  </button>
                                )}
                              </li>
                            ))}
                        </ul>
                      )}
                      {comment.threadId && (
                        <div className="comment-conversation-link">
                          <ConversationLink threadId={comment.threadId} onOpen={onOpenThread} />
                        </div>
                      )}
                    </div>
                  </article>
                  );
                })}
              </div>

              {commentsError && (
                <div className="comments-error" role="alert">
                  {typeof commentsError === "string"
                    ? commentsError
                    : text(commentsError[0], commentsError[1])}
                </div>
              )}

              <form className="comment-composer" onSubmit={(event) => { event.preventDefault(); void submitComment(); }}>
                <div className="composer-author">
                  <ActorAvatar
                    className="comment-avatar"
                    actor={currentUser}
                  />
                  <strong>{currentUser.name}</strong>
                  <span className="actor-id">@{currentUser.id}</span>
                </div>
                <InlineMediaComposer
                  ref={composerRef}
                  className="comment-inline-media"
                  segments={commentSegments}
                  mentionTasks={tasks}
                  placeholder={text("留下评论…", "Leave a comment…")}
                  ariaLabel={text("留下评论", "Leave a comment")}
                  onChange={setCommentSegments}
                  onError={setCommentsError}
                  onKeyDown={handleSubmitShortcut}
                />
                <PendingAttachments
                  files={pendingCommentFiles}
                  disabled={submitting}
                  uploadLabel={text("发布后上传", "Upload after posting")}
                  ariaLabel={text("待上传评论附件", "Pending comment attachments")}
                  className="comment-composer-files"
                  onRemove={(index) => setPendingCommentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                />
                <footer className="composer-footer">
                  <div className="composer-footer-leading">
                    <button
                      className="comment-attach-button"
                      type="button"
                      disabled={submitting}
                      aria-label={text("添加评论附件", "Add comment attachments")}
                      title={text("添加附件", "Add attachments")}
                      onClick={() => commentAttachmentInputRef.current?.click()}
                    >
                      <LinearIcon name="attachment" />
                    </button>
                    <input
                      ref={commentAttachmentInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        if (event.currentTarget.files) stageCommentFiles(event.currentTarget.files);
                      }}
                    />
                  </div>
                  <div>
                    <div className="comment-status-action">
                      <span>{text("改变状态为-等待认领", "Change status to Todo")}</span>
                      <button
                        type="button"
                        className={`board-setting-switch${changeStatusToTodo ? " is-on" : ""}`}
                        role="switch"
                        aria-checked={changeStatusToTodo}
                        disabled={submitting}
                        onClick={() => setChangeStatusToTodo((current) => !current)}
                      >
                        <span aria-hidden="true" />
                      </button>
                    </div>
                    <button
                      className="button primary"
                      type="submit"
                      disabled={(
                        !draft.trim()
                        && pendingCommentFiles.length === 0
                        && commentInlineImages.length === 0
                      ) || submitting}
                    >
                      {submitting ? text("发布中…", "Posting…") : text("评论", "Comment")}
                    </button>
                  </div>
                </footer>
              </form>
            </section>
          </div>

          <aside className="issue-properties" aria-label={text("议题属性", "Issue properties")}>
            <div className="detail-primary-actions">
              <button
                className="detail-open-thread-action"
                type="button"
                disabled={openingThread}
                onClick={() => onOpenInThread(currentTask)}
              >
                <ActorAvatar actor={CODEX_AGENT_ACTOR} className="detail-thread-avatar" />
                <span>{openingThread
                  ? text("正在打开…", "Opening…")
                  : text("在对话中打开", "Open in conversation")}</span>
              </button>
              {currentTask.externalUrl && (
                <a
                  className="detail-copy-action detail-external-action"
                  href={currentTask.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="detail-copy-action-icon" aria-hidden="true">
                    <LinearIcon name="openExternal" />
                  </span>
                  <span className="detail-copy-action-label">{text("打开 Jira", "Open Jira")}</span>
                </a>
              )}
              <button
                className="detail-copy-action"
                type="button"
                title={text(
                  `复制议题 ID ${displayIdentifier}`,
                  `Copy issue ID ${displayIdentifier}`,
                )}
                onClick={() => onCopy(
                  displayIdentifier,
                  text(`${displayIdentifier} 已复制。`, `${displayIdentifier} copied.`),
                )}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyIdIcon} alt="" /></span>
                <span className="detail-copy-action-label">{text("复制 ID", "Copy ID")}</span>
                <span className="detail-copy-identifier">{displayIdentifier}</span>
              </button>
              <button
                className="detail-copy-action"
                type="button"
                onClick={() => onCopy(
                  buildIssueUrl(
                    document.baseURI,
                    currentTask.projectId,
                    currentTask.identifier,
                  ).href,
                  text("议题链接已复制。", "Issue link copied."),
                )}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyLinkIcon} alt="" /></span>
                <span className="detail-copy-action-label">{text("复制链接", "Copy link")}</span>
              </button>
            </div>
            <h2>{text("属性", "Properties")}</h2>
            <div className="detail-property-row detail-status-row">
              <span className="detail-property-label">{text("状态", "Status")}</span>
              <TaskPropertyPicker
                value={currentTask.status}
                options={TASK_STATUSES.map((status) => ({
                  value: status,
                  label: taskStatusLabel(language, status),
                  icon: <StatusIcon status={status} />,
                  className: `status-icon-${STATUS_DETAILS[status].tone}`,
                }))}
                open={propertyMenu === "status"}
                disabled={savingProperty === "status"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("状态", "Status")}
                onOpenChange={(open) => setPropertyMenu(open ? "status" : null)}
                onChange={(status) => void saveTask({ status }, "status")}
              />
            </div>
            <div className="detail-property-row">
              <span className="detail-property-label">{text("优先级", "Priority")}</span>
              <TaskPropertyPicker
                value={currentTask.priority}
                options={TASK_PRIORITIES.map((priority) => ({
                  value: priority,
                  label: taskPriorityLabel(language, priority),
                  icon: <LinearPriorityIcon priority={priority} />,
                  className: `priority-${priority}`,
                }))}
                open={propertyMenu === "priority"}
                disabled={savingProperty === "priority"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("优先级", "Priority")}
                onOpenChange={(open) => setPropertyMenu(open ? "priority" : null)}
                onChange={(priority) => void saveTask({ priority }, "priority")}
              />
            </div>
            <div className="detail-property-row assignee-property">
              <span className="detail-property-label">{text("负责人", "Assignee")}</span>
              <TaskPropertyPicker
                value={actorKey(currentTask.assignee)}
                options={assigneeOptions.map((actor) => ({
                  value: actorKey(actor),
                  label: actor.id === currentUser.id
                    ? `${actor.name}${text("（我）", " (me)")}`
                    : actor.name,
                  icon: <ActorAvatar actor={actor} className="task-property-assignee-avatar" />,
                }))}
                open={propertyMenu === "assignee"}
                disabled={currentTask.source === "jira" || savingProperty === "assignee"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("负责人", "Assignee")}
                onOpenChange={(open) => setPropertyMenu(open ? "assignee" : null)}
                onChange={(value) => {
                  const selected = assigneeOptions.find((actor) => actorKey(actor) === value);
                  const assigneeTarget = selected
                    ? assigneeTargetForActor(selected, currentUser)
                    : undefined;
                  if (assigneeTarget) void saveTask({ assigneeTarget }, "assignee");
                }}
              />
            </div>
            <div className="detail-property-row labels-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="label" />
              </span>
              <span className="detail-property-label">{text("标签", "Labels")}</span>
              <LabelPicker
                availableLabels={availableLabels}
                selectedLabels={currentTask.labels}
                open={propertyMenu === "labels"}
                disabled={savingProperty === "labels"}
                className="detail-label-picker"
                triggerClassName="detail-label-trigger"
                showSelectedAsChips
                placeholder={text("添加标签…", "Add labels…")}
                onOpenChange={(open) => setPropertyMenu(open ? "labels" : null)}
                onChange={(nextLabels) => void saveTask({ labels: nextLabels }, "labels")}
                onCreateLabel={onCreateLabel}
                onDeleteLabel={currentTask.source === "jira" ? undefined : onDeleteLabel}
              />
            </div>
            <label className="detail-property-row development-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="branch" />
              </span>
              <span className="detail-property-label">{text("开发上下文", "Development context")}</span>
              <select
                value={contextValue(currentTask.developmentContext)}
                disabled={developmentScanLoading || savingProperty === "developmentContext"}
                title={currentTask.developmentContext?.type === "worktree" ? currentTask.developmentContext.path : undefined}
                onChange={(event) => void saveTask({
                  developmentContext: event.target.value ? JSON.parse(event.target.value) as DevelopmentContext : null,
                }, "developmentContext")}
              >
                <option value="">{developmentScanLoading
                  ? text("正在扫描 Git…", "Scanning Git…")
                  : text("未绑定", "Not linked")}</option>
                <optgroup label={text("代码分支", "Code branches")}>
                  {developmentOptions.filter((context) => context.type === "branch").map((context) => (
                    <option value={contextValue(context)} key={contextValue(context)}>{contextLabel(context, text)}</option>
                  ))}
                </optgroup>
                <optgroup label="Worktree">
                  {developmentOptions.filter((context) => context.type === "worktree").map((context) => (
                    <option value={contextValue(context)} key={contextValue(context)}>{contextLabel(context, text)}</option>
                  ))}
                </optgroup>
              </select>
            </label>
            <label className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="calendar" /></span>
              <span className="detail-property-label">{text("开始日期", "Start date")}</span>
              <input
                type="date"
                value={currentTask.startDate ?? ""}
                disabled={savingProperty === "startDate"}
                onChange={(event) => void saveTask({
                  startDate: event.target.value || null,
                }, "startDate")}
              />
            </label>
            <label className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="calendar" /></span>
              <span className="detail-property-label">{text("截止日期", "Due date")}</span>
              <input
                type="date"
                value={currentTask.dueDate ?? ""}
                disabled={savingProperty === "dueDate"}
                onChange={(event) => void saveTask({
                  dueDate: event.target.value || null,
                  ...(event.target.value ? {} : { recurrence: null }),
                }, "dueDate")}
              />
            </label>
            <label className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="recurrence" /></span>
              <span className="detail-property-label">{text("重复", "Recurrence")}</span>
              <select
                value={currentTask.recurrence?.unit ?? ""}
                disabled={savingProperty === "recurrence"}
                onChange={(event) => {
                  const unit = event.target.value as Recurrence["unit"] | "";
                  const changes: Partial<TaskDraft> = {
                    recurrence: unit ? { interval: 1, unit } : null,
                  };
                  if (unit && !currentTask.dueDate) {
                    const dueDate = new Date();
                    dueDate.setDate(dueDate.getDate() + 7);
                    changes.dueDate = new Date(dueDate.getTime() - dueDate.getTimezoneOffset() * 60_000)
                      .toISOString().slice(0, 10);
                  }
                  void saveTask(changes, "recurrence");
                }}
              >
                <option value="">{text("不重复", "Does not repeat")}</option>
                <option value="day">{text("每天", "Daily")}</option>
                <option value="week">{text("每周", "Weekly")}</option>
                <option value="month">{text("每月", "Monthly")}</option>
                <option value="year">{text("每年", "Yearly")}</option>
              </select>
            </label>
            <IssueRelationSidebar
              task={currentTask}
              tasks={tasks}
              onOpenTask={onOpenTask}
              onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onAddRelation(anchor, type, relatedTaskId),
              )}
              onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onRemoveRelation(anchor, type, relatedTaskId),
              )}
            />
            <div className="detail-timestamps">
              <span>{text(
                `创建于 ${exactTime(currentTask.createdAt, locale)}`,
                `Created ${exactTime(currentTask.createdAt, locale)}`,
              )}</span>
              {currentTask.updatedAt !== currentTask.createdAt && <span>{text(
                `更新于 ${exactTime(currentTask.updatedAt, locale)}`,
                `Updated ${exactTime(currentTask.updatedAt, locale)}`,
              )}</span>}
            </div>
          </aside>
        </div>
      </div>

      {pendingDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deleting) setPendingDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-comment-title">
            <h2 id="delete-comment-title">{text("删除这条评论？", "Delete this comment?")}</h2>
            <p>{text("此操作无法撤销。", "This action cannot be undone.")}</p>
            <div>
              <button className="button secondary" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>{text("取消", "Cancel")}</button>
              <button className="button danger" type="button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? text("删除中…", "Deleting…") : text("删除评论", "Delete comment")}</button>
            </div>
          </div>
        </div>
      )}

      {pendingAttachmentDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deletingAttachment) setPendingAttachmentDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-attachment-title">
            <h2 id="delete-attachment-title">{text("删除这个附件？", "Delete this attachment?")}</h2>
            <p>{text(
              `“${pendingAttachmentDelete.filename}” 将被永久删除，此操作无法撤销。`,
              `“${pendingAttachmentDelete.filename}” will be permanently deleted. This action cannot be undone.`,
            )}</p>
            <div>
              <button className="button secondary" type="button" disabled={deletingAttachment} onClick={() => setPendingAttachmentDelete(null)}>{text("取消", "Cancel")}</button>
              <button className="button danger" type="button" disabled={deletingAttachment} onClick={() => void confirmAttachmentDelete()}>{deletingAttachment ? text("删除中…", "Deleting…") : text("删除附件", "Delete attachment")}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
