const zlib = require("zlib");

/**
 * 纯原生 Node.js ZIP 解包工具（零依赖解析 .xmind）
 */
function unzipBuffer(buf) {
  const files = {};
  let offset = 0;
  while (offset < buf.length - 4) {
    const sig = buf.readUInt32LE(offset);
    if (sig === 0x04034b50) { // Local file header
      const method = buf.readUInt16LE(offset + 8);
      const compSize = buf.readUInt32LE(offset + 18);
      const uncompSize = buf.readUInt32LE(offset + 22);
      const nameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const filename = buf.toString("utf8", offset + 30, offset + 30 + nameLen);
      const dataStart = offset + 30 + nameLen + extraLen;
      const dataEnd = dataStart + compSize;
      
      let fileData = null;
      if (method === 0) {
        fileData = buf.slice(dataStart, dataEnd);
      } else if (method === 8) {
        try {
          fileData = zlib.inflateRawSync(buf.slice(dataStart, dataEnd));
        } catch (e) {}
      }
      if (fileData) {
        files[filename] = fileData;
      }
      offset = dataEnd;
    } else {
      offset++;
    }
  }
  return files;
}

/**
 * 解析 .xmind 导图（全面支持 summary 总结、labels 注解/标签）
 */
function parseXmind(buffer) {
  const files = unzipBuffer(buffer);
  
  if (files["content.json"]) {
    const jsonStr = files["content.json"].toString("utf8");
    const data = JSON.parse(jsonStr);
    const sheet = Array.isArray(data) ? data[0] : data;
    const rootTopic = sheet.rootTopic || {};

    function convertTopic(t) {
      if (!t) return null;
      let labels = [];
      if (Array.isArray(t.labels)) {
        labels = t.labels.map(l => String(l).trim()).filter(Boolean);
      } else if (typeof t.label === "string" && t.label.trim()) {
        labels = [t.label.trim()];
      }

      const node = {
        id: t.id || "node-" + Math.random().toString(36).slice(2, 9),
        text: t.title || "分支主题",
        note: (t.notes && t.notes.plain && t.notes.plain.content) || (typeof t.note === "string" ? t.note : ""),
        labels: labels,
        children: [],
        summaries: []
      };

      // 1. 递归转换常规附着子节点
      const attached = (t.children && t.children.attached) || [];
      if (Array.isArray(attached)) {
        for (const child of attached) {
          const c = convertTopic(child);
          if (c) node.children.push(c);
        }
      }

      // 2. 提取 summaries（总结/概要）及其后代分支
      const xmindSummaries = Array.isArray(t.summaries) ? t.summaries : [];
      const summaryTopics = (t.children && Array.isArray(t.children.summary)) ? t.children.summary : [];
      const summaryTopicMap = {};
      summaryTopics.forEach(st => {
        if (st.id) summaryTopicMap[st.id] = st;
      });

      if (xmindSummaries.length > 0) {
        xmindSummaries.forEach((s, idx) => {
          let range = [0, Math.max(0, node.children.length - 1)];
          if (s.range) {
            const m = String(s.range).match(/\(?\s*(\d+)\s*,\s*(\d+)\s*\)?/);
            if (m) {
              range = [parseInt(m[1], 10), parseInt(m[2], 10)];
            }
          }
          const sumTopicRaw = summaryTopicMap[s.topicId] || summaryTopics[idx] || {
            id: s.topicId || ("node-sum-" + Date.now() + "-" + idx),
            title: "总结",
            children: {}
          };
          
          const sumNode = convertTopic(sumTopicRaw);
          if (sumNode) {
            node.summaries.push({
              id: s.id || ("sum-" + Date.now() + "-" + idx),
              range: range,
              topic: sumNode
            });
          }
        });
      } else if (summaryTopics.length > 0) {
        summaryTopics.forEach((st, idx) => {
          const sumNode = convertTopic(st);
          if (sumNode) {
            node.summaries.push({
              id: "sum-" + Date.now() + "-" + idx,
              range: [0, Math.max(0, node.children.length - 1)],
              topic: sumNode
            });
          }
        });
      }

      return node;
    }

    return {
      title: sheet.title || rootTopic.title || "XMind 导入导图",
      root: convertTopic(rootTopic)
    };
  }

  if (files["content.xml"]) {
    const xml = files["content.xml"].toString("utf8");
    return parseXmlMind(xml, "XMind 经典导图");
  }

  throw new Error("未在 .xmind 压缩包中发现 content.json 或 content.xml");
}

/**
 * 轻量 XML 解析器（支持 FreeMind .mm、OPML、XMind 8 xml 中的 summary 与 label 识别）
 */
function parseXmlMind(xml, defaultTitle) {
  let rootTitle = defaultTitle;
  const titleMatch = xml.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) rootTitle = titleMatch[1].trim();
  const textAttrMatch = xml.match(/TEXT="([^"]+)"/i);
  if (textAttrMatch) rootTitle = textAttrMatch[1].trim();

  const sumMatch = xml.match(/<topics\s+type="summary">[\s\S]*?<topic[^>]*>[\s\S]*?<title[^>]*>([^<]+)<\/title>[\s\S]*?<\/topic>/i);
  let summaryText = sumMatch ? sumMatch[1].trim() : null;

  const nodes = [];
  const regex = /<(topic|node|outline)[^>]+(?:TEXT="([^"]+)"|title="([^"]+)")?[^>]*>/gi;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const text = m[2] || m[3];
    if (text && (!summaryText || text !== summaryText)) {
      nodes.push(text.trim());
    }
  }

  if (!nodes.length) {
    return { title: defaultTitle, root: { id: "root-1", text: defaultTitle, labels: [], children: [], summaries: [] } };
  }

  const root = { id: "root-1", text: nodes[0], labels: [], children: [], summaries: [] };
  for (let i = 1; i < nodes.length; i++) {
    root.children.push({ id: "node-" + i, text: nodes[i], labels: [], children: [], summaries: [] });
  }

  if (summaryText && root.children.length > 0) {
    root.summaries.push({
      id: "sum-xml-1",
      range: [0, root.children.length - 1],
      topic: {
        id: "node-sum-xml",
        text: summaryText,
        labels: [],
        children: [],
        summaries: []
      }
    });
  }

  return { title: nodes[0] || defaultTitle, root };
}

/**
 * 健壮精准的 Markdown 标题与大纲列表转脑图（支持 [标签] 或 #标签 语法）
 */
function parseMarkdown(text, defaultTitle = "Markdown 导图") {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!lines.length) {
    return { title: defaultTitle, root: { id: "root-1", text: defaultTitle, labels: [], children: [], summaries: [] } };
  }
  let rootText = defaultTitle;
  let startIdx = 0;
  if (lines[0].startsWith("#")) {
    rootText = lines[0].replace(/^#+\s*/, "").trim();
    startIdx = 1;
  }
  const root = { id: "root-" + Date.now(), text: rootText, labels: [], children: [], summaries: [] };
  const stack = [{ depth: 0, node: root }];

  for (let i = startIdx; i < lines.length; i++) {
    const rawLine = lines[i];
    const stripped = rawLine.trim();
    if (!stripped) continue;

    if (stripped.startsWith("> 总结") || stripped.startsWith("> 概要") || stripped.startsWith("== 总结")) {
      const sumText = stripped.replace(/^[>=#\s*]+(?:总结|概要)[:：]?\s*/, "").replace(/[=]+$/, "").trim();
      const parent = stack[stack.length - 1].node;
      if (parent && parent.children && parent.children.length > 0) {
        if (!parent.summaries) parent.summaries = [];
        parent.summaries.push({
          id: "sum-" + Date.now() + "-" + i,
          range: [0, parent.children.length - 1],
          topic: {
            id: "node-sum-" + Date.now() + "-" + i,
            text: sumText || "总结",
            labels: [],
            children: [],
            summaries: []
          }
        });
      }
      continue;
    }

    let depth = 1;
    let nodeText = stripped;
    if (stripped.startsWith("#")) {
      const m = stripped.match(/^#+/);
      const hCount = m ? m[0].length : 1;
      depth = Math.max(1, hCount - 1);
      nodeText = stripped.slice(hCount).trim();
    } else {
      const indent = rawLine.match(/^\s*/)[0].length;
      depth = Math.floor(indent / 2) + 2;
      nodeText = stripped.replace(/^([-*+]|\d+\.)\s*/, "").trim();
    }

    // 提取文本中可能存在的标签
    const labels = [];
    const labelMatch = nodeText.match(/[\[【]([^\]】]+)[\]】]$/);
    if (labelMatch) {
      labels.push(labelMatch[1].trim());
      nodeText = nodeText.slice(0, labelMatch.index).trim();
    } else {
      const tagMatch = nodeText.match(/#([\w\u4e00-\u9fa5]+)$/);
      if (tagMatch) {
        labels.push(tagMatch[1].trim());
        nodeText = nodeText.slice(0, tagMatch.index).trim();
      }
    }

    const newNode = {
      id: "node-" + Date.now() + "-" + i,
      text: nodeText,
      labels: labels,
      children: [],
      summaries: []
    };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    stack[stack.length - 1].node.children.push(newNode);
    stack.push({ depth: depth, node: newNode });
  }

  return { title: root.text || defaultTitle, root };
}

module.exports = {
  parseXmind,
  parseXmlMind,
  parseMarkdown
};
