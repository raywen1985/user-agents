# 学习复盘与保存模板

## 保存前检查

- 用户是否明确说已完成或要求保存？如果没有，停止，不写文件。
- 是否含儿童信息、内部工作内容、公司或项目标识、内部代码、健康或财务信息？如有，使用 `notes/private/` 或不落盘。
- 是否已有相同 `session_id`？如有，更新原记录，不创建副本。

## 记录 frontmatter

```yaml
---
session_id: YYYY-MM-DD-roadmap-unit-topic
completed_at: ISO-8601 timestamp with timezone
roadmap_unit: unit-id
mode: daily | concept | frontier | application
status: completed | partial | draft
next_unit: unit-id-or-null
privacy: tracked | private
sources:
  - url
---
```

## 正文

### 本次主题

### 三条关键理解

### 实践与验证结果

### 仍待确认

### 下一步

## 进度更新

- 只有 `status: completed` 才推进路线。
- 更新 `completed_units` 时去重。
- 同一 `session_id` 的重复保存不得再次推进。
- 先验证新 JSON，再写同目录临时文件，最后原子替换 `state/progress.json`。
- 原状态无效时停止写入并保留原文件。
