# 项目交接（Handoff）

> 给接手本项目的新会话/新成员快速恢复上下文。最后更新：`06edb78`。

## 一句话

因科特（Incott）鼠标的独立桌面配置工具，基于逆向的 HID 协议，**不依赖官方网页驱动**（incott.net/mouse 已停止支持）和官方桌面软件。

## 线上地址

- 源码：https://github.com/HeHaoren/incott-mouse-app
- 安装包：https://github.com/HeHaoren/incott-mouse-app/releases/tag/v1.0.1

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
- 灯效页：两列卡片（与其他页同一栅格）。左「接收器灯效」——三个模式做成胶囊按钮（官方名称：连接状态和回报率 /
  电池状态 / 仅警告电池），选中后下方给出官方原文说明 + 颜色对照（回报率 7 档色标 125Hz~8000Hz、电量绿→黄→橙→红
  渐变条、低电量闪红灯点），文案与配色全部取自官方离线驱动 msg75~77，不做自定义颜色；
  断开/掉线时按钮整体虚线禁用（`renderLighting` 已挂到两个断开分支）。
  右「鼠标本体指示灯」——只读事实卡（位置 DPI 键处 / 切换档位时短暂亮起 / 由固件决定、无设置项），不可操作
- 安装包：自定义图标 + NSIS 品牌侧图/顶图 + 可选安装路径（`build/`，`npm run assets` 重建资产）
- 自绘安装器（`installer/`，`npm run setup`）：660×436 透明圆角窗口，选项/进度/完成/出错四态，
  装的是 `dist/win-unpacked` 载荷；写 HKCU 卸载项，`UninstallString` 指向主程序 `--uninstall`
  由应用自己清理快捷方式、注册表并调度目录删除；便携自解压 exe 约 126 MB（NSIS 版 84 MB 留作备用）
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
| `installer/` | 自绘安装器（独立 Electron app）：`main.js` 安装逻辑、`ui/` 三态界面、`sync-payload.js` / `collect.js` |
| `build/` | 品牌资产源（`assets-src.html`）与生成脚本（`make-assets.js` → ico/bmp） |
| `docs/protocol.md` | 逆向协议完整文档 |
| `test/` | 协议层 + 配置格式测试 |

技术栈：Electron 33 + node-hid（N-API）+ 原生前端。

### UI 栅格约定（方框对齐）

所有页面共用同一套左右边界，改布局时不要破坏：

- `--page-pad`（默认 26px，`max-width:900px` 时 18px）= 内容区左右内边距；`--scrollbar-w`（10px）= 内容区滚动条宽度，
  `.content` 用 `scrollbar-gutter: stable` 常驻占位，所以内容区右边界 = 窗口右 − `--page-pad` − `--scrollbar-w`。
- **`.bottombar` 的右内边距 = `--page-pad` + `--scrollbar-w`**，这样「应用到鼠标」等按钮的右边缘与上方卡片严格齐平。
  不要给底栏写死 `padding: 0 20px`。
- 页面里所有卡片都必须是 `.tab` 的直接子元素，或放在 `.perf-grid`（两列：等宽 / 等间距 / `align-items: stretch` 等高）里。
  **不要给页面级容器加 `max-width`**——灯效页曾写死 780px，右边缘比其他页短 190px。
- 宏列表 `.macro-items` 不做内部滚动（会因滚动条吃掉 10px 导致行卡比其他方框窄），改由页面整体滚动。
- 回归自查：`verify.js`（离屏加载真实页面，见 `.workbuddy/memory`）逐页断言 min(left)==内容区左、max(right)==内容区右、底栏按钮右边缘齐平，
  1200 / 920 / 880 三种窗宽 + 中英文都要过。

## 协议核心（逆向成果）

- HID Feature Report，**report ID = 9**，每条命令 8 字节 `[命令码, 参数...]`
- 设备：VID `0x093A`（PixArt），配置接口 usagePage `0xFF05` + usage `0x0001`
- DPI 硬件值 = `(实际DPI - 50) / 50`
- 写命令 `0x01~0x08` ↔ 读命令 `0x81~0x88` 对称（另有 0x89 状态 / 0x8E 配对 / 0x8F 型号信息）
- 连接时读 `0x8F` 识别型号（Ghero/G23/G24/G29/G23V2/FM23）、8K 接收器、传感器（241=PAW3950）
- PAW3950 的 LOD 走旋转映射 `[2,0,1]`；非 8K 设备 2000Hz+ 会被硬件钳制为 1000Hz（应用层预钳制）
- 已实测：incott 8K wireless mouse（PID 0x522C，PAW3950）；协议表另经 Caldis G24 有线实机验证（54 条扫描 51 条符合）

## 待办

1. **本体 DPI 键指示灯：已确认不可设置**（2026-11-14）。官方 v1.3.7 驱动能识别 G24 并完整下发配置，
   但全程不发任何灯效命令、UI 也没有「DPI灯效」入口；盲试 `0x0A` 各值均点不亮。该灯行为由固件决定
   （切 DPI/低电量时亮红），工具无法让它常亮。详见 `docs/protocol.md` 3.8b。
   若以后拿到带该功能的新固件/驱动，再用同样的旁路读法抓一次即可。
2. ~~**自定义图标**~~ 已完成：`build/make-assets.js` 生成多尺寸 ico + 安装器侧图/顶图，安装包已改自定义 NSIS（可选路径）。
3. **更多型号实机适配**（连接时已能识别型号/传感器/8K，但只实测过 0x522C）
4. **安装向导视觉复核**：NSIS 版向导已由自绘安装器取代；自绘安装器四态界面已通过 CDP 截图确认，
   但**在真实用户环境下的完整安装（快捷方式 + 注册表 + 卸载）尚未实跑**——开发沙箱把
   `reg.exe` / `powershell.exe` 拉黑，这几步只验证了「失败不阻断」的降级路径。
   首次真实安装后需要检查：桌面/开始菜单快捷方式、设置里的「应用和功能」条目、`--uninstall` 卸载流程。
5. **透明窗口的已知取舍**（已与用户确认接受）：文字退化为灰度抗锯齿、无系统阴影；
   若以后要换回清晰次像素渲染，需放弃圆角（`02181a4` 是可回退的 WCO 版本）。
6. **本地遗留目录**：`dist-setup/`、`dist-setup2/` 是前期构建产物，被环境的删除保护锁住无法清理，
   需手动在资源管理器里删掉（各约 450 MB）。

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
# 1) 改版本号（package.json + installer/package.json + package-lock.json）
npm run dist        # 2) 应用 + NSIS 备用包（dist/Incott-Mouse-Driver-NSIS-<ver>.exe）
npm run setup       # 3) 自绘安装器（dist/Incott-Mouse-Driver-Setup-<ver>.exe，正式分发包）
gh release create v<ver> "dist/Incott-Mouse-Driver-Setup-<ver>.exe" --title "v<ver>" --notes-file <说明文件>
```

`--notes` 里带换行和中文容易被 shell 吃掉，写成文件用 `--notes-file` 更稳。
