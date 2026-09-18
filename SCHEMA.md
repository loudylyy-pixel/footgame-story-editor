# story_graph.json

- `nodes[].prerequisites`：数组，**空 = 无前置**。项：`{ "type":"node"|"flag", "id":"...", "op":"done"|"has" }`
- `edges[].createsSubRoute`：true 时可用「创建子路线」
- `edges[].choiceId`：对应剧本选项
- `scriptRef`：稿件提示，可空
- 保存：整文件覆盖；启动时加载

UI：底特律变人式节点流程图。
