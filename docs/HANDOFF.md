# 项目交接（Handoff）

> 给接手本项目的新会话/新成员快速恢复上下文。最后更新：`06edb78`。

## 一句话

因科特（Incott）鼠标的独立桌面配置工具，基于逆向的 HID 协议，**不依赖官方网页驱动**（incott.net/mouse 已停止支持）和官方桌面软件。

## 线上地址

- 源码：https://github.com/HeHaoren/incott-mouse-app
- 安装包：https://github.com/HeHaoren/incott-mouse-app/releases/tag/v0.1.0

## 已完成功能

- DPI：多档位、滑块 + 精确输入（回车保存、50 倍数吸附）、XY 轴单独调节、档位增删切
- 键位设置：系统 / 键盘 / 多媒体 / 宏 四类映射
- 性能：回报率（125~8000Hz，非 8K 设备自动隐藏 2000Hz+）、LOD（PAW3950 自动旋转映射）、运动同步 / 直线修正 / 波纹修正、按键响应时间
- 宏：10 槽位，按下/释放 + 延迟动作编辑，分块上传到鼠标
- 型号识别：连接时读 0x8F，顶栏显示「型号 · 传感器 · 8K」，DPI 上限按传感器切换
- 导入导出：兼容官方网页驱动的 .ict 配置 / .icm 宏库格式（含前进/后退 UI 顺序、looptype ±1 换算）
- 中英文切换（含原生菜单栏），文案逐字对齐官网
- 连接优化：worker 线程枚举，秒连不卡（此前 15 秒"未响应"）
- UI：G24 遥测风深色面板（线性 SVG 图标、焦点环、禁用态、窄窗口自适应）；
  DPI 页右侧「设备实时面板」显示型号/回报率/当前档位/电量/板载配置，灯点跟随档位颜色
- 键位文案：下拉显示「左键 / A / DPI 循环」等中文名（协议值仍是原始枚举，`src/shared/keynames.js`）
- 安装包：自定义图标 + NSIS 品牌侧图/顶图 + 可选安装路径（`build/`，`npm run assets` 重建资产）
- 窗口：全自绘（`frame:false` + 透明底），无原生标题栏/菜单栏；CSS 10px 圆角 + 1px 内描边，
  右上角自绘最小化/最大化/关闭（`window:minimize|toggleMaximize|close` IPC）；
  最大化时自动去圆角；`thickFrame:true` 保留边缘缩放与 Aero Snap

## 技术架构

| 目录 | 职责 |
|---|---|
| `src/main/index.js` | 主进程：窗口、菜单、IPC 分发 |
| `src/main/hid.js` | node-hid 封装（worker 枚举 + usagePage 0xFF05 过滤） |
| `src/preload/index.js` | contextBridge 桥接（api + i18n） |
| `src/renderer/` | UI（原生 HTML/CSS/JS，无框架） |
| `src/shared/protocol.js` | 协议层纯函数（22 单元测试） |
| `src/shared/config-format.js` | 官方 .ict/.icm 导入导出纯函数（8 单元测试） |
| `src/shared/i18n.js` | 中英文案字典 |
| `docs/protocol.md` | 逆向协议完整文档 |
| `test/` | 协议层 + 配置格式测试 |

技术栈：Electron 33 + node-hid（N-API）+ 原生前端。

## 协议核心（逆向成果）

- HID Feature Report，**report ID = 9**，每条命令 8 字节 `[命令码, 参数...]`
- 设备：VID `0x093A`（PixArt），配置接口 usagePage `0xFF05` + usage `0x0001`
- DPI 硬件值 = `(实际DPI - 50) / 50`
- 写命令 `0x01~0x08` ↔ 读命令 `0x81~0x88` 对称（另有 0x89 状态 / 0x8E 配对 / 0x8F 型号信息）
- 连接时读 `0x8F` 识别型号（Ghero/G23/G24/G29/G23V2/FM23）、8K 接收器、传感器（241=PAW3950）
- PAW3950 的 LOD 走旋转映射 `[2,0,1]`；非 8K 设备 2000Hz+ 会被硬件钳制为 1000Hz（应用层预钳制）
- 已实测：incott 8K wireless mouse（PID 0x522C，PAW3950）；协议表另经 Caldis G24 有线实机验证（54 条扫描 51 条符合）

## 待办

1. **鼠标本体 RGB 灯效**：官方网页驱动未实现（设备层只有 setReceiverLED），仅老原生驱动
   `CLedSetDlg` 支持 6 种模式（关/霓虹/呼吸/闪烁/流光/氛围）；命令字需 USB 抓包或反汇编原生驱动。
   8K 接收器指示灯（命令 8，三档：回报率/电量/仅低电量）已实现并接入灯效页。
2. ~~**自定义图标**~~ 已完成：`build/make-assets.js` 生成多尺寸 ico + 安装器侧图/顶图，安装包已改自定义 NSIS（可选路径）。
3. **更多型号实机适配**（连接时已能识别型号/传感器/8K，但只实测过 0x522C）
4. **安装包视觉复核**：带品牌侧图的向导只验证了构建参数（`oneClick:false`、图标已应用、位图 define 已注入），
   界面本身还没在实机上截图确认（上次启动安装器时被全屏游戏挡住）。
5. **透明窗口的已知取舍**（已与用户确认接受）：文字退化为灰度抗锯齿、无系统阴影；
   若以后要换回清晰次像素渲染，需放弃圆角（`02181a4` 是可回退的 WCO 版本）。

## 环境关键坑

- **真 node 路径**：`/f/AI Agent/nodejs/node.exe`。PATH 里的 `node` 是天枢的 wrapper（→`tianshu-runtime.exe`），会导致 node-gyp / run_tests 失败。跑命令先 `export PATH="/f/AI Agent/nodejs:$PATH"`。
- **`ELECTRON_RUN_AS_NODE=1` 会污染启动**：某些终端环境自带该变量，直接跑 `electron .` 会报
  `Cannot read properties of undefined (reading 'whenReady')`（require('electron') 退化成路径串）。启动前 `unset ELECTRON_RUN_AS_NODE`。
- **run_tests 工具在本环境 blocked**（tianshu-runtime 问题），改用 `"/f/AI Agent/nodejs/node.exe" --test` 跑测试。
- **打包**：`npm run dist` 前设 `ELECTRON_MIRROR` 和 `ELECTRON_BUILDER_BINARIES_MIRROR` 两个镜像环境变量；`package.json` 里 `npmRebuild:false` 是必须的（node-hid 是 N-API 不需重编译，且机器无 Visual Studio）。
- **打包前先关掉已安装的应用进程**，否则 `Incott Mouse Driver.exe` 被占用会 ERR_ELECTRON_BUILDER_CANNOT_EXECUTE。
- **gh CLI**：`/c/Program Files/GitHub CLI/gh.exe`，账号 HeHaoren 已登录。
- **CDP 调试**：`curl`/`fetch` 打 127.0.0.1 会走沙箱代理失败，需 `--noproxy '*'` 或 `http.get({agent:false})`；
  且 electron 必须用后台任务方式启动（`nohup &` 会随 shell 退出被杀）。**页面 reload 后 `Page.captureScreenshot` 会挂死**，改代码后重启进程而不是 reload。

## 验证状态

- 协议层 + 配置格式 + 键位名映射共 40 测试全绿；UI 各交互（DPI 输入、XY 同步、宏上传、语言切换、连接）均已 CDP 实机验证通过。
- 打包 exe 已实测能启动 + node-hid 正常枚举鼠标。

## 发版流程

```bash
npm run dist                          # 打包（产物在 dist/）
gh release create v0.x.x "dist/Incott Mouse Driver Setup 0.x.x.exe" --title "v0.x.x" --notes "..."
```
