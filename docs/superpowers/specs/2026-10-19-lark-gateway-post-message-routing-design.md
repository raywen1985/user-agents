# Lark Gateway Post 消息路由修复设计

## 问题

飞书事件总线已收到用户通过语音输入等方式发送的消息，但该消息在聊天记录中的
`msg_type` 是 `post`。`lark-cli event consume im.message.receive_v1` 已把 `post`
内容渲染为普通可读文本；Gateway 入口目前只接受 `text` 和 `audio`，因此在写入
inbox 前静默丢弃 `post`，用户看不到任何回复。

## 方案

- 入站类型白名单从 `text/audio` 扩展为 `text/post/audio`。
- `post` 使用 lark-cli 已渲染的 `content`，与 `text` 一样直接进入候选解析、路由和
  任务队列，不再次解析 JSON 或 HTML。
- `audio` 保持现有下载、转码和语音识别流程。
- `interactive`、图片、文件、视频及其他类型继续拒绝，不把卡片或附件标记当成命令。
- 保留现有私聊、用户身份、发送者白名单、消息 ID、非空内容和 inbox 去重检查。

实现采用一个可单测的纯消息类型判断函数，Gateway 入口调用该函数，避免测试仅复制
字符串白名单而没有覆盖实际分支。

## 测试

- `text`、`post`、`audio` 被判断为可路由。
- `interactive`、`image`、`file` 和未知类型不可路由。
- `post` 的已渲染正文保持原样进入普通文本路径，不调用语音转写。
- 现有语音解析、下载、转码、识别和清理测试保持通过。
- 运行 `lark-claude` 全量 Node 测试。

## 非目标

- 不解析飞书卡片或其他富媒体为远程命令。
- 不改变 Session 匹配、审批、任务调度或原生 Session 占用逻辑。
- 不处理飞书语音识别权限配置；真正的 `audio` 仍需要现有语音链路所需权限。

## 验收

- 飞书中显示为 `post`、内容为普通文字的私聊消息能够进入 inbox 并收到 Gateway 回复。
- 相同消息不会因重连或重复投递执行两次。
- 非白名单消息类型仍不会触发远程任务。
