/* 足迹 · 剧情线路板 */
const NODE_W = 210, NODE_H = 86, PLUS_R = 12;

const KIND_INFO = {
  beat: { label: "情节", help: "正常发生的一段剧情" },
  choice: { label: "分叉", help: "玩家在这里做选择，会走向不同后续" },
  gate: { label: "条件门", help: "要满足条件才继续（例如攻略开到某步）" },
  ending: { label: "结局", help: "这条线在这里结束" },
};

const state = {
  graph: null,
  selectedId: null,
  selectedEdgeId: null,
  camera: { x: 40, y: 40, scale: 0.85 },
  drag: null,
  connectFrom: null,
  plusMenu: null, // { nodeId, x, y } screen px
  linkModeFrom: null, // node id when choosing link target

  pan: null,
  dirty: false,
  show: { main: true, side: true }, // 显示过滤
};

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function nodeById(id) { return state.graph.nodes.find((n) => n.id === id); }
function charColor(id) {
  return state.graph.characters?.find((c) => c.id === id)?.color || null;
}
function charName(id) {
  return state.graph.characters?.find((c) => c.id === id)?.name || "";
}
function nodeColor(n) {
  if (n.character) return charColor(n.character) || "#8b949e";
  return n.track === "side" ? "#7ee787" : "#e6edf3";
}
function setDirty(v = true) {
  state.dirty = v;
  const el = $("dirty");
  el.textContent = v ? "未保存" : "已保存";
  el.style.color = v ? "#d29922" : "#3fb950";
}
function toast(msg, err = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast show" + (err ? " err" : "");
  setTimeout(() => el.classList.remove("show"), 2200);
}
function visible(n) {
  if (n.track === "main") return state.show.main;
  if (n.track === "side") return state.show.side;
  return true;
}

async function loadGraph() {
  const res = await fetch("/api/graph");
  if (!res.ok) throw new Error("加载失败");
  state.graph = await res.json();
  for (const n of state.graph.nodes) {
    n.prerequisites = n.prerequisites || [];
    n.position = n.position || { x: 0, y: 0 };
    if (n.track !== "main" && n.track !== "side") {
      // 兼容旧数据
      if (["linlan", "tangzhi", "xuning", "zhoulan"].includes(n.track)) {
        n.character = n.track;
        n.track = "side";
      } else n.track = "main";
    }
  }
  for (const e of state.graph.edges) {
    if (e.from == null && e.source) e.from = e.source;
    if (e.to == null && e.target) e.to = e.target;
  }
  if (!state.graph.characters) {
    state.graph.characters = [
      { id: "linlan", name: "林澜", color: "#6aa9ff" },
      { id: "tangzhi", name: "唐栀", color: "#ff8fab" },
      { id: "xuning", name: "许宁", color: "#c9a0ff" },
    ];
  }
  $("title").textContent = state.graph.title || "剧情线路板";
  $("meta").textContent = `${state.graph.chapter || ""} · ${state.graph.nodes.length} 个节点`;
  renderFilters();
  setDirty(false);
  draw();
  renderSidebar();
}

async function saveGraph({ quiet = false } = {}) {
  const res = await fetch("/api/graph", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.graph),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || "保存失败");
  state.graph.updatedAt = data.updatedAt;
  setDirty(false);
  toast(quiet ? "已自动保存" : "已保存");
}

/** 串行自动保存，避免连点新建时请求打架 */
let _saveChain = Promise.resolve();
function autosaveAfterNodeCreate() {
  _saveChain = _saveChain
    .then(() => saveGraph({ quiet: true }))
    .catch((e) => toast(String(e), true));
  return _saveChain;
}

function renderFilters() {
  const box = $("filters");
  box.innerHTML = `<span class="lab">显示：</span>`;
  for (const [key, name, color] of [
    ["main", "主线", "#e6edf3"],
    ["side", "支线", "#7ee787"],
  ]) {
    const span = document.createElement("span");
    span.className = "chip" + (state.show[key] ? "" : " off");
    span.innerHTML = `<i style="background:${color}"></i>${name}`;
    span.onclick = () => {
      state.show[key] = !state.show[key];
      renderFilters();
      draw();
    };
    box.appendChild(span);
  }
  const tip = document.createElement("span");
  tip.className = "lab";
  tip.textContent = "（只影响显示，不是选剧情）";
  box.appendChild(tip);
}

function resize() {
  const wrap = document.querySelector(".canvas-wrap");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, wrap.clientWidth) * dpr;
  canvas.height = Math.max(1, wrap.clientHeight) * dpr;
  canvas.style.width = wrap.clientWidth + "px";
  canvas.style.height = wrap.clientHeight + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function worldFromEvent(ev) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - r.left - state.camera.x) / state.camera.scale,
    y: (ev.clientY - r.top - state.camera.y) / state.camera.scale,
  };
}

function plusCenter(n) {
  return { x: n.position.x + NODE_W + 4 + PLUS_R, y: n.position.y + NODE_H / 2 };
}


function hidePlusMenu() {
  state.plusMenu = null;
  const el = document.getElementById("plus-menu");
  if (el) el.remove();
}

function showPlusMenu(node, clientX, clientY) {
  hidePlusMenu();
  state.plusMenu = { nodeId: node.id };
  const el = document.createElement("div");
  el.id = "plus-menu";
  el.className = "plus-menu";
  el.style.left = Math.min(clientX, window.innerWidth - 200) + "px";
  el.style.top = Math.min(clientY, window.innerHeight - 140) + "px";
  el.innerHTML = `
    <button data-act="new">新建节点（自动连过来）</button>
    <button data-act="link">创建连接关系（点已有节点）</button>
    <button data-act="cancel" class="muted">取消</button>`;
  el.addEventListener("mousedown", (e) => e.stopPropagation());
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const act = btn.dataset.act;
    const n = nodeById(state.plusMenu?.nodeId);
    hidePlusMenu();
    if (!n || act === "cancel") return;
    if (act === "new") {
      const nOut = outgoingEdges(n.id).length;
      addNextNode(n, { asChoice: nOut >= 1 });
      return;
    }
    if (act === "link") {
      state.linkModeFrom = n.id;
      state.connectFrom = n.id;
      canvas.classList.add("connecting");
      toast("连接模式：点击要汇入的目标节点；Esc 取消");
    }
  });
  document.body.appendChild(el);
}

function cancelLinkMode() {
  state.linkModeFrom = null;
  state.connectFrom = null;
  state.drag = null;
  canvas.classList.remove("connecting");
}

function ensureEdge(fromId, toId, label = "") {
  if (fromId === toId) return null;
  const id = `${fromId}__${toId}`;
  if (state.graph.edges.find((e) => e.id === id || (e.from === fromId && e.to === toId))) {
    toast("已有这条连接");
    return id;
  }
  state.graph.edges.push({
    id, from: fromId, to: toId, label, choiceId: null,
    createsSubRoute: false, subRouteId: null, flagsRequired: [],
  });
  // 目标节点补一条前置（若还没有）
  const to = nodeById(toId);
  if (to) {
    to.prerequisites = to.prerequisites || [];
    const has = to.prerequisites.some((p) => p.type === "node" && p.id === fromId);
    if (!has) to.prerequisites.push({ type: "node", id: fromId, op: "done" });
  }
  setDirty();
  return id;
}

function hitPlus(wx, wy) {
  for (let i = state.graph.nodes.length - 1; i >= 0; i--) {
    const n = state.graph.nodes[i];
    if (!visible(n)) continue;
    const p = plusCenter(n);
    if (Math.hypot(wx - p.x, wy - p.y) <= PLUS_R + 4) return n;
  }
  return null;
}

function hitNode(wx, wy) {
  for (let i = state.graph.nodes.length - 1; i >= 0; i--) {
    const n = state.graph.nodes[i];
    if (!visible(n)) continue;
    const { x, y } = n.position;
    if (wx >= x && wx <= x + NODE_W && wy >= y && wy <= y + NODE_H) return n;
  }
  return null;
}

function hitEdge(wx, wy) {
  for (const e of state.graph.edges) {
    const a = nodeById(e.from), b = nodeById(e.to);
    if (!a || !b || !visible(a) || !visible(b)) continue;
    const x1 = a.position.x + NODE_W, y1 = a.position.y + NODE_H / 2;
    const x2 = b.position.x, y2 = b.position.y + NODE_H / 2;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    if (Math.hypot(wx - mx, wy - my) < 18) return e;
  }
  return null;
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function trim(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function draw() {
  if (!state.graph) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(state.camera.x, state.camera.y);
  ctx.scale(state.camera.scale, state.camera.scale);

  for (const e of state.graph.edges) {
    const a = nodeById(e.from), b = nodeById(e.to);
    if (!a || !b || !visible(a) || !visible(b)) continue;
    const x1 = a.position.x + NODE_W, y1 = a.position.y + NODE_H / 2;
    const x2 = b.position.x, y2 = b.position.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    const selected = state.selectedEdgeId === e.id;
    const branch = !!e.createsSubRoute;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(mx, y1, mx, y2, x2, y2);
    ctx.strokeStyle = selected ? "#58a6ff" : branch ? "#ff8fab" : "#6e7681";
    ctx.lineWidth = selected ? 2.6 : branch ? 2.2 : 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 8, y2 - 4);
    ctx.lineTo(x2 - 8, y2 + 4);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    if (e.label) {
      ctx.fillStyle = "#c9d1d9";
      ctx.font = "11px sans-serif";
      ctx.fillText(e.label, mx - 24, (y1 + y2) / 2 - 6);
    }
  }

  if (state.drag?.kind === "connect" && state.connectFrom) {
    const a = nodeById(state.connectFrom);
    if (a) {
      ctx.beginPath();
      ctx.moveTo(a.position.x + NODE_W, a.position.y + NODE_H / 2);
      ctx.lineTo(state.drag.wx, state.drag.wy);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#58a6ff";
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  for (const n of state.graph.nodes) {
    if (!visible(n)) continue;
    const { x, y } = n.position;
    const selected = state.selectedId === n.id;
    const color = nodeColor(n);
    roundRect(x, y, NODE_W, NODE_H, 10);
    ctx.fillStyle = "#21262d";
    ctx.fill();
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.strokeStyle = selected ? "#58a6ff" : color;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(x, y + 8, 4, NODE_H - 16);

    ctx.fillStyle = "#e6edf3";
    ctx.font = "600 13px sans-serif";
    ctx.fillText(trim(n.title || n.id, 14), x + 14, y + 24);

    const kind = KIND_INFO[n.kind]?.label || n.kind;
    const track = n.track === "side" ? "支线" : "主线";
    const who = n.character ? " · " + charName(n.character) : "";
    ctx.fillStyle = "#8b949e";
    ctx.font = "11px sans-serif";
    ctx.fillText(`${kind} · ${track}${who}`, x + 14, y + 44);
    const pre = (n.prerequisites || []).length;
    ctx.fillText(pre ? `要先完成 ${pre} 项` : "无前置", x + 14, y + 64);

    // + button
    const p = plusCenter(n);
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLUS_R, 0, Math.PI * 2);
    ctx.fillStyle = "#1f6feb";
    ctx.fill();
    ctx.strokeStyle = "#79b8ff";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("+", p.x, p.y + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();
}

function outgoingEdges(nodeId) {
  return state.graph.edges.filter((e) => e.from === nodeId);
}

/** 给同一节点再接一条后续。已有出口时当作选项分支，上下错开摆。 */
function addNextNode(fromNode, opts = {}) {
  const outs = outgoingEdges(fromNode.id);
  const index = outs.length; // 0=第一条，1=第二条…
  const letters = "ABCDEFGH";

  let label = opts.label;
  let asChoice = opts.asChoice;
  if (asChoice == null) asChoice = index >= 1; // 第二条起默认当分支

  if (label == null) {
    if (asChoice || index >= 1) {
      const suggested = `选项${letters[index] || index + 1}`;
      const ans = prompt(
        `这是第 ${index + 1} 条后续。\n写玩家看到的选项原文（例如：先稳住她 / 追问细节）`,
        suggested
      );
      if (ans == null) return; // 取消
      label = ans.trim() || suggested;
      asChoice = true;
    } else {
      label = "继续";
    }
  }

  if (asChoice) {
    fromNode.kind = "choice"; // 有分叉的节点标成「分叉」
  }

  const id = `N-${Date.now().toString(36).toUpperCase()}${index}`;
  const baseX = fromNode.position.x + NODE_W + 90;
  const offsets = [0, 120, -120, 240, -240, 360, -360, 480, -480];
  let yOff = offsets[index] ?? (index % 2 === 0 ? index * 60 : -index * 60);
  // 若该位置已有节点，继续往下错开，避免再叠成一团
  const occupied = (x, y) => state.graph.nodes.some((m) =>
    Math.abs((m.position?.x ?? 0) - x) < 8 && Math.abs((m.position?.y ?? 0) - y) < 8);
  let tries = 0;
  while (occupied(baseX, fromNode.position.y + yOff) && tries < 20) {
    yOff += 120;
    tries += 1;
  }
  const node = {
    id,
    title: asChoice ? (label.length > 12 ? label.slice(0, 12) + "…" : label) : "新情节",
    kind: "beat",
    track: fromNode.track || "main",
    character: fromNode.character || null,
    summary: asChoice ? `由选项「${label}」进入` : "",
    prerequisites: [{ type: "node", id: fromNode.id, op: "done" }],
    scriptRef: "",
    flagsSet: [],
    notes: "",
    position: { x: baseX, y: fromNode.position.y + yOff },
  };

  state.graph.nodes.push(node);
  const eid = `${fromNode.id}__${id}`;
  state.graph.edges.push({
    id: eid,
    from: fromNode.id,
    to: id,
    label,
    choiceId: asChoice ? (letters[index] || String(index + 1)) : null,
    createsSubRoute: asChoice,
    subRouteId: asChoice ? `opt-${letters[index] || index}` : null,
    flagsRequired: [],
  });
  state.selectedId = id;
  state.selectedEdgeId = null;
  setDirty();
  draw();
  renderSidebar();
  toast(asChoice ? `已加选项分支「${label}」` : "已接上下一段");
  autosaveAfterNodeCreate();
}

function addChoiceBranch(fromNode) {
  addNextNode(fromNode, { asChoice: true });
}


function nodesStackedWith(n) {
  const px = n.position?.x ?? 0, py = n.position?.y ?? 0;
  return state.graph.nodes.filter((x) => {
    if (x.id === n.id) return true;
    const dx = Math.abs((x.position?.x ?? 0) - px);
    const dy = Math.abs((x.position?.y ?? 0) - py);
    return dx < 8 && dy < 8 && (x.title || "") === (n.title || "");
  });
}

function deleteNodeById(nid, { confirmAsk = true } = {}) {
  const n = nodeById(nid);
  if (!n) return false;
  const stack = nodesStackedWith(n);
  const ids = new Set(stack.map((x) => x.id));
  let msg = `删除「${n.title || nid}」及其连线？`;
  if (stack.length > 1) {
    msg = `这里叠了 ${stack.length} 个同名节点（位置几乎一样）。\n要一次全删掉吗？否则看起来会像「删不掉」。`;
  }
  if (confirmAsk && !confirm(msg)) return false;
  state.graph.nodes = state.graph.nodes.filter((x) => !ids.has(x.id));
  state.graph.edges = state.graph.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
  for (const m of state.graph.nodes) {
    m.prerequisites = (m.prerequisites || []).filter(
      (p) => !(p.type === "node" && ids.has(p.id))
    );
  }
  if (ids.has(state.selectedId)) state.selectedId = null;
  state.selectedEdgeId = null;
  setDirty();
  draw();
  renderSidebar();
  toast(stack.length > 1 ? `已删除叠在一起的 ${stack.length} 个节点` : "已删除");
  return true;
}

function deleteSelected({ confirmAsk = true } = {}) {
  if (state.selectedEdgeId) {
    const e = state.graph.edges.find((x) => x.id === state.selectedEdgeId);
    if (!e) return false;
    if (confirmAsk && !confirm("删除这条连线？")) return false;
    state.graph.edges = state.graph.edges.filter((x) => x.id !== e.id);
    state.selectedEdgeId = null;
    setDirty(); draw(); renderSidebar(); toast("连线已删");
    return true;
  }
  if (state.selectedId) return deleteNodeById(state.selectedId, { confirmAsk });
  return false;
}

function renderSidebar() {
  const box = $("sidebar-body");

  if (state.selectedEdgeId) {
    const e = state.graph.edges.find((x) => x.id === state.selectedEdgeId);
    if (!e) { box.innerHTML = `<div class="empty">未选中</div>`; return; }
    box.innerHTML = `
      <h2>这条连线</h2>
      <div class="field"><label>从 → 到</label><div>${esc(e.from)} → ${esc(e.to)}</div></div>
      <div class="field"><label>箭头上的字</label><input id="e-label" value="${esc(e.label || "")}" placeholder="比如：继续 / 答应 / 拒绝"></div>
      <div class="field"><label>选项代号（可空）</label><input id="e-choice" value="${esc(e.choiceId || "")}" placeholder="A / B / C"></div>
      <div class="field"><label><input type="checkbox" id="e-sub" ${e.createsSubRoute ? "checked" : ""}> 这是分叉（会走向另一条后续）</label></div>
      <div class="row">
        <button class="primary" id="btn-apply-edge">应用</button>
        <button class="danger" id="btn-del-edge">删除连线</button>
      </div>`;
    $("btn-apply-edge").onclick = () => {
      e.label = $("e-label").value.trim();
      e.choiceId = $("e-choice").value.trim() || null;
      e.createsSubRoute = $("e-sub").checked;
      setDirty(); draw(); toast("连线已更新");
    };
    $("btn-del-edge").onclick = () => {
      state.graph.edges = state.graph.edges.filter((x) => x.id !== e.id);
      state.selectedEdgeId = null; setDirty(); draw(); renderSidebar();
    };
    return;
  }

  const n = nodeById(state.selectedId);
  if (!n) {
    box.innerHTML = `
      <div class="empty">
        <b>怎么用</b><br>
        · 点节点：编辑这段剧情<br>
        · 点节点右边蓝色「＋」：接后续；再点一次就再加一条分支<br>
        · 同一节点可以有多条后续＝对话选项分叉<br>
        · 选中节点后点右上「删除这段」，或按键盘 Delete / Backspace<br>
        · 点连线中点：改箭头上的字<br>
        · 上方「显示」：只控制画布显不显示，不是在选剧情<br><br>
        <b>类型人话</b><br>
        · 情节：正常发生的一段<br>
        · 分叉：玩家要做选择<br>
        · 条件门：要满足条件才继续<br>
        · 结局：这条线到此结束<br><br>
        <b>路线</b>只分「主线 / 支线」。<br>
        林澜、唐栀等是「相关角色」标签，用来染色，不是路线名。
      </div>`;
    return;
  }

  const kinds = Object.entries(KIND_INFO).map(([k, v]) =>
    `<option value="${k}" ${k === n.kind ? "selected" : ""}>${v.label}</option>`).join("");
  const chars = `<option value="" ${!n.character ? "selected" : ""}>（无）</option>` +
    (state.graph.characters || []).map((c) =>
      `<option value="${c.id}" ${n.character === c.id ? "selected" : ""}>${c.name}</option>`).join("");
  const prereqs = (n.prerequisites || []).map((p, i) => {
    const label = p.type === "node" ? (nodeById(p.id)?.title || p.id) : `旗标 ${p.id}`;
    return `<div class="chip-inline">${esc(label)} <button data-i="${i}" class="rm-pre">×</button></div>`;
  }).join("") || `<div class="empty">无前置（随时可进）</div>`;

  const outs = outgoingEdges(n.id);
  const outList = outs.map((e) => {
    const to = nodeById(e.to);
    return `<div class="chip-inline">${esc(e.label || e.choiceId || "后续")} → ${esc(to?.title || e.to)}</div>`;
  }).join("") || `<div class="empty">还没有后续。点「＋」或「加选项分支」。</div>`;

  box.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <button class="primary" id="btn-apply-top">应用</button>
      <button class="danger" id="btn-del-top">删除这段</button>
    </div>
    <h2>这段剧情</h2>
    <div class="field"><label>标题</label><input id="n-title" value="${esc(n.title || "")}"></div>
    <div class="field"><label>内部编号</label><input id="n-id" value="${esc(n.id)}"></div>
    <div class="row">
      <div class="field">
        <label>类型</label>
        <select id="n-kind">${kinds}</select>
        <div class="help" id="kind-help">${esc(KIND_INFO[n.kind]?.help || "")}</div>
      </div>
      <div class="field">
        <label>路线</label>
        <select id="n-track">
          <option value="main" ${n.track === "main" ? "selected" : ""}>主线</option>
          <option value="side" ${n.track === "side" ? "selected" : ""}>支线</option>
        </select>
        <div class="help">只分主线 / 支线</div>
      </div>
    </div>
    <div class="field">
      <label>相关角色（可空，只用来染色）</label>
      <select id="n-char">${chars}</select>
    </div>
    <div class="field"><label>摘要</label><textarea id="n-summary">${esc(n.summary || "")}</textarea></div>
    <div class="field"><label>对应稿件</label><input id="n-script" value="${esc(n.scriptRef || "")}"></div>
    <div class="field"><label>备注</label><textarea id="n-notes">${esc(n.notes || "")}</textarea></div>
    <h2>要先完成什么</h2>
    <div id="prereq-list">${prereqs}</div>
    <div class="row">
      <select id="pre-node">${state.graph.nodes.filter((x) => x.id !== n.id).map((x) =>
        `<option value="${x.id}">${esc(x.title || x.id)}</option>`).join("")}</select>
      <button id="btn-add-pre">加前置</button>
    </div>
    <h2>从这里出去的后续</h2>
    <div id="out-list">${outList}</div>
    <div class="row">
      <button class="primary" id="btn-apply">应用</button>
      <button id="btn-add-next">＋ 接下一段</button>
      <button id="btn-add-choice">＋ 加选项分支</button>
      <button class="danger" id="btn-del">删除</button>
    </div>
    <div class="help">同一节点可加多条后续：每条对应玩家一个选项，点「加选项分支」或反复点节点右侧「＋」。</div>`;

  $("n-kind").onchange = () => {
    $("kind-help").textContent = KIND_INFO[$("n-kind").value]?.help || "";
  };
  $("btn-apply").onclick = () => {
    const nid = $("n-id").value.trim();
    if (!nid) return toast("编号不能空", true);
    if (nid !== n.id && nodeById(nid)) return toast("编号已存在", true);
    if (nid !== n.id) {
      for (const e of state.graph.edges) {
        if (e.from === n.id) e.from = nid;
        if (e.to === n.id) e.to = nid;
      }
      for (const m of state.graph.nodes) {
        for (const p of m.prerequisites || []) {
          if (p.type === "node" && p.id === n.id) p.id = nid;
        }
      }
      n.id = nid; state.selectedId = nid;
    }
    n.title = $("n-title").value.trim();
    n.kind = $("n-kind").value;
    n.track = $("n-track").value;
    n.character = $("n-char").value || null;
    n.summary = $("n-summary").value.trim();
    n.scriptRef = $("n-script").value.trim();
    n.notes = $("n-notes").value.trim();
    setDirty(); draw(); renderSidebar(); toast("已更新");
  };
  $("btn-add-pre").onclick = () => {
    n.prerequisites.push({ type: "node", id: $("pre-node").value, op: "done" });
    setDirty(); renderSidebar(); draw();
  };
  box.querySelectorAll(".rm-pre").forEach((btn) => {
    btn.onclick = () => {
      n.prerequisites.splice(+btn.dataset.i, 1);
      setDirty(); renderSidebar(); draw();
    };
  });
  $("btn-add-next").onclick = () => addNextNode(n);
  $("btn-add-choice").onclick = () => addChoiceBranch(n);
  const doApply = () => { $("btn-apply").click(); };
  $("btn-apply-top").onclick = doApply;
  $("btn-del").onclick = () => deleteNodeById(n.id);
  $("btn-del-top").onclick = () => deleteNodeById(n.id);
}

function addNode() {
  const id = `N-${Date.now().toString(36).toUpperCase()}`;
  state.graph.nodes.push({
    id, title: "新情节", kind: "beat", track: "main", character: null,
    summary: "", prerequisites: [], scriptRef: "", flagsSet: [], notes: "",
    position: {
      x: (220 - state.camera.x) / state.camera.scale,
      y: (140 - state.camera.y) / state.camera.scale,
    },
  });
  state.selectedId = id; state.selectedEdgeId = null;
  setDirty(); draw(); renderSidebar();
  autosaveAfterNodeCreate();
}

canvas.addEventListener("mousedown", (ev) => {
  const w = worldFromEvent(ev);
  if (ev.button === 0) {
    const plus = hitPlus(w.x, w.y);
    if (plus) {
      showPlusMenu(plus, ev.clientX, ev.clientY);
      return;
    }

    // 连接模式：点目标节点完成汇合边
    if (state.linkModeFrom) {
      const target = hitNode(w.x, w.y);
      if (target && target.id !== state.linkModeFrom) {
        const eid = ensureEdge(state.linkModeFrom, target.id, "汇合");
        cancelLinkMode();
        if (eid) {
          state.selectedEdgeId = eid; state.selectedId = null;
          toast("已连接到「" + (target.title || target.id) + "」");
          draw(); renderSidebar();
        }
        return;
      }
      // 点空白：保持模式，提示
      toast("再点一个节点完成连接，或按 Esc 取消", true);
      return;
    }

    if (ev.altKey) {
      const n = hitNode(w.x, w.y);
      if (n) {
        state.connectFrom = n.id;
        state.linkModeFrom = n.id;
        state.drag = { kind: "connect", wx: w.x, wy: w.y };
        canvas.classList.add("connecting");
        toast("拖到目标节点松手，或再点一次目标");
      }
      return;
    }
    hidePlusMenu();
    const n = hitNode(w.x, w.y);
    if (n) {
      state.selectedId = n.id; state.selectedEdgeId = null;
      state.drag = { kind: "node", id: n.id, ox: w.x - n.position.x, oy: w.y - n.position.y };
      renderSidebar(); draw(); return;
    }
    const e = hitEdge(w.x, w.y);
    if (e) {
      state.selectedEdgeId = e.id; state.selectedId = null;
      renderSidebar(); draw(); return;
    }
    state.selectedId = null; state.selectedEdgeId = null;
    state.pan = { x: ev.clientX, y: ev.clientY, cx: state.camera.x, cy: state.camera.y };
    canvas.classList.add("panning");
    renderSidebar(); draw();
  }
});

canvas.addEventListener("mousemove", (ev) => {
  const w = worldFromEvent(ev);
  if (state.drag?.kind === "node") {
    const n = nodeById(state.drag.id);
    n.position.x = w.x - state.drag.ox;
    n.position.y = w.y - state.drag.oy;
    setDirty(); draw();
  } else if (state.drag?.kind === "connect") {
    state.drag.wx = w.x; state.drag.wy = w.y; draw();
  } else if (state.pan) {
    state.camera.x = state.pan.cx + (ev.clientX - state.pan.x);
    state.camera.y = state.pan.cy + (ev.clientY - state.pan.y);
    draw();
  } else {
    canvas.style.cursor = hitPlus(w.x, w.y) ? "pointer" : "grab";
  }
});

canvas.addEventListener("mouseup", (ev) => {
  const w = worldFromEvent(ev);
  if (state.drag?.kind === "connect" && state.connectFrom) {
    const n = hitNode(w.x, w.y);
    if (n && n.id !== state.connectFrom) {
      const id = ensureEdge(state.connectFrom, n.id, "");
      if (id) state.selectedEdgeId = id; state.selectedId = null;
    }
  }
  state.drag = null; state.pan = null;
  // 若仍是点选连接模式，保持 linkModeFrom；拖拽松手后结束拖线预览
  if (!state.linkModeFrom) {
    state.connectFrom = null;
    canvas.classList.remove("connecting");
  } else {
    state.connectFrom = state.linkModeFrom;
    canvas.classList.add("connecting");
  }
  canvas.classList.remove("panning");
  draw(); renderSidebar();
});

canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const factor = ev.deltaY > 0 ? 0.9 : 1.1;
  const r = canvas.getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  const wx = (mx - state.camera.x) / state.camera.scale;
  const wy = (my - state.camera.y) / state.camera.scale;
  state.camera.scale = Math.min(2.2, Math.max(0.35, state.camera.scale * factor));
  state.camera.x = mx - wx * state.camera.scale;
  state.camera.y = my - wy * state.camera.scale;
  draw();
}, { passive: false });

$("btn-save").onclick = () => saveGraph().catch((e) => toast(String(e), true));
$("btn-reload").onclick = () => loadGraph().catch((e) => toast(String(e), true));
$("btn-add").onclick = addNode;
window.addEventListener("resize", resize);
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    hidePlusMenu();
    if (state.linkModeFrom) { cancelLinkMode(); toast("已取消连接"); draw(); }
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    saveGraph().catch((e) => toast(String(e), true));
    return;
  }
  const tag = (ev.target && ev.target.tagName) || "";
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ev.target?.isContentEditable;
  if (!typing && (ev.key === "Delete" || ev.key === "Backspace")) {
    if (state.selectedId || state.selectedEdgeId) {
      ev.preventDefault();
      deleteSelected();
    }
  }
});

loadGraph().then(resize).catch((e) => toast(String(e), true));
