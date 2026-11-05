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

1. **LED 灯效**（鼠标本体 RGB，协议还在混淆 JS 里没挖完；8K 接收器灯效命令 8 已支持未实测）
2. **自定义图标**（exe 现在用 Electron 默认图标）
3. **更多型号实机适配**（连接时已能识别型号/传感器/8K，但只实测过 0x522C）

## 环境关键坑

- **真 node 路径**：`/f/AI Agent/nodejs/node.exe`。PATH 里的 `node` 是天枢的 wrapper（→`tianshu-runtime.exe`），会导致 node-gyp / run_tests 失败。跑命令先 `export PATH="/f/AI Agent/nodejs:$PATH"`。
- **run_tests 工具在本环境 blocked**（tianshu-runtime 问题），改用 `"/f/AI Agent/nodejs/node.exe" --test` 跑测试（18 通过）。
- **打包**：`npm run dist` 前设 `ELECTRON_MIRROR` 和 `ELECTRON_BUILDER_BINARIES_MIRROR` 两个镜像环境变量；`package.json` 里 `npmRebuild:false` 是必须的（node-hid 是 N-API 不需重编译，且机器无 Visual Studio）。
- **gh CLI**：`/c/Program Files/GitHub CLI/gh.exe`，账号 HeHaoren 已登录。

## 验证状态

- 协议层 30 测试全绿；UI 各交互（DPI 输入、XY 同步、宏上传、语言切换、连接）均已 CDP 实机验证通过。
- 打包 exe 已实测能启动 + node-hid 正常枚举鼠标。

## 发版流程

```bash
npm run dist                          # 打包（产物在 dist/）
gh release create v0.x.x "dist/Incott Mouse Driver Setup 0.x.x.exe" --title "v0.x.x" --notes "..."
```
