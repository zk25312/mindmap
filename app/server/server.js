/**
 * 思维导图 (MindMap) 后端服务
 * 零依赖纯原生 Node.js 实现
 * 负责数据持久化存储、多格式解析导入（含 Summary 总结分支、Labels 注解标签）与多设备协同共享
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const importer = require("./importer.js");

const PORT = process.env.PORT || 5002;
const SOCKET_PATH = process.env.SOCKET_PATH || "";
const GATEWAY_PREFIX = process.env.GATEWAY_PREFIX || "/app/mindmap";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "mindmaps-store.json");
const STATIC_DIR = process.env.FRONTEND_DIST || path.join(__dirname, "public");

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- 导图唯一名称生成器（杜绝重名） ---------- */
function getUniqueTitle(store, baseTitle, excludeId = null) {
  const cleanTitle = String(baseTitle === undefined || baseTitle === null ? "" : baseTitle).trim() || "新思维导图";
  const existingTitles = new Set(
    ((store && store.maps) || [])
      .filter(m => m && m.id !== excludeId)
      .map(m => String(m.title || "").trim().toLowerCase())
  );
  if (!existingTitles.has(cleanTitle.toLowerCase())) return cleanTitle;
  let index = 1;
  while (existingTitles.has((cleanTitle + " (" + index + ")").toLowerCase())) index++;
  return cleanTitle + " (" + index + ")";
}
/* ---------- 初始默认导图模版 (纯净空白思维导图) ---------- */
function createDefaultStore() {
  const now = new Date().toISOString();
  return {
    version: 7,
    currentId: "map-default",
    maps: [
      {
        id: "map-default",
        title: "新思维导图",
        theme: "emerald", // 墨绿与薄荷绿胶囊主题
        layout: "right",   // 经典逻辑图 (无转角平直连线)
        freeRoots: [],
        createdAt: now,
        updatedAt: now,
        root: {
          id: "root-1",
          text: "中心主题",
          children: [
            { id: "node-1", text: "分支主题 1", children: [] },
            { id: "node-2", text: "分支主题 2", children: [] },
            { id: "node-3", text: "分支主题 3", children: [] }
          ]
        }
      }
    ]
  };
}
/* ---------- 数据读写（原子写入保护机制） ---------- */
function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.maps) && d.maps.length > 0) {
        return d;
      }
    }
  } catch (err) {
    console.error("读取导图存储失败，将重新初始化:", err);
  }
  const initial = createDefaultStore();
  saveStore(initial);
  return initial;
}

function saveStore(data) {
  const tmpFile = DATA_FILE + ".tmp." + Date.now();
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpFile, DATA_FILE);
}

/* ---------- HTTP 请求分发引擎 ---------- */
function requestHandler(req, res) {
  let reqUrl = req.url;
  if (reqUrl.startsWith(GATEWAY_PREFIX)) {
    reqUrl = reqUrl.slice(GATEWAY_PREFIX.length) || "/";
  }
  const [pathname, search] = reqUrl.split("?");
  const query = new URLSearchParams(search || "");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API 1: 健康检查
  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok", app: "mindmap", version: "1.4.0" }));
    return;
  }

  // API 2: 获取导图列表
  if (pathname === "/api/maps" && req.method === "GET") {
    const store = loadStore();
    const list = store.maps.map(m => ({
      id: m.id,
      title: m.title,
      theme: m.theme,
      layout: m.layout,
      nodeCount: countNodes(m.root) + (Array.isArray(m.freeRoots) ? m.freeRoots.reduce((acc, r) => acc + countNodes(r), 0) : 0),
      updatedAt: m.updatedAt
    }));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(list));
    return;
  }

  // API 3: 获取指定导图详情
  if (pathname === "/api/map" && req.method === "GET") {
    const mapId = query.get("id");
    const store = loadStore();
    let target = null;
    if (mapId) {
      target = store.maps.find(m => m.id === mapId);
    } else {
      target = store.maps.find(m => m.id === store.currentId) || store.maps[0];
    }
    if (target) {
      store.currentId = target.id;
      saveStore(store);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(target));
    } else {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "导图不存在" }));
    }
    return;
  }

  // API 4: 保存或更新导图数据
  if (pathname === "/api/map" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const store = loadStore();
        const mapId = data.id || "map-" + Date.now();
        data.id = mapId;
        data.updatedAt = new Date().toISOString();
        // 唯一名称保护：若修改标题与其他导图重名，自动排重保持唯一
        if (data.title) {
          data.title = getUniqueTitle(store, data.title, mapId);
        }
        
        const idx = store.maps.findIndex(m => m.id === mapId);
        if (idx >= 0) {
          // 保留该文档的视图位置记录（若本次未携带则沿用旧值）
          if (!data.view && store.maps[idx].view) data.view = store.maps[idx].view;
          store.maps[idx] = data;
        } else {
          data.createdAt = data.updatedAt;
          store.maps.push(data);
        }
        store.currentId = mapId;
        saveStore(store);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, id: mapId, title: data.title }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "无效的 JSON 数据: " + err.message }));
      }
    });
    return;
  }

  // API 5: 新建导图（保证名称绝对唯一）
  if (pathname === "/api/map/new" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const store = loadStore();
        const newId = "map-" + Date.now();
        const now = new Date().toISOString();
        const uniqueTitle = getUniqueTitle(store, payload.title || "新思维导图");
        const newMap = {
          id: newId,
          title: uniqueTitle,
          theme: payload.theme || "emerald",
          layout: payload.layout || "right",
          freeRoots: [],
          createdAt: now,
          updatedAt: now,
          root: {
            id: "root-" + Date.now(),
            text: uniqueTitle,
            children: [
              { id: "node-" + Date.now() + "-1", text: "分支主题 1", children: [] },
              { id: "node-" + Date.now() + "-2", text: "分支主题 2", children: [] }
            ]
          }
        };
        store.maps.push(newMap);
        store.currentId = newId;
        saveStore(store);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(newMap));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API 6: 删除导图（支持删除最后一个导图：删除后自动重置为全新空白导图）
  if (pathname === "/api/map/delete" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body);
        const store = loadStore();
        // 执行删除
        store.maps = store.maps.filter(m => m.id !== id);
        
        let reset = false;
        // 如果删除了最后一个导图，自动生成崭新的空白导图并作为当前导图
        if (store.maps.length === 0) {
          const now = new Date().toISOString();
          const newId = "map-" + Date.now();
          const freshMap = {
            id: newId,
            title: "新思维导图",
            theme: "emerald",
            layout: "right",
            freeRoots: [],
            createdAt: now,
            updatedAt: now,
            root: {
              id: "root-" + Date.now(),
              text: "中心主题",
              children: [
                { id: "node-" + Date.now() + "-1", text: "分支主题 1", children: [] },
                { id: "node-" + Date.now() + "-2", text: "分支主题 2", children: [] }
              ]
            }
          };
          store.maps = [freshMap];
          store.currentId = newId;
          reset = true;
        } else if (store.currentId === id) {
          store.currentId = store.maps[0].id;
        }
        
        saveStore(store);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, currentId: store.currentId, reset }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API 7: 文件导入转换 (支持 .xmind, .md, .mm, .opml, .km, .json)
  if (pathname === "/api/map/import" && req.method === "POST") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        const fullBuffer = Buffer.concat(chunks);
        let importedData = null;
        const filename = query.get("filename") || "imported.xmind";
        const ext = path.extname(filename).toLowerCase();

        if (ext === ".xmind") {
          importedData = importer.parseXmind(fullBuffer);
        } else if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
          const mdText = fullBuffer.toString("utf8");
          importedData = importer.parseMarkdown(mdText, path.basename(filename, ext));
        } else if (ext === ".mm" || ext === ".opml" || ext === ".xml" || ext === ".km") {
          const xmlText = fullBuffer.toString("utf8");
          importedData = importer.parseXmlMind(xmlText, path.basename(filename, ext));
        } else if (ext === ".json") {
          const json = JSON.parse(fullBuffer.toString("utf8"));
          importedData = json.root ? json : { title: path.basename(filename, ext), root: json };
        } else {
          try {
            importedData = importer.parseXmind(fullBuffer);
          } catch (e) {
            importedData = importer.parseMarkdown(fullBuffer.toString("utf8"), filename);
          }
        }

        if (!importedData || !importedData.root) {
          throw new Error("无法识别导图数据结构");
        }

        const store = loadStore();
        const newId = "map-" + Date.now();
        const now = new Date().toISOString();
        const rawTitle = importedData.title || path.basename(filename, ext) || "导入的导图";
        const uniqueImportTitle = getUniqueTitle(store, rawTitle);
        const completeMap = {
          id: newId,
          title: uniqueImportTitle,
          theme: "emerald",
          layout: "right",
          freeRoots: [],
          createdAt: now,
          updatedAt: now,
          root: importedData.root
        };
        store.maps.push(completeMap);
        store.currentId = newId;
        saveStore(store);

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(completeMap));
      } catch (err) {
        console.error("导入失败:", err);
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "导入解析失败: " + err.message }));
      }
    });
    return;
  }

  // API 8: 重命名导图（严格重名防御）
  if (pathname === "/api/map/rename" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const { id, title } = JSON.parse(body);
        const cleanTitle = (title || "").trim();
        if (!cleanTitle) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "导图名称不能为空" }));
          return;
        }
        const store = loadStore();
        const target = store.maps.find(m => m.id === id);
        if (!target) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "导图不存在" }));
          return;
        }
        // 重名校验
        const conflict = store.maps.find(m => m.id !== id && (m.title || "").trim().toLowerCase() === cleanTitle.toLowerCase());
        if (conflict) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: `导图名称「${cleanTitle}」已存在，导图名称不可重复！` }));
          return;
        }
        target.title = cleanTitle;
        target.updatedAt = new Date().toISOString();
        saveStore(store);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, id, title: cleanTitle }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 静态前端资源分发
  let staticPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(STATIC_DIR, staticPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".json": "application/json"
    };
    res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // 默认回退 index.html
  const indexHtml = path.join(STATIC_DIR, "index.html");
  if (fs.existsSync(indexHtml)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(indexHtml).pipe(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
}

function countNodes(node) {
  if (!node) return 0;
  let c = 1;
  if (node.children) {
    for (const ch of node.children) c += countNodes(ch);
  }
  if (node.summaries) {
    for (const sm of node.summaries) {
      if (sm.topic) c += countNodes(sm.topic);
    }
  }
  return c;
}

/* ---------- 服务启动逻辑 ---------- */
const server = http.createServer(requestHandler);

if (SOCKET_PATH) {
  try { fs.unlinkSync(SOCKET_PATH); } catch (e) {}
  server.listen(SOCKET_PATH, () => {
    try { fs.chmodSync(SOCKET_PATH, 0o777); } catch (e) {}
    console.log(`[MindMap FPK] 服务已就绪，Unix Domain Socket 运行中: ${SOCKET_PATH}`);
  });
} else {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[MindMap FPK] 服务已在本地 TCP 端口启动: http://0.0.0.0:${PORT}${GATEWAY_PREFIX}`);
  });
}
