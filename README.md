# 足迹 · 剧情路线编辑器（Render）

固定公网地址；Render 免费档闲置约 15 分钟会休眠，再访问等几十秒唤醒。

线路板保存在本仓库 `story_graph.json`（每次保存会 commit），休眠不丢数据。

## 本地

```bash
python3 server.py
# http://127.0.0.1:8765
```

## Render

1. 打开：https://render.com/deploy?repo=https://github.com/loudylyy-pixel/footgame-story-editor
2. 在 Environment 填入 `GITHUB_TOKEN`（需要 `repo` 写权限的 PAT）
3. Deploy 后使用 `https://footgame-story-editor.onrender.com`（以控制台为准）
