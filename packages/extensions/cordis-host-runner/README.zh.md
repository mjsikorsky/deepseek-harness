---
description: "动态 Cordis 包的 host 半说明，供选择、组合或排查注册表、沙箱与运行往返的 agent（智能体）与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cordis-host-runner

[English](README.md) | 中文

## 概述

`dsh-cordis-host-runner` 让 agent（智能体）定义并在本进程中运行动态 Cordis 包。不可变版本支持更新，带浏览器半的包使用 Cordis 审批卡片。共享部署可以通过同一卡片要求精确的 Host 代码准入。定义只存在于进程内存中，重启即消失。模型工具属于 `@deepseek-ai/dsh-tool-cordis`，浏览器执行属于 `@deepseek-ai/dsh-cordis-client-runner`。`vmTimeoutMs` 限制同步求值时长，部署策略决定是否信任 Host 代码。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在任何一个应当支持动态包的组合中挂载本插件——它支撑模型的 `cordis_*` 工具，而带浏览器半的包还需要在客户端组合中额外挂载 client runner 与 UI 包。常用路径是显式的：加载本包，按需设置 `vmTimeoutMs`，其余交给工具与浏览器。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-cordis-host-runner'
  config:
    vmTimeoutMs: 5000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `vmTimeoutMs` | `5000` | host 半在 vm 中同步执行的那部分被中止求值前可运行的毫秒数 |
| `requireHostActivationPolicy` | `false` | 动态 Host 源码求值前必须获得部署准入 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-cordis-host-runner)是每个受支持字段的穷尽式真源。

### run 会做什么

定义由 `cordis_define` 记录、由 `cordis_run` 激活。未配置部署准入策略时，只有 host 半的包直接在本进程中激活：它的代码在沙箱中运行。带浏览器半的包变成一次请求：它一直等到有人在一个页面上允许或拒绝；作答页面随后先装载 host 半、再装载浏览器半。`mode: "run"` 启动当前包或重启它，`mode: "update"` 切换到另一个包版本。`cordis_stop` 结束一次存活运行——移除该包的 handler 与任何已装载的浏览器 UI——同时保留可再次运行的定义；`cordis_undefine` 停止并忘掉它。

### 共享部署的 Host 准入

将 `requireHostActivationPolicy` 设为 `true` 并组合 `cordisHostActivationPolicy`，即可要求对精确的 Host 源码授权。纯 Host 包也使用现有的 Cordis 审批卡片。直接从面板激活遵循同一策略。缺少或被拒绝的授权会阻止求值；更新未来 Client 版本的权限不会批准新的 Host 代码。

provider 从经过身份验证的部署上下文中确定审批者及其代码信任权限。会话所有权或协作者写权限不授予该权限。有限租约在求值前和等待启动后检查。到期、撤销、停止和 undefine 会撤回待完成激活并释放原生 fiber 与 handler；迟到的批准不能重新激活已停止的包。

决策依据见 [Host 代码准入 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-13-dynamic-host-code-admission.zh.md)。

### 定义的去向

定义以会话为界、以进程为本：包只对定义它的会话可见，其他会话读取时视其为不存在，DSH 重启后一切都消失。会话日志保留一次 define 调用的参数——包括它提交的代码——以及回执；解析出的定义只存于内存注册表。浏览器半只能经一次运行到达页面，因此刷新后的页面手上什么都没有，直到有人再次运行该包。

### 信任立场

沙箱隔离全局变量，但不是安全边界：Node 全局变量不存在，或重定向到 Cordis 服务（`ctx.fs`、`ctx.web`、`ctx.bash` 与定时器 helper），host 半收到的是不含框架内部机制的 façade，但它声明的服务仍会触达存活运行时。获得准入的 Host 代码可以访问此共享进程及其私有资源。撤回不能撤销先前的副作用，也不能收回受信任代码刻意保留的引用。Host 代码信任与在隔离执行 guest 中运行代码的权限相互独立，参见[自引用工具集 Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 runner 背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

runner 基于两项职责划分。**注册表与沙箱是同一个服务。** `DynamicCordisRunnerService` 拥有定义注册表、vm 沙箱、host 半 fiber 生命周期与 invoke handler 表，因此一个定义的整个生命周期只有一个 owner。**版本是不可变的包。** 插件持有 `define` 之后永不变化的包；`currentPackageId` 与 `nextPackageId` 指向运行中与目标版本，`mode: "run"` 与 `"update"` 编码目标是否等于当前版本。浏览器往返之所以存在，是因为浏览器半只能由页面执行：服务 emit 请求并挂起，由页面的结论结算，停止、undefine 和部署授权共同控制取消。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务入口：`Config`、注册表接线、生命周期动词、steering（中途引导）消息 |
| [`src/registry.ts`](src/registry.ts) | 定义存储：插件与包标识、运行尝试、审批请求 |
| [`src/sandbox.ts`](src/sandbox.ts) | `node:vm` 求值：全局变量、Node API 陷阱、define 时语法预检 |
| [`src/guard.ts`](src/guard.ts) | 注册边界：schema 规范化、沙箱 `ctx` façade、插件形态检查 |
| [`src/lifecycle.ts`](src/lifecycle.ts) | 在 `cordis-dynamic` fiber 组下启动 host 半 |
| [`src/inspect-registry.ts`](src/inspect-registry.ts) | `ctx.cordisInspect` 注册表：host 提供方加镜像的 client manifest（元数据清单） |
| [`src/types.ts`](src/types.ts) | `dynamicCordisRunner` remote namespace 与转发事件共享的 client 安全载荷形态 |

### 一次 run 的流程

`define` 对元数据做首尾去空白与必填校验，用编译预检每一半的语法（不执行任何代码），铸出插件与包标识，并把定义登记在发起调用的会话名下。`run` 对照 `currentPackageId` 与 `nextPackageId` 解析目标：未配置部署准入的纯 host 包在沙箱中求值并立即提交，需要页面决策的包则建立一次审批请求、emit `cordis/request-run` 并挂起。作答页面先调用 `runHostHalf`，仅在存在 Client 半时获取其代码，然后调用 `resolveRequestRun`；命名存活 revision 的成功会提交激活、设置 `currentPackageId`，`cordis/request-run-resolved` 让其他每个页面撤下待作答入口。`stop` 回退存活下发——handler disposer、fiber dispose（资源释放）与 `cordis/dynamic-retract` 广播——并让定义保持可运行。四条转发事件（`cordis/request-run`、`cordis/request-run-resolved`、`cordis/dynamic-package`、`cordis/dynamic-retract`）声明在 client 安全的 `./types` 子路径上，并由 `@deepseek-ai/dsh-api-remotes` 的白名单准许投递——正是这一点让浏览器能经 `ctx.remote.$on` 收到它们。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 runner 逐步进入调用它的工具、应答它的浏览器半与生成的表面。

- [工具包](../tool-cordis/README.zh.md)——调用本服务的模型侧工具。
- [Client runner](../cordis-client-runner/README.zh.md)——应答运行请求并装载浏览器半代码的浏览器半。
- [UI 包](../ui-cordis/README.zh.md)——用户批准并操作运行的面板。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-cordis-host-runner)——每个受支持配置字段。
- [extensions 子系统](../../../docs/subsystems/extensions.zh.md)——生成的 `ctx.cordisInspect` 与 `ctx.dynamicCordisRunner` API 及 `cordis/*` 事件。
- [自引用 Cordis 工具集 Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.zh.md)——沙箱语义、生命周期与组合的理由。

-----

<a id="model-experience"></a>
## 模型体验

### 转达给所属会话的运行结果、拒绝与诊断

#### 模型看到的内容

没有直接可见的内容：本包不注册任何工具，也不注入提示词。当一次 run 结算时，它会向所属会话发送 steering——成功时点名当前包并指示继续，用户拒绝时指示不要再次请求同一激活，技术性失败则给出原因、版本指针与「检查—修正—更新」路径。它还会通过 steering 转达结算后的渲染失败（slot、条目是否已被移除）、host guard 拒绝与 host handler 失败。面板上的停止与移除手势会注入一条 user 角色消息，说明用户做了什么。`run` 或 `stop` 的拒绝还会经调用它的工具结果到达模型。

#### Token 影响

有条件且随数据而定：消息只在事件发生时到达，每条都携带一段有界的说明；没有固定的每请求成本。

#### KV Cache 影响

本包自身没有。注册工具的 host 半会改变下一次请求的工具视图，从第一个变化的 schema token 起使前缀复用失效；运行或停止一个不注册任何工具的包对前缀不产生影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 runner 何时需要特别小心。它们是当前包约束，不是任务积压。

- **run 成功不等于 UI 渲染成功**——只要作答页面已装载浏览器半，`run` 就会返回；React 是随后才渲染的，因此抛异常的组件不可能出现在 run 回执里。该失败经 steering 与 `cordis_inspect_self` 诊断浮现。
- **页面审批需要已连接的页面**——请求保持待处理，直到得到应答、停止或移除。部署准入要求运行卡片时，纯 Host 包也遵循此规则。
- **挂起的 run 请求没有超时**——它一直等人，直到提问的轮次被取消，因此无人值守的自动化用不了带浏览器半的包。
- **`vmTimeoutMs` 只约束同步求值**——async 的 host 半函数体会逃出该上限，这与工具集基于协作的信任立场一致。
- **陈旧成功的拒绝会让请求继续挂起**——作答页面点名的 revision 已被注册表越过时，该结论会被拒绝（`accepted: false`），请求保持可作答，直到另一个页面作答或调用方取消；浏览器半不读这个 ack。
- **运行播报不携带服务声明**——浏览器半声明的 `inject` 是从它在页面里返回的插件上读出的，因此 `cordis/request-run` 只携带元数据，绝无代码或服务清单。
- **`zod` 是生成的 Typert 契约面的运行时依赖，不是 `src` 的依赖**——`./typert` 与 `./remote` 解析到未打包的 `lib` 文件，其中带有裸的 `import { z } from 'zod'`，所以即使 `src` 里没有任何代码 import zod，本包也要声明它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。definition registry 位于进程内存中且没有可观察的事件流；它唯一负责的关系是运行中的 definition 拥有已结算的 host-half fiber 及其 handler table，该关系在单个等待完成的操作中建立和解除，因此由包测试直接断言。
