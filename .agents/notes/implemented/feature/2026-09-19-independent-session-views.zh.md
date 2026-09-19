# Agent Note: Independent Session views

Status: implemented

[English](2026-09-19-independent-session-views.md) | 中文

## 问题

嵌入应用可能同时显示多个 Session。为每个面板调用当前选择操作会改变其他面板的选择，无法表达独立拥有的视图。

## 决策

Session Controller 提供 `acquireView(id, expectedCreatedAt?)`，返回已有原生 binding 和幂等释放操作。只有符合条件且列出的 Session 才能获取新视图。租约保留已移出列表的 scope，直到最后一个视图释放；客户端销毁会清理所有 scope。可选客户端配置 `persistSelection: false` 将选择存储交给嵌入应用。默认行为不变。

## 考虑过的替代方案

**为每个面板切换当前 Session。** 这会改变共享导航状态，不能表达独立视图生命周期。

**实现第二套 Session reducer。** 原生事件折叠、重连和提示提交已归 Session Controller 所有。租约复用这些机制。

## 后果

关闭视图释放客户端资源，不会取消或删除 Host 工作。持有视图不构成获取不可用 Session 新视图的授权。所属客户端测试覆盖独立获取、释放、选择和销毁。本变更不实现嵌入应用的准入或资源授权。

恢复保存的视图时可传入原生 header 的创建时间，拒绝已被复用的 Session ID。原生快照包含 header；重连时若身份发生变化，会在替换已有事件窗口之前拒绝该快照。
