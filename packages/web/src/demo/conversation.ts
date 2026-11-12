/** Rich text fixture intentionally includes complete, incomplete-safe, and invalid diagrams. */
export const richConversation = `# 搜索体验交付计划

> 先确定边界，再并行实现。消息可以在运行中继续发送。

| 模块 | 负责人 | 验收 |
| --- | --- | --- |
| API | Codex | \`npm test\` 通过 |
| 审查 | pi | 输入校验与权限边界 |

- [x] 阅读现有 API
- [ ] 实现搜索与回归
  - 覆盖中文关键词
  - 验证归档过滤
- [ ] 独立审查

~~旧的串行方案~~改为并行验证。文档：https://example.com/docs

\`\`\`typescript
interface SearchResult { id: string; title: string }
const search = async (query: string): Promise<SearchResult[]> => {
  return fetch("/api/search?q=" + encodeURIComponent(query)).then(r => r.json());
};
\`\`\`

\`\`\`python
from dataclasses import dataclass

@dataclass
class SearchResult:
    id: str
    title: str
\`\`\`

## 委派流

\`\`\`mermaid
flowchart TD
  Lead[主导者] --> API[Codex: API]
  Lead --> Review[pi: 审查]
  API --> Tests[回归测试]
  Tests --> Summary[结果汇总]
  Review --> Summary
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant Human as 你
  participant Lead as 主导者
  participant Worker as 成员
  Human->>Lead: 新需求
  Lead->>Worker: 委派任务
  Worker-->>Lead: 结构化结果
  Lead-->>Human: 汇总与验证
\`\`\`

下面这个图故意写错，用于展示可读的错误与源码回退：

\`\`\`mermaid
flowchart TD
  A[未闭合的节点 --> B
\`\`\`
`;
