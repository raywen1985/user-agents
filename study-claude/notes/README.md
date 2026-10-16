# 学习记录

只有用户明确确认完成或要求保存后，才在此创建正式记录。

## 文件命名

使用 `YYYY-MM-DD-<roadmap-unit>-<slug>.md`。同一 `session_id` 再次保存时更新原文件，不创建副本。

## 必需 frontmatter

```yaml
---
session_id: 2026-10-14-foundation-01-model-capability
completed_at: 2026-10-14T20:30:00+08:00
roadmap_unit: foundation-01
mode: daily
status: completed
next_unit: foundation-02
privacy: tracked
sources: []
---
```

包含儿童信息、未公开工作内容、内部代码、公司或项目标识、健康或财务信息的记录必须放入 `notes/private/`，该目录不进入 Git。无法判断时也使用私密目录。

## 建议正文

1. 本次主题
2. 三条关键理解
3. 动手实践与结果
4. 仍待验证的问题
5. 下一步
