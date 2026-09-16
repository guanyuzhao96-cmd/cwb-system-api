# 角色世界书（系统 API 版）

这是对 ST-Amily2-Chat-Optimisation 中 Character World Book 逻辑的独立复刻版。它直接调用 SillyTavern 当前连接的系统 API，不需要单独填写 API URL、密钥或模型。

## 安装

将整个 `cwb-system-api` 文件夹放入：

`SillyTavern/data/<你的用户目录>/extensions/`

重启 SillyTavern 或刷新页面。设置面板中会出现“角色世界书（系统 API 版）”。使用前请先为当前角色绑定主世界书，或者在插件设置里选择指定世界书。

## 已复刻功能

- 当前聊天内容提取与角色档案生成
- 全量模式、增量融合旧档案
- 每个角色一个选择性世界书条目
- 按聊天 ID 隔离并自动启停相关条目
- “Amily2角色总集”常驻条目与已更新楼层记录
- 最近若干层、指定楼层、全聊天分批更新
- 按消息阈值自动更新
- 原版 `[--Amily2::CHAR_START--]` 数据格式与旧格式转换
- 角色档案查看、编辑和删除

## API 行为

内部使用 SillyTavern 原生 `generateRaw()`，因此会沿用当前主 API、当前模型、采样预设和 instruct 状态。插件只允许可选地限制最大回复 Token，不保存任何 API 密钥。
