import { closestCorners, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import NumberFlow from "@number-flow/react";
import { AlertTriangle, CalendarDays, CheckCircle2, Inbox, LayoutGrid, List, Loader, Plus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { PRIORITIES, REQUEST_STATUSES, REQUEST_TYPES, type RequestStatus, type WorkRequest } from "../lib/api.ts";
import { applyFilters, byStatus, dueLabel, PRIORITY_LABEL, STATUS_LABEL, type Filters } from "../lib/requests.ts";
import { navigate, useRoute } from "../lib/router.ts";
import { ago } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { RequestPanel } from "../components/RequestPanel.tsx";
import { Button } from "../ui/Button.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { EmptyState, Skeleton, StatusPill } from "../ui/bits.tsx";

const COLUMN_ICON: Record<RequestStatus, ReactNode> = {
  inbox: <Inbox size={16} aria-hidden />,
  in_progress: <Loader size={16} aria-hidden />,
  needs_review: <AlertTriangle size={16} className="text-review" aria-hidden />,
  completed: <CheckCircle2 size={16} className="text-pass" aria-hidden />,
};
const PRIORITY_DOT = { high: "bg-fail", medium: "bg-review", low: "bg-line-strong" } as const;
const select = "h-9 rounded-control border border-line-strong bg-paper px-2.5 text-sm";

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

function CardBody({ r }: { r: WorkRequest }) {
  const due = dueLabel(r.dueDate, r.status);
  return (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className="font-display text-[15px] font-semibold leading-snug">{r.title}</span>
        <span className="mt-1.5 flex shrink-0 items-center gap-1 text-xs text-muted" title={`${PRIORITY_LABEL[r.priority]} priority`}>
          <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[r.priority]}`} aria-hidden />
          <span className="sr-only">{PRIORITY_LABEL[r.priority]} priority</span>
        </span>
      </span>
      <span className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted">{r.goal}</span>
      <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className="rounded-md bg-line/60 px-1.5 py-0.5 text-xs font-medium text-muted">{r.type}</span>
        {r.priority === "high" && <span className="rounded-md bg-fail-bg px-1.5 py-0.5 text-xs font-medium text-fail">High</span>}
        {r.ci && (r.ci.attention > 0 ? <StatusPill tone="fail">{r.ci.attention} {r.ci.attention === 1 ? "issue" : "issues"}</StatusPill> : r.ci.goal && r.ci.goal !== "PASS" && r.ci.goal !== "UNAVAILABLE" ? <StatusPill tone="review">Outcome not met</StatusPill> : r.ci.total > 0 ? <StatusPill tone="pass">{r.ci.holding}/{r.ci.total} hold</StatusPill> : null)}
      </span>
      <span className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
        {due ? <span className={`flex items-center gap-1 ${due.overdue ? "font-semibold text-fail" : ""}`}><CalendarDays size={12} aria-hidden />{due.text}</span> : <span />}
        <span className="tnum">{ago(r.updatedAt)}</span>
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
        "block w-full cursor-grab touch-manipulation rounded-card border bg-paper p-3.5 text-left transition-[border-color,opacity] duration-100 active:cursor-grabbing",
        selected ? "border-accent" : "border-line hover:border-line-strong",
        isDragging && "opacity-40",
      )}
    >
      <CardBody r={r} />
    </button>
  );
}

function Column({ status, items, selectedId, onOpen, onAdd }: { status: RequestStatus; items: WorkRequest[]; selectedId: string | null; onOpen: (id: string) => void; onAdd: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [list] = useAutoAnimate<HTMLUListElement>({ duration: 180, easing: "ease-out" });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${STATUS_LABEL[status]}, ${items.length} request${items.length === 1 ? "" : "s"}`}
      className={cn("flex min-h-[200px] min-w-[260px] flex-col rounded-card border p-2 transition-colors duration-100", isOver ? "border-accent bg-accent-soft" : "border-line bg-ink/[0.025]")}
    >
      <header className="flex items-center gap-2 px-1.5 pb-2 pt-1">
        {COLUMN_ICON[status]}
        <h3 className="text-sm font-medium">{STATUS_LABEL[status]}</h3>
        <span className="tnum rounded-full bg-ink/[0.07] px-1.5 text-xs font-medium text-muted"><NumberFlow value={items.length} /></span>
        <button onClick={onAdd} aria-label={`Add a request to ${STATUS_LABEL[status]}`} className="ml-auto rounded-md p-1 text-muted transition-colors duration-100 hover:bg-ink/[0.07] hover:text-ink"><Plus size={15} aria-hidden /></button>
      </header>
      <ul ref={list} className="flex min-h-0 flex-1 flex-col gap-2">
        {items.map((r) => <li key={r.id}><Card r={r} selected={r.id === selectedId} onOpen={() => onOpen(r.id)} /></li>)}
        {items.length === 0 && <li className="px-2 py-6 text-center text-xs text-muted">Nothing here. Drag a request in, or add one.</li>}
      </ul>
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
  const scopes: { id: Filters["scope"]; label: string; n: number }[] = [
    { id: "all", label: "All requests", n: ws.requests.length },
    { id: "open", label: "Open", n: openCount },
    { id: "completed", label: "Completed", n: ws.requests.length - openCount },
  ];

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] min-[1280px]:data-[panel=true]:grid-cols-[minmax(0,1fr)_400px]" data-panel={selected ? "true" : "false"}>
      <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto bg-canvas">
        <div className="px-8 pb-2 pt-7 max-[640px]:px-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="font-display text-3xl font-semibold">Legal workspace</h1>
              <p className="mt-1 text-sm text-muted">Track each piece of legal work, and let Clause CI check the document against what was asked.</p>
            </div>
            <Button variant="primary" icon={<Plus size={16} aria-hidden />} onClick={() => ws.setNewRequest({ open: true })}>New request</Button>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line">
            <div role="tablist" aria-label="Request scope" className="flex gap-1">
              {scopes.map((s) => (
                <button key={s.id} role="tab" aria-selected={filters.scope === s.id} onClick={() => setFilters((f) => ({ ...f, scope: s.id }))} className={`relative h-10 px-2.5 text-sm font-medium after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full ${filters.scope === s.id ? "text-ink after:bg-accent" : "text-muted after:bg-transparent hover:text-ink"}`}>
                  {s.label} <span className="tnum text-xs text-muted">{s.n}</span>
                </button>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2 pb-2">
              <select aria-label="Filter by type" value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value as Filters["type"] }))} className={select}>
                <option value="all">All types</option>{REQUEST_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
              <select aria-label="Filter by priority" value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value as Filters["priority"] }))} className={select}>
                <option value="all">All priorities</option>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
              <Segmented value={view} onChange={setView} label="View" options={[{ value: "board", label: <><LayoutGrid size={14} aria-hidden />Board</> }, { value: "list", label: <><List size={14} aria-hidden />List</> }]} />
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 px-8 pb-8 pt-4 max-[640px]:px-4">
          {ws.requestsStatus.kind === "loading" && <div className="grid grid-cols-4 gap-3 max-[1100px]:grid-cols-2 max-[640px]:grid-cols-1" aria-busy="true" aria-label="Loading requests">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-72" />)}</div>}
          {ws.requestsStatus.kind === "error" && <p role="alert" className="rounded-control bg-fail-bg px-4 py-3 text-sm text-fail">{ws.requestsStatus.message}</p>}
          {ws.requestsStatus.kind === "ready" && ws.requests.length === 0 && (
            <div className="rounded-card border border-dashed border-line-strong bg-paper">
              <EmptyState icon={<Inbox size={26} aria-hidden />} title="No requests yet" action={<Button variant="primary" onClick={() => ws.setNewRequest({ open: true })}>Create the first request</Button>}>
                A request says what someone wants done to a document. Clause CI then checks the document against it.
              </EmptyState>
            </div>
          )}
          {ws.requestsStatus.kind === "ready" && ws.requests.length > 0 && view === "board" && (
            <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)} accessibility={{ announcements: boardAnnouncements(ws.requests) }}>
              <div className="grid grid-cols-[repeat(4,minmax(260px,1fr))] gap-3 overflow-x-auto pb-2 max-[640px]:grid-cols-1">
                {REQUEST_STATUSES.map((s) => (
                  <Column key={s} status={s} items={cols[s]} selectedId={selectedId} onOpen={open} onAdd={() => ws.setNewRequest({ open: true, status: s })} />
                ))}
              </div>
              <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }}>
                {dragging ? <div className="w-[260px] rotate-1 cursor-grabbing rounded-card border border-line-strong bg-paper p-3.5 text-left shadow-lift"><CardBody r={dragging} /></div> : null}
              </DragOverlay>
            </DndContext>
          )}
          {ws.requestsStatus.kind === "ready" && ws.requests.length > 0 && view === "list" && (
            <div className="overflow-x-auto rounded-card border border-line bg-paper">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-line text-xs text-muted"><tr><th scope="col" className="px-4 py-2.5 font-medium">Request</th><th scope="col" className="px-3 py-2.5 font-medium">Type</th><th scope="col" className="px-3 py-2.5 font-medium">Priority</th><th scope="col" className="px-3 py-2.5 font-medium">Status</th><th scope="col" className="px-3 py-2.5 font-medium">Due</th><th scope="col" className="px-4 py-2.5 font-medium">Updated</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {shown.map((r) => {
                    const due = dueLabel(r.dueDate, r.status);
                    return (
                      <tr key={r.id} onClick={() => open(r.id)} className={`cursor-pointer hover:bg-canvas ${r.id === selectedId ? "bg-accent-soft" : ""}`}>
                        <td className="px-4 py-3"><span className="font-display text-[15px] font-semibold">{r.title}</span>{r.ci && r.ci.attention > 0 && <span className="ml-2"><StatusPill tone="fail">{r.ci.attention} {r.ci.attention === 1 ? "issue" : "issues"}</StatusPill></span>}</td>
                        <td className="px-3 py-3 text-muted">{r.type}</td>
                        <td className="px-3 py-3"><span className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[r.priority]}`} aria-hidden />{PRIORITY_LABEL[r.priority]}</span></td>
                        <td className="px-3 py-3">{STATUS_LABEL[r.status]}</td>
                        <td className={`px-3 py-3 ${due?.overdue ? "font-semibold text-fail" : "text-muted"}`}>{due?.text ?? "—"}</td>
                        <td className="tnum px-4 py-3 text-muted">{ago(r.updatedAt)}</td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted">No requests match these filters.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {ws.requestsStatus.kind === "ready" && ws.requests.length > 0 && shown.length === 0 && view === "board" && <p className="mt-3 text-sm text-muted">No requests match these filters.</p>}
        </div>
      </div>
      {selected && <RequestPanel key={selected.id} request={selected} onClose={close} />}
      {selectedId && !selected && ws.requestsStatus.kind === "ready" && <p role="alert" className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-control bg-fail-bg px-4 py-2 text-sm text-fail">That request no longer exists. <button className="underline" onClick={close}>Back to the board</button></p>}
    </div>
  );
}
