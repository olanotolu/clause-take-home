import { closestCorners, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Num } from "../ui/Num.tsx";
import { CalendarDays, LayoutGrid, List, PlusCircle } from "../ui/icons.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { PRIORITIES, REQUEST_STATUSES, REQUEST_TYPES, type RequestStatus, type WorkRequest } from "../lib/api.ts";
import { applyFilters, byStatus, dueLabel, PRIORITY_LABEL, STATUS_LABEL, type Filters } from "../lib/requests.ts";
import { navigate, useRoute } from "../lib/router.ts";
import { ago } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { RequestPanel } from "../components/RequestPanel.tsx";
import { Button } from "../ui/Button.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Tabs, type TabDef } from "../ui/Tabs.tsx";
import { EmptyState, Skeleton } from "../ui/bits.tsx";

/** A lane's colour is a 6px dot, not an icon: enough to scan, quiet enough to ignore. */
const LANE_DOT: Record<RequestStatus, string> = { inbox: "bg-line-strong", in_progress: "bg-accent", needs_review: "bg-review", completed: "bg-pass" };
const select = "h-9 rounded-control border border-line-strong bg-paper px-3 text-sm";

/** Arrow keys move a picked-up card one column at a time (and a little vertically), so the board works without a pointer. */
const COLUMN_PITCH = 290;
const moveByColumn: KeyboardCoordinateGetter = (event, { currentCoordinates }) => {
  switch (event.code) {
    case "ArrowRight": return { ...currentCoordinates, x: currentCoordinates.x + COLUMN_PITCH };
    case "ArrowLeft": return { ...currentCoordinates, x: currentCoordinates.x - COLUMN_PITCH };
    case "ArrowDown": return { ...currentCoordinates, y: currentCoordinates.y + 60 };
    case "ArrowUp": return { ...currentCoordinates, y: currentCoordinates.y - 60 };
    default: return undefined;
  }
};

/** Screen-reader announcements for picking up and dropping a card, in the product's own words. */
const boardAnnouncements = (requests: WorkRequest[]) => {
  const title = (id: string | number) => requests.find((r) => r.id === id)?.title ?? "request";
  const col = (id: string | number | undefined) => (typeof id === "string" && id in STATUS_LABEL ? STATUS_LABEL[id as RequestStatus] : "its column");
  return {
    onDragStart: ({ active }: { active: { id: string | number } }) => `Picked up ${title(active.id)}. Arrow keys move it between columns, Space drops it, Escape cancels.`,
    onDragOver: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => (over ? `${title(active.id)} is over ${col(over.id)}.` : undefined),
    onDragEnd: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => (over ? `Moved ${title(active.id)} to ${col(over.id)}.` : `${title(active.id)} was dropped outside a column; nothing changed.`),
    onDragCancel: ({ active }: { active: { id: string | number } }) => `Cancelled. ${title(active.id)} stays where it was.`,
  };
};

/** What Clause CI last found, as one line of words with a dot: never colour alone, never a badge. */
function CiLine({ r }: { r: WorkRequest }) {
  if (!r.ci) return null;
  const { attention, goal, holding, total } = r.ci;
  const [dot, text, tone] =
    attention > 0 ? ["bg-fail", `${attention} ${attention === 1 ? "issue" : "issues"}`, "text-fail"]
    : goal && goal !== "PASS" && goal !== "UNAVAILABLE" ? ["bg-review", "Outcome not met", "text-review"]
    : total > 0 ? ["bg-pass", `${holding} of ${total} hold`, "text-pass"]
    : [null, null, ""];
  if (!dot || !text) return null;
  return <span className={cn("flex items-center gap-1.5 text-xs font-medium", tone)}><span className={cn("h-1.5 w-1.5 rounded-full", dot)} aria-hidden />{text}</span>;
}

const PRIORITY_TEXT = { high: "text-fail", medium: "text-review", low: "text-muted" } as const;
const CARD = "relative block w-full touch-manipulation rounded-[20px] bg-paper p-5 text-left shadow-soft";

function CardBody({ r }: { r: WorkRequest }) {
  const due = dueLabel(r.dueDate, r.status);
  return (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className={cn("flex items-center gap-1.5 text-[13px]", due?.overdue ? "font-medium text-fail" : "text-muted")}>
          <CalendarDays size={16} aria-hidden />
          {due ? due.text : "No due date"}
        </span>
        <span className={cn("rounded-full bg-paper px-2.5 py-0.5 text-xs font-medium shadow-soft", PRIORITY_TEXT[r.priority])}>{PRIORITY_LABEL[r.priority]}<span className="sr-only"> priority</span></span>
      </span>
      <span className="mt-3.5 block text-[18px] font-semibold leading-snug">{r.title}</span>
      <span className="mt-1.5 line-clamp-2 block text-[13.5px] leading-snug text-muted">{r.goal}</span>
      <span className="mt-4 flex items-center justify-between gap-3">
        <CiLine r={r} />
        <span className="ml-auto whitespace-nowrap rounded-full bg-paper px-2.5 py-1 text-xs font-medium text-muted shadow-soft">{r.type}</span>
      </span>
    </>
  );
}

function Card({ r, selected, onOpen }: { r: WorkRequest; selected: boolean; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: r.id });
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      aria-current={selected}
      className={cn(
        CARD,
        "cursor-grab transition-[box-shadow,opacity] duration-150 hover:shadow-[0_2px_10px_rgb(20_20_22/0.09),0_0_0_1px_rgb(20_20_22/0.05)] active:cursor-grabbing",
        selected && "ring-2 ring-accent",
        isDragging && "opacity-40",
      )}
    >
      <CardBody r={r} />
    </button>
  );
}

function Lane({ status, items, selectedId, onOpen, onAdd }: { status: RequestStatus; items: WorkRequest[]; selectedId: string | null; onOpen: (id: string) => void; onAdd: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [list] = useAutoAnimate<HTMLUListElement>({ duration: 180, easing: "ease-out" });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${STATUS_LABEL[status]}, ${items.length} request${items.length === 1 ? "" : "s"}`}
      className={cn("flex min-w-[260px] flex-col rounded-panel p-3 transition-colors duration-150", isOver ? "bg-accent-soft" : "bg-lane")}
    >
      <header className="flex h-9 items-center gap-2 px-2">
        <h3 className="text-[16px] font-semibold">{STATUS_LABEL[status]}</h3>
        <span className="tnum text-sm text-muted"><Num value={items.length} /></span>
      </header>
      <ul ref={list} className="mt-1 flex min-h-[40vh] flex-col gap-3">
        {items.map((r) => <li key={r.id}><Card r={r} selected={r.id === selectedId} onOpen={() => onOpen(r.id)} /></li>)}
      </ul>
      <button onClick={onAdd} className="mt-2 flex items-center gap-2 self-start rounded-[12px] px-2 py-2 text-sm text-muted transition-colors duration-100 hover:bg-ink/[0.05] hover:text-ink">
        <PlusCircle size={20} aria-hidden />
        Add request
      </button>
    </section>
  );
}

export function WorkspaceView() {
  const ws = useWorkspace();
  const route = useRoute();
  const selectedId = route.name === "home" ? (route.request ?? null) : null;
  const [view, setView] = useState<"board" | "list">("board");
  const [filters, setFilters] = useState<Filters>({ type: "all", priority: "all", scope: "all" });

  const shown = useMemo(() => applyFilters(ws.requests, filters), [ws.requests, filters]);
  const cols = useMemo(() => byStatus(shown), [shown]);
  const selected = ws.requests.find((r) => r.id === selectedId) ?? null;
  const open = (id: string) => navigate({ name: "home", request: id });
  const close = () => navigate({ name: "home" });
  const openCount = ws.requests.filter((r) => r.status !== "completed").length;

  // The panel keeps showing the last request while it slides shut, so closing is an animation, not a vanish.
  const last = useRef<WorkRequest | null>(null);
  if (selected) last.current = selected;
  const panelRequest = selected ?? last.current;
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => {
    if (!selected) return setPanelOpen(false);
    const id = setTimeout(() => setPanelOpen(true), 20); // a beat closed first, so the drawer has somewhere to slide from (a timer, not rAF: rAF pauses in background tabs)
    return () => clearTimeout(id);
  }, [!!selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // A drag only starts after 6px of movement, so a plain click still opens the request.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: moveByColumn }));
  const [dragging, setDragging] = useState<WorkRequest | null>(null);
  const onDragStart = (e: DragStartEvent) => setDragging(ws.requests.find((r) => r.id === e.active.id) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const target = e.over?.id;
    const r = ws.requests.find((x) => x.id === e.active.id);
    if (r && typeof target === "string" && (REQUEST_STATUSES as readonly string[]).includes(target) && r.status !== target) void ws.patchRequest(r.id, { status: target as RequestStatus });
  };
  const viewTabs: TabDef<"board" | "list">[] = [
    { id: "board", label: "Board", icon: (on) => <LayoutGrid size={18} weight={on ? "fill" : "regular"} aria-hidden /> },
    { id: "list", label: "List", icon: (on) => <List size={18} weight={on ? "fill" : "regular"} aria-hidden /> },
  ];

  return (
    <div className={cn("grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_0px] transition-[grid-template-columns] duration-300 ease-[var(--ease-out)] max-[1279px]:grid-cols-[minmax(0,1fr)]", selected && "min-[1280px]:grid-cols-[minmax(0,1fr)_400px]")}>
      <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto">
        <div className="px-8 pt-8 max-[640px]:px-4">
          <h1 className="font-display text-[28px] leading-tight">Workspace</h1>
          <p className="tnum mt-1 text-[14px] text-muted"><Num value={openCount} /> open · <Num value={ws.requests.length - openCount} /> completed</p>
          <div className="mt-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line">
            <Tabs tabs={viewTabs} value={view} onChange={setView} label="View" idPrefix="view" className="-ml-3" />
            <div className="flex flex-wrap items-center gap-2 pb-2.5">
              <Segmented value={filters.scope} onChange={(scope) => setFilters((f) => ({ ...f, scope }))} label="Show" options={[{ value: "all", label: "All" }, { value: "open", label: "Open" }, { value: "completed", label: "Completed" }]} />
              <select aria-label="Filter by type" value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value as Filters["type"] }))} className={select}>
                <option value="all">All types</option>{REQUEST_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
              <select aria-label="Filter by priority" value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value as Filters["priority"] }))} className={select}>
                <option value="all">All priorities</option>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div id="view-panel" role="tabpanel" aria-labelledby={`view-${view}`} className="min-h-0 flex-1 px-5 pb-8 pt-5 max-[640px]:px-3">
          {ws.requestsStatus.kind === "loading" && <div className="grid grid-cols-4 gap-3 max-[1100px]:grid-cols-2 max-[640px]:grid-cols-1" aria-busy="true" aria-label="Loading requests">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-72" />)}</div>}
          {ws.requestsStatus.kind === "error" && <p role="alert" className="rounded-control bg-fail-bg px-4 py-3 text-sm text-fail">{ws.requestsStatus.message}</p>}
          {ws.requestsStatus.kind === "ready" && ws.requests.length === 0 && (
            <EmptyState title="No requests yet" action={<Button variant="primary" onClick={() => ws.setNewRequest({ open: true })}>Create the first request</Button>}>
              A request is something someone wants done to a document. Clause CI checks the document against it.
            </EmptyState>
          )}
          {ws.requestsStatus.kind === "ready" && ws.requests.length > 0 && view === "board" && (
            <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)} accessibility={{ announcements: boardAnnouncements(ws.requests) }}>
              <div className="fade-up grid grid-cols-[repeat(4,minmax(260px,1fr))] gap-3 overflow-x-auto pb-2 max-[640px]:grid-cols-1">
                {REQUEST_STATUSES.map((s) => (
                  <Lane key={s} status={s} items={cols[s]} selectedId={selectedId} onOpen={open} onAdd={() => ws.setNewRequest({ open: true, status: s })} />
                ))}
              </div>
              <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }}>
                {dragging ? <div className={cn(CARD, "w-[260px] rotate-[1.5deg] cursor-grabbing shadow-lift")}><CardBody r={dragging} /></div> : null}
              </DragOverlay>
            </DndContext>
          )}
          {ws.requestsStatus.kind === "ready" && ws.requests.length > 0 && view === "list" && (
            <div className="fade-up overflow-x-auto rounded-card border border-line bg-paper">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-line text-xs text-muted"><tr><th scope="col" className="px-4 py-2.5 font-medium">Request</th><th scope="col" className="px-3 py-2.5 font-medium">Type</th><th scope="col" className="px-3 py-2.5 font-medium">Priority</th><th scope="col" className="px-3 py-2.5 font-medium">Status</th><th scope="col" className="px-3 py-2.5 font-medium">Due</th><th scope="col" className="px-4 py-2.5 font-medium">Updated</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {shown.map((r) => {
                    const due = dueLabel(r.dueDate, r.status);
                    return (
                      <tr key={r.id} onClick={() => open(r.id)} className={cn("cursor-pointer transition-colors duration-100 hover:bg-ink/[0.03]", r.id === selectedId && "bg-accent-soft")}>
                        <td className="px-4 py-3 font-medium">{r.title}{r.ci && r.ci.attention > 0 && <span className="ml-2 text-xs font-medium text-fail">{r.ci.attention} {r.ci.attention === 1 ? "issue" : "issues"}</span>}</td>
                        <td className="px-3 py-3 text-muted">{r.type}</td>
                        <td className={cn("px-3 py-3", r.priority === "high" ? "font-medium text-fail" : "text-muted")}>{PRIORITY_LABEL[r.priority]}</td>
                        <td className="px-3 py-3">{STATUS_LABEL[r.status]}</td>
                        <td className={cn("px-3 py-3", due?.overdue ? "font-medium text-fail" : "text-muted")}>{due?.text ?? "—"}</td>
                        <td className="tnum px-4 py-3 text-muted">{ago(r.updatedAt)}</td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-muted">No requests match these filters.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {ws.requestsStatus.kind === "ready" && ws.requests.length > 0 && shown.length === 0 && view === "board" && <p className="mt-3 text-sm text-muted">No requests match these filters.</p>}
        </div>
      </div>

      <div className="flex min-w-0 justify-end overflow-hidden max-[1279px]:contents">
        {panelRequest && <RequestPanel key={panelRequest.id} request={panelRequest} open={!!selected && panelOpen} onClose={close} />}
      </div>
      {selectedId && !selected && ws.requestsStatus.kind === "ready" && <p role="alert" className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-control bg-fail-bg px-4 py-2 text-sm text-fail">That request no longer exists. <button className="underline" onClick={close}>Back to the board</button></p>}
    </div>
  );
}
