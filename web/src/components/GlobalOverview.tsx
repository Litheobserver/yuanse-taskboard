import { useEffect, useMemo, useState } from "react";

import { listTasks } from "../api";
import type { Project, Task } from "../types";
import { useTaskboardI18n } from "../i18n";
import { TaskboardIcon } from "./TaskboardIcon";
import "./GlobalOverview.css";

interface ProjectSnapshot {
  project: Project;
  tasks: Task[];
}

interface GlobalOverviewProps {
  projects: Project[];
  onOpenProject: (projectId: string) => void;
  onOpenTask: (task: Task) => void;
}

const ACTIVE_STATUSES = new Set<Task["status"]>(["todo", "in_progress", "blocked", "in_review"]);

function isMusicProduction(project: Project) {
  return project.id === "music-production" || /专辑|音乐制作/.test(project.name);
}

function projectKind(project: Project) {
  if (isMusicProduction(project)) return "音乐制作";
  if (/巡演|演唱会|音乐节|live|tour/i.test(project.name)) return "演出项目";
  return project.source === "jira" ? "外部项目" : "一般项目";
}

function dateValue(value: string) {
  return new Date(`${value}T00:00:00`).getTime();
}

function globalTaskTitle(task: Task, project: Project) {
  if (!isMusicProduction(project)) return task.title;
  const sequence = task.identifier.match(/-(\d+)$/)?.[1];
  if (!sequence) return task.title;
  return `${sequence.padStart(2, "0")}.${task.title.replace(/^\d{1,3}\.\s*/, "")}`;
}

function stageLabel(task: Task, project: Project) {
  if (isMusicProduction(project)) {
    return {
      backlog: "尚未开始",
      todo: "编曲中",
      in_progress: "编曲确认",
      blocked: "录音中",
      in_review: "混音母带",
      done: "已完成",
      canceled: "暂停",
    }[task.status];
  }
  return {
    backlog: "待整理",
    todo: "待开始",
    in_progress: "进行中",
    blocked: "受阻",
    in_review: "待确认",
    done: "已完成",
    canceled: "暂停",
  }[task.status];
}

function projectStages(snapshot: ProjectSnapshot) {
  const count = (status: Task["status"]) => snapshot.tasks.filter((task) => task.status === status).length;
  if (isMusicProduction(snapshot.project)) {
    return [
      ["编曲", count("todo")],
      ["确认修改", count("in_progress")],
      ["录音", count("blocked")],
      ["后期", count("in_review")],
    ] as const;
  }
  return [
    ["待安排", count("backlog") + count("todo")],
    ["进行中", count("in_progress")],
    ["需关注", count("blocked")],
    ["待确认", count("in_review")],
  ] as const;
}

export function GlobalOverview({ projects, onOpenProject, onOpenTask }: GlobalOverviewProps) {
  const { locale } = useTaskboardI18n();
  const visibleProjects = useMemo(() => projects.filter((project) => project.id !== "local"), [projects]);
  const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      const results = await Promise.allSettled(visibleProjects.map(async (project) => ({
        project,
        tasks: await listTasks(project.id),
      })));
      if (disposed) return;
      const next = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      setSnapshots(next);
      setFailed(results.some((result) => result.status === "rejected"));
      setLoading(false);
      timer = setTimeout(load, 10_000);
    }
    void load();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [visibleProjects]);

  const allTasks = snapshots.flatMap((snapshot) => snapshot.tasks.map((task) => ({ task, project: snapshot.project })));
  const activeTasks = allTasks.filter(({ task }) => ACTIVE_STATUSES.has(task.status));
  const completedTasks = allTasks.filter(({ task }) => task.status === "done");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayValue = today.getTime();
  const attention = activeTasks.filter(({ task, project }) => (
    (task.dueDate && dateValue(task.dueDate) < todayValue)
    || task.priority === "urgent"
    || (!isMusicProduction(project) && task.status === "blocked")
  )).sort((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt));
  const upcoming = activeTasks.filter(({ task }) => (
    task.dueDate
    && dateValue(task.dueDate) >= todayValue
    && dateValue(task.dueDate) <= todayValue + 30 * 86_400_000
  )).sort((left, right) => (left.task.dueDate ?? "").localeCompare(right.task.dueDate ?? ""));
  const recent = [...activeTasks]
    .sort((left, right) => right.task.activityUpdatedAt.localeCompare(left.task.activityUpdatedAt))
    .slice(0, 8);
  const activeProjectCount = snapshots.filter((snapshot) => snapshot.tasks.some((task) => ACTIVE_STATUSES.has(task.status))).length;

  if (loading && snapshots.length === 0) {
    return <div className="global-overview global-overview-loading">正在汇总所有项目…</div>;
  }

  return (
    <div className="global-overview">
      <header className="global-overview-hero">
        <div>
          <span>跨项目总控</span>
          <h1>今天需要看什么</h1>
          <p>这里只汇总项目健康、风险和近期节点；具体制作流程留在各项目内部。</p>
        </div>
        {failed && <small>部分项目暂时未能刷新，将自动重试。</small>}
      </header>

      <section className="global-metrics" aria-label="全局状态">
        <article><span>进行中的项目</span><strong>{activeProjectCount}</strong><small>共 {snapshots.length} 个项目</small></article>
        <article><span>当前事项</span><strong>{activeTasks.length}</strong><small>跨全部项目</small></article>
        <article className={attention.length ? "is-alert" : ""}><span>需要关注</span><strong>{attention.length}</strong><small>逾期、紧急或受阻</small></article>
        <article><span>近期节点</span><strong>{upcoming.length}</strong><small>未来 30 天</small></article>
      </section>

      <section className="global-section">
        <div className="global-section-heading"><div><span>项目总览</span><h2>各项目使用自己的流程</h2></div></div>
        <div className="global-project-grid">
          {snapshots.map((snapshot) => {
            const completed = snapshot.tasks.filter((task) => task.status === "done").length;
            const scope = snapshot.tasks.filter((task) => task.status !== "canceled").length;
            const percent = scope ? Math.round(completed / scope * 100) : 0;
            return (
              <button className="global-project-card" type="button" onClick={() => onOpenProject(snapshot.project.id)} key={snapshot.project.id}>
                <div className="global-project-card-top">
                  <span className="global-project-icon"><TaskboardIcon name="projectFolder" /></span>
                  <div><small>{projectKind(snapshot.project)}</small><strong>{snapshot.project.name}</strong></div>
                  <b>{percent}%</b>
                </div>
                <div className="global-project-progress"><i style={{ width: `${percent}%` }} /></div>
                <div className="global-project-stages">
                  {projectStages(snapshot).map(([label, count]) => <span key={label}><small>{label}</small><strong>{count}</strong></span>)}
                </div>
              </button>
            );
          })}
          {snapshots.length === 0 && <div className="global-empty">还没有可汇总的项目。</div>}
        </div>
      </section>

      <div className="global-detail-grid">
        <section className="global-section global-focus-panel">
          <div className="global-section-heading"><div><span>风险与决策</span><h2>需要关注</h2></div><b>{attention.length}</b></div>
          <div className="global-item-list">
            {attention.slice(0, 6).map(({ task, project }) => (
              <button type="button" onClick={() => onOpenTask(task)} key={task.id}>
                <i className="is-alert" /><span><small>{project.name}</small><strong>{globalTaskTitle(task, project)}</strong></span><em>{task.dueDate && dateValue(task.dueDate) < todayValue ? "已逾期" : stageLabel(task, project)}</em>
              </button>
            ))}
            {attention.length === 0 && <div className="global-empty">目前没有需要立即处理的风险。</div>}
          </div>
        </section>

        <section className="global-section global-recent-panel">
          <div className="global-section-heading"><div><span>跨项目动态</span><h2>最近推进</h2></div><b>{recent.length}</b></div>
          <div className="global-item-list">
            {recent.map(({ task, project }) => (
              <button type="button" onClick={() => onOpenTask(task)} key={task.id}>
                <i /><span><small>{project.name}</small><strong>{globalTaskTitle(task, project)}</strong></span><em>{stageLabel(task, project)}</em>
              </button>
            ))}
            {recent.length === 0 && <div className="global-empty">暂无正在推进的事项。</div>}
          </div>
        </section>

        <section className="global-section global-upcoming-panel">
          <div className="global-section-heading"><div><span>未来 30 天</span><h2>近期节点</h2></div><b>{upcoming.length}</b></div>
          <div className="global-item-list">
            {upcoming.slice(0, 6).map(({ task, project }) => (
              <button type="button" onClick={() => onOpenTask(task)} key={task.id}>
                <i className="is-date" /><span><small>{project.name}</small><strong>{globalTaskTitle(task, project)}</strong></span><em>{new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(new Date(`${task.dueDate}T12:00:00`))}</em>
              </button>
            ))}
            {upcoming.length === 0 && <div className="global-empty">未来 30 天尚未登记明确节点。</div>}
          </div>
        </section>
      </div>

      <footer className="global-overview-footer">已完成事项 {completedTasks.length} 项 · 数据每 10 秒自动刷新</footer>
    </div>
  );
}
