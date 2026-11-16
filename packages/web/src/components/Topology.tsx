import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import dagre from "@dagrejs/dagre";
import { Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, getSmoothStepPath, useNodesState, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import type { NodeRecord, PermissionResponse, RunSnapshot } from "@baton/protocol";
import { pendingQuestion, representedQuestion } from "../lib/questions.js";
import { prSummary } from "../lib/pull-requests.js";
import { backgroundSummary } from "../lib/background.js";
import { agentColors, cost, displayStatus, duration, terminal, tokens } from "../lib/derive.js";
import type { HumanActions } from "./HumanActions.js";
import { RosterStrip } from "./Teams.js";
import { AgentMark, Icon, PermissionActions, Status, Toggle } from "./common.js";

interface GraphContextValue extends HumanActions { snapshot: RunSnapshot; now: number; decide: (id: string, response: PermissionResponse) => void; busy: boolean; reassign: (id: string) => void; inspect: (id: string) => void }
const GraphContext = createContext<GraphContextValue | null>(null);
type AgentNode = Node<{ node: NodeRecord }, "agent">;
const AgentCard = memo(function AgentCard({ data, selected }: NodeProps<AgentNode>) {
  const context = useContext(GraphContext)!;
  const { node } = data; const { snapshot, now } = context;
  const blocked = snapshot.delegations.find(edge => edge.toNodeId === node.id)?.blockedByProposal;
  const status = blocked ? "queued" : displayStatus(node, snapshot);
  const permissions = snapshot.permissions.filter(permission => permission.nodeId === node.id && permission.status === "pending" && !representedQuestion(permission, snapshot.questions));
  const questions = (snapshot.questions ?? []).filter(row => row.nodeId === node.id && pendingQuestion(row));
  const stalls = (snapshot.escalations ?? []).filter(row => row.nodeId === node.id && row.status === "pending" && row.kind === "stall");
  const background = backgroundSummary(snapshot, node.id);
  const prs = prSummary(snapshot, node.id);
  const children = snapshot.delegations.filter(edge => edge.fromNodeId === node.id);
  const tool = snapshot.toolSpans.findLast(span => span.nodeId === node.id && span.status === "running");
  return <div className={`node-card node-${node.status} ${selected ? "selected" : ""} ${permissions.length ? "needs-permission" : ""} ${questions.length ? "needs-answer" : ""} ${stalls.length ? "node-stalled" : ""}`}>
    <Handle type="target" position={Position.Top} />
    <div className="node-card-top"><AgentMark agent={node.agentId} small /><span className="node-agent">{node.agentId}</span><Status status={status} /></div>
    <div className="node-role-row">{snapshot.run.status === "paused" && !terminal(node.status) && <span className="node-paused"><Icon name="pause" size={11} />已暂停</span>}{background.count > 0 && <span className={`node-background-badge${background.hasPorts ? " has-ports" : ""}`} title="此节点启动的后台进程">后台 {background.count}</span>}{prs.entries.length > 0 && <span className={`node-pr-badge pr-tone-${prs.tone}`} title={`${prs.entries.length} 个关联 PR，${prs.count} 个 open / draft`}>⑂ PR {prs.entries.length}</span>}{node.role && <span className="role-badge">{node.role}</span>}{node.delegationId && !["canceled", "replaced"].includes(node.status) && !blocked && snapshot.run.policy.mode !== "solo" && <button className="text-button nodrag nopan" disabled={context.busy} onClick={event => { event.stopPropagation(); context.reassign(node.delegationId!); }}>改派 ↗</button>}</div><div className="node-title">{node.title}</div>
    <div className="node-model">{node.model ?? "默认模型"}</div>
    <div className={`node-activity ${terminal(node.status) ? "muted" : ""}`}><span className={`activity-indicator ${snapshot.run.status !== "paused" && node.status === "running" ? "live" : ""}`} />{tool?.summary ?? node.activity ?? "等待活动"}</div>
    <div className="node-metrics"><span>{duration(node.createdAt, node.endedAt ?? now)}</span><span>{tokens(node.usage.inputTokens + node.usage.outputTokens)} tokens</span><span>{cost(node.usage.costUsd)}</span>{children.length > 0 && <span title="子委派">⑂ {children.length}</span>}</div>
    {permissions.length > 0 && <div className="node-permission"><span>⚑ {permissions[0]!.request.title ?? "需要授权"}</span><PermissionActions permission={permissions[0]!} decide={context.decide} busy={context.busy} /></div>}
    {questions[0] && <div className="node-human nodrag nopan" onClick={event => event.stopPropagation()}><strong>等你回答</strong><p title={questions[0].question}>{questions[0].question}</p><div><button className="text-button" onClick={() => context.inspect(node.id)}>回答 ↗</button></div></div>}
    {stalls[0] && <div className="node-human node-stall-actions nodrag nopan" onClick={event => event.stopPropagation()}><strong>停滞</strong><p title={stalls[0].detail}>{stalls[0].detail}</p><div><button className="button small" disabled={context.busy} onClick={() => context.resolve(stalls[0]!.id, { resolution: "dismiss" })}>忽略</button><button className="button small danger" disabled={context.busy} onClick={() => context.resolve(stalls[0]!.id, { resolution: "cancel" })}>取消委派</button></div></div>}
    <Handle type="source" position={Position.Bottom} />
  </div>;
});

function DelegationEdge(props: EdgeProps) {
  const [path, x, y] = getSmoothStepPath({ ...props, borderRadius: 16 });
  return <><BaseEdge path={path} style={props.style} markerEnd={props.markerEnd} /><EdgeLabelRenderer><div className={`delegation-label nodrag nopan edge-${String(props.data?.status ?? "running")}`} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>{props.label}</div></EdgeLabelRenderer></>;
}
const nodeTypes = { agent: AgentCard };
const edgeTypes = { delegation: DelegationEdge };
const fitOptions = { padding: 0.08, minZoom: 0.45, maxZoom: 1.1, duration: 300 };

export function graphPositions(snapshot: Pick<RunSnapshot, "nodes" | "delegations">): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 95, marginx: 30, marginy: 30 });
  snapshot.nodes.forEach(node => graph.setNode(node.id, { width: 286, height: 240 }));
  snapshot.delegations.forEach(edge => { if (graph.hasNode(edge.fromNodeId) && graph.hasNode(edge.toNodeId)) graph.setEdge(edge.fromNodeId, edge.toNodeId); });
  dagre.layout(graph);
  return new Map(snapshot.nodes.map(node => { const point = graph.node(node.id); return [node.id, { x: point.x - 143, y: point.y - 120 }]; }));
}

/** Reserved node IDs in queued delegations are not ReactFlow endpoints yet. */
export function graphEdges(snapshot: Pick<RunSnapshot, "nodes" | "delegations"> & { run?: RunSnapshot["run"] }): Edge[] {
  const nodeIds = new Set(snapshot.nodes.map(node => node.id));
  const delegations: Edge[] = snapshot.delegations.filter(edge => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)).map(edge => ({
    id: edge.id, type: "delegation", source: edge.fromNodeId, target: edge.toNodeId,
    data: { status: edge.status }, label: `${edge.result ? edge.result.status === "success" ? "✓ " : edge.result.status === "partial" ? "◐ " : "✗ " : ""}${edge.brief.title}`,
    animated: edge.status === "running" && snapshot.run?.status !== "paused", style: { stroke: edge.status === "failed" ? "var(--red)" : edge.status === "completed" ? "var(--green)" : "var(--edge)", strokeWidth: 1.5, ...(edge.status === "replaced" ? { strokeDasharray: "5 5", opacity: .55 } : {}) },
  }));
  const replacements: Edge[] = snapshot.delegations.flatMap(edge => {
    const successor = snapshot.delegations.find(next => next.id === edge.replacedBy || next.replaces === edge.id);
    return successor && nodeIds.has(edge.toNodeId) && nodeIds.has(successor.toNodeId) ? [{
      id: `replacement-${edge.id}`, type: "smoothstep", source: edge.toNodeId, target: successor.toNodeId, label: "接手",
      style: { stroke: "var(--text-dim)", strokeDasharray: "5 5", strokeWidth: 1.5 }, labelStyle: { fill: "var(--text-dim)", fontSize: 11 }, labelBgStyle: { fill: "var(--surface)" },
    }] : [];
  });
  return [...delegations, ...replacements];
}

function GraphView({ snapshot, selected, inspect, openTeam }: { snapshot: RunSnapshot; selected: string | null; inspect: (id: string) => void; openTeam: () => void }) {
  const canvas = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [showMap, setShowMap] = useState(false);
  const [follow, setFollow] = useState(true);
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>([]);
  const { fitView } = useReactFlow();
  const structure = `${snapshot.nodes.map(node => node.id).join("|")}::${snapshot.delegations.map(edge => `${edge.fromNodeId}>${edge.toNodeId}`).join("|")}`;
  const previousStructure = useRef("");
  const fitFrame = useRef(0);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  useEffect(() => {
    const changed = previousStructure.current !== structure;
    if (changed) { positions.current = graphPositions(snapshot); previousStructure.current = structure; }
    setNodes(existing => snapshot.nodes.map(node => ({ id: node.id, type: "agent", data: { node }, position: changed ? positions.current.get(node.id)! : existing.find(entry => entry.id === node.id)?.position ?? positions.current.get(node.id)!, selected: node.id === selected })));
    if (changed && follow) fitFrame.current = requestAnimationFrame(() => { void fitView(fitOptions); });
  }, [snapshot, selected, structure, follow, setNodes, fitView]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => { setCanvasWidth(entries[0]?.contentRect.width ?? 0); });
    if (canvas.current) observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!canvasWidth) return;
    const timer = setTimeout(() => { fitFrame.current = requestAnimationFrame(() => { void fitView(fitOptions); }); }, 100);
    return () => clearTimeout(timer);
  }, [canvasWidth, fitView]);
  useEffect(() => () => cancelAnimationFrame(fitFrame.current), []);
  const edges = useMemo(() => graphEdges(snapshot), [snapshot.nodes, snapshot.delegations, snapshot.run.status]);
  return <div className="topology-view" ref={canvas}><RosterStrip snapshot={snapshot} open={openTeam} /><div className="view-toolbar"><span className="eyebrow">DELEGATION MAP</span><div className="toolbar-actions"><Toggle checked={follow} onChange={setFollow} label="跟随最新" /><Toggle checked={showMap} onChange={setShowMap} label="小地图" /><button className="button small" onClick={() => { void fitView(fitOptions); }}>适应画布</button></div></div>
    <ReactFlow<AgentNode> nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodeClick={(_, node) => inspect(node.id)} fitView fitViewOptions={fitOptions} minZoom={0.3} maxZoom={1.8} proOptions={{ hideAttribution: true }} defaultEdgeOptions={{ type: "delegation" }}>
      <Background gap={22} size={1} color="var(--grid)" />
      <Controls showInteractive={false} fitViewOptions={fitOptions} />
      {showMap && canvasWidth >= 900 && !selected && <MiniMap nodeColor={node => agentColors[snapshot.nodes.find(entry => entry.id === node.id)?.agentId ?? ""] ?? "#758799"} maskColor="var(--minimap-mask)" pannable zoomable />}
    </ReactFlow>
    <div className="graph-legend"><span><i style={{ background: "var(--green)" }} />结果已送达</span><span><i style={{ background: "var(--amber)" }} />等待授权</span><span><i style={{ background: "var(--red)" }} />执行失败</span><span className="muted">点击节点查看详情</span></div>
  </div>;
}

export function Topology(props: { snapshot: RunSnapshot; selected: string | null; now: number; inspect: (id: string) => void; decide: (id: string, response: PermissionResponse) => void; busy: boolean; reassign: (id: string) => void; openTeam: () => void } & HumanActions) {
  return <GraphContext.Provider value={props}><ReactFlowProvider><GraphView {...props} /></ReactFlowProvider></GraphContext.Provider>;
}
