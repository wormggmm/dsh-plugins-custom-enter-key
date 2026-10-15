# dsh-plugins-custom-enter-key

DSH（DeepSeek Harness）Web 插件：**交换聊天输入框的 Enter 与 Ctrl/Cmd + Enter**。

- **Enter** → 换行（不发送）
- **Ctrl + Enter**（macOS 上 Cmd + Enter）→ 发送
- **Shift + Enter** → 始终换行（系统原生行为，本插件不接管）

每个键的行为都可以在「设置 → 通用 → 输入快捷键」里单独改：
`换行` / `发送` / `系统默认`（不接管）。

## 默认值与可选项

| 按键 | 默认行为 | 可选项 |
|---|---|---|
| `Enter` | 换行 | 换行 / 发送 / 系统默认 |
| `Ctrl + Enter`（或 `Cmd + Enter`） | 发送 | 换行 / 发送 / 系统默认 |
| `Shift + Enter` | 换行（系统原生，插件不接管） | — |

「系统默认」= 该键完全交给 DSH 处理，等同于没装本插件。所以想恢复官方行为，
把两个键都选成「系统默认」即可，或者在 Plugins 页面里直接关掉本插件的行。

## 安装

本插件是标准 dsh bundle（`dsh.bundle.patch` + `dsh.client` 浏览器半部），
从**本地目录**安装，**无需构建**（无 TypeScript、无打包步骤、无依赖）。

注意：`dsh plugin ... add` 只做「安装依赖」，bundle 还要被**选中**
（写进 profile `package.json` 的 `dsh.profile.bundles`）才会挂载。下面三条路
任选其一即可。

### 方式一（推荐）：在 dsh 会话里让 agent 装

在 dsh 里说「把 `C:\my_github\dsh-plugins-custom-enter-key` 装进当前 profile」，
agent 会调用 `plugin_manager` 的 `install_bundle`（target 传本目录绝对路径）。
该操作会一次完成「安装 + 选中」，并返回 `application` 状态
（需要 Creator 模式才有这个工具）。

### 方式二：Web 侧栏 Plugins 页面

侧栏 **Plugins** 页面可安装并启停 profile 的 bundle（bundle 开关就是改
`dsh.profile.bundles`）。装完后打开本插件的开关即可。

### 方式三：CLI（手工两步）

```sh
# 1. 安装依赖（args 会原样转发给 profile 目录里的 pnpm）
dsh plugin --profile web add /绝对/路径/dsh-plugins-custom-enter-key

# 2. 选中 bundle：编辑 ~/.dsh/profiles/web/package.json，把包名追加到
#    dsh.profile.bundles 数组末尾
#
#    "dsh": { "profile": { "bundles": [ "...dsh-base", "...dsh-web-app",
#      "dsh-plugins-custom-enter-key" ] } }
```

Windows 示例：

```powershell
dsh plugin --profile web add C:\my_github\dsh-plugins-custom-enter-key
```

### 生效与卸载

- 新装的 bundle 通常能通过 HMR 直接激活；**替换已装包的代码需要重启
  `dsh web`**（浏览器 bundle 是懒加载的模块工厂，刷新页面同理）。
- 关闭：Plugins 页面里的 bundle 开关 / 插件行开关（后者写 profile
  `cordis.patch.yml` 的 `disabled: true`）。
- 卸载：`dsh plugin --profile web remove dsh-plugins-custom-enter-key`，
  再从 `dsh.profile.bundles` 里删掉包名。

## 配置

设置 → 通用 → 「输入快捷键」一行，两个分段控件分别配置 Enter 与 Ctrl + Enter。

配置保存在**浏览器 localStorage**（key：`dsh.customEnterKey.v1`，按站点 origin
独立），重启浏览器/服务都不丢；它与 dsh 的 profile 配置无关，清站点数据会回到默认值。

## 实现原理

1. **拦截位置**：`document` 的 **capture 阶段** `keydown` 监听。composer 自己的
   按键仲裁注册在 shell 的 Lexical editor 上（`KEY_ENTER_COMMAND`，
   `COMMAND_PRIORITY_CRITICAL`），Lexical 只遍历优先级 4 → 0，插件无法用更高优先级
   抢占；而 capture 监听发生在编辑器根节点自身的监听之前，是 bundle 插件唯一可用的接缝。
   命中后 `preventDefault()` + `stopPropagation()`，composer 完全看不到这次 Enter。

2. **换行怎么实现**：在编辑器根节点上**重放一次 Shift+Enter 手势**
   （`new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: false })`）。
   这次事件走 composer 原本的链路（harness keymap 对 Shift+Enter 明确放行 →
   `@lexical/plain-text` → `INSERT_LINE_BREAK_COMMAND`），因此光标位置、撤销历史、
   @引用 chips 的表现和真人按 Shift+Enter 完全一致。`bubbles: false` 让它不惊动
   window 级快捷键观察者；插件内部用 `replaying` 标志保证重放事件不被自己二次处理。

3. **发送怎么走**：从事件目标取会话（`[data-conversation-session]`）→
   `ctx.sessions.binding(id).ctx` → `ctx.conversation.input.for(actx).submit('queue', 'enter')`，
   即官方输入门面（`SessionInput.submit`），与输入框自身提交同一条通道
   （斜杠命令裁决、@引用序列化、草稿清理都由它负责）。

4. **放行的场景**（保持系统行为）：输入法组合输入（`isComposing` / `keyCode 229` /
   composer 的 `data-composer-composing` 监视属性）、`@`/`/` 菜单打开
   （`[data-trigger-menu]`，此时 Enter 用于选中菜单项）、`Alt + Enter`、
   `Ctrl + Shift + Enter`、`Shift + Enter`、焦点不在 composer
   （`[data-composer-input]` 之外）、无会话的 inert composer，以及已被更早的
   监听器声明过的事件（`event.defaultPrevented`）。

5. **按住连发**：`换行` 允许连发（与原生 Shift+Enter 一致）；`发送` 忽略
   `event.repeat`，避免按住 Enter 连续发消息。

## 已知限制

- **仅 Web GUI**：manifest 声明 `platform: web`，Desktop 端不加载。
- **Ctrl + Enter 固定按「队列」语义发送**：空闲时立即发送、Agent 忙碌时进入队列。
  它不等价于 dsh 的「繁忙时 Enter 行为」偏好；若你把那里设成 `steer`，本插件的
  Ctrl + Enter 仍然排队发送。想保留系统的加速语义，把 Ctrl + Enter 设为「系统默认」。
- **依赖 composer 的 DOM 契约**：`[data-composer-input]`（可编辑区）、
  `[data-conversation-session]` + `dataset.conversationSession`（会话归属）、
  `[data-trigger-menu]`（菜单放行）、`data-composer-composing`（组合输入放行）。
  dsh 若改动这些标记，插件会**静默退化为系统默认行为**（不报错、不破坏输入框）；
  届时按新版本源码更新 `client.js` 里这一组选择器即可。
- 不接管右下角发送按钮（它仍然等于「Enter 手势」）；也不改动设置里
  「繁忙时 Enter 行为」那一行。

## 自检与开发

```sh
node test/smoke.mjs      # 63 项纯逻辑检查：设置读写、按键决策表、设置行联动、持久化
node --check client.js   # 语法检查
```

`test/smoke.mjs` 把 `client.js` 加载进「假的模块加载器 + 假 DOM」环境里跑，
不需要浏览器、不需要任何依赖，改动后可直接回归。

### 文件结构

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch`（bundle 声明）+ `dsh.client`（浏览器半部：`platform` / `inject`） |
| `cordis.patch.yml` | bundle 补丁：插入插件行 |
| `index.js` | Host 半部（空实现，插件行需要一个合法模块） |
| `client.js` | 浏览器半部：`__ModuleLoader__` 工厂包，按键拦截 + 设置行 + 字典 |
| `locale/zh.json`、`locale/en.json` | Plugins 页面显示的标题/描述 |
| `icon.svg` | 插件图标（原创图形，显式配色，浅/深色主题下都可见） |
| `test/smoke.mjs` | 纯 JS 自检 |

## 兼容性

面向 **dsh 0.2.1-alpha.2**（Lexical composer、`ctx.slots` 服务、
`settings.general.item` 设置槽位、`ctx.conversation.input` 输入门面）开发与验证。
更早的 textarea composer 版本（`data-phase="inert"` 那一代）不适用。

## 许可

未指定；如需公开发布，请自行补 `LICENSE`。

## 参考

- 参考实现（配置思路与 localStorage 方案）：
  <https://github.com/aberter0x3f/dsh-custom-enter-key>
- dsh 源码：<https://github.com/deepseek-harness/deepseek-harness>
